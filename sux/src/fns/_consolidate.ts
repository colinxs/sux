// Memory decay/consolidation — the vault knowledge-graph's staleness pass (master-plan
// Track B, the "one bet" from docs/design/personal-ai-landscape-2026.md). 2026's real shift
// in agent memory is structured cognition that decays and consolidates, not an
// undifferentiated blob that only ever grows. recall already separates vault/mail/files as
// namespaces; the gap this fills is a staleness/duplicate-detection pass over the vault.
//
// V1 SCOPE (deliberately narrow): DETECTION ONLY. Scans notes for a `last_verified`
// frontmatter marker and flags anything missing/older than STALE_DAYS as stale, and flags
// same-topic-looking notes as duplicate CANDIDATES. Nothing is merged, deleted, or even
// frontmatter-patched — the only vault write is a single digest append (same privilege class
// as _weekly_recall), reporting what was found so Colin can act on it by hand. Automated
// merging/re-tagging is explicitly deferred to a later pass once detection quality is proven.
//
// SAFETY (fail-closed): CONSOLIDATE_ENABLED unset ⇒ total no-op (dormant). Read-only against
// every note's content; the vault append is idempotent per ISO week (mirrors weekly_recall's
// once-per-week ledger gate) so the daily cron does real scanning work at most once a week.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { errMsg } from "./_util";
import { extractWikilinks, noteBasename, parseFrontmatter } from "../vault-graph";
import { isoWeek } from "./_weekly_recall";

// A truthy toggle ("0"/"false"/"off"/empty ⇒ off) — mirrors _weekly_recall/_mail_triage's
// flagOn, so an explicit CONSOLIDATE_ENABLED=0 stays off rather than arming on mere presence.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The consolidation sweep may run at all. Unset ⇒ the feature is dormant (no-op). */
export const hasConsolidate = (env: RtEnv): boolean => flagOn(env.CONSOLIDATE_ENABLED);

/** A note with no `last_verified`, or one older than this many days, is flagged stale.
 *  Overridable via CONSOLIDATE_STALE_DAYS; falls back to this default on an invalid value. */
export const DEFAULT_STALE_DAYS = 90;

export function staleDays(env: RtEnv): number {
	const n = Number(env.CONSOLIDATE_STALE_DAYS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_DAYS;
}

/** Bounds the per-cycle scan so a huge vault can't blow the cron's wall-clock budget. */
export const MAX_NOTES_PER_SWEEP = 500;

/** The ledger key holding the rotating sweep cursor (an index into `listNotes`' order) — kept
 *  under the same "consolidate" namespace as the per-week gate, but not itself week-scoped, so
 *  it survives across weeks and keeps advancing. */
const CURSOR_KEY = "sweep-offset";

/** The ledger key holding the most recent successful sweep's findings (bounded), so a
 *  read-only consumer (the agenda loop, W5) can pick them up without re-scanning the vault. */
const LAST_REPORT_KEY = "last-report";

/** Caps how many stale/duplicate entries the cached last-report carries — enough for a
 *  digest line, not a full report (the full lists already live in the vault digest itself). */
const MAX_CACHED_FINDINGS = 20;

/** Takes up to `size` items starting at `offset`, wrapping around the end of `items` — so a
 *  vault bigger than one sweep's cap gets covered in full over several sweeps instead of the
 *  same leading slice forever. Returns the window plus the offset the *next* sweep should
 *  start from. */
function sweepWindow<T>(items: readonly T[], offset: number, size: number): { window: T[]; nextOffset: number } {
	if (items.length === 0) return { window: [], nextOffset: 0 };
	const start = ((offset % items.length) + items.length) % items.length;
	const take = Math.min(size, items.length);
	const window: T[] = [];
	for (let i = 0; i < take; i++) window.push(items[(start + i) % items.length]);
	return { window, nextOffset: (start + take) % items.length };
}

export type ConsolidateDeps = {
	listNotes: (env: RtEnv) => Promise<string[]>;
	readNote: (env: RtEnv, path: string) => Promise<string>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
};

export type StaleNote = { path: string; last_verified?: string; reason: string };
export type DuplicateCandidate = { a: string; b: string; key: string };

export type ConsolidateReport = {
	week?: string;
	dormant?: boolean;
	skipped?: boolean;
	error?: boolean | string;
	scanned?: number;
	truncated?: boolean;
	window_offset?: number;
	next_offset?: number;
	stale?: StaleNote[];
	duplicate_candidates?: DuplicateCandidate[];
	digest_written?: boolean;
	note?: string;
};

/** ISO date `staleDays` days before `now` — same-day boundary as the cutoff (a note verified
 *  exactly on the cutoff date counts as still-fresh, matching `<` not `<=` at the caller). */
export function cutoffIso(days: number, now: Date): string {
	const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return cutoff.toISOString().slice(0, 10);
}

/** A crude but cheap duplicate-candidate key: the note's basename, lowercased, punctuation/
 *  numbering stripped ("Project Alpha (2)" and "project-alpha" collapse to the same key).
 *  False positives are just candidates for a human to glance at, never auto-merged — so this
 *  favors recall over precision. */
function duplicateKey(path: string): string {
	return noteBasename(path)
		.toLowerCase()
		.replace(/\(\d+\)$/, "")
		.replace(/[\s_-]+/g, " ")
		.trim();
}

/** `stale_count`/`duplicate_count` hold the REAL (untruncated) totals from the sweep that
 *  produced this cache entry — `stale`/`duplicate_candidates` themselves are capped to
 *  MAX_CACHED_FINDINGS, so a consumer that needs an accurate count (the agenda digest, #781)
 *  must read the `_count` fields, not `.length`. Optional for back-compat with a cache entry
 *  written before these fields existed; a consumer should fall back to `.length` in that case. */
export type ConsolidateFindings = { week: string; stale: StaleNote[]; duplicate_candidates: DuplicateCandidate[]; stale_count?: number; duplicate_count?: number };

/** The most recent successful sweep's findings (bounded to MAX_CACHED_FINDINGS per bucket),
 *  read from the ledger cache — never re-scans the vault. Returns null if consolidate has
 *  never completed a sweep (dormant, KV unavailable, or a corrupt/missing cache entry). */
export async function lastConsolidateFindings(env: RtEnv): Promise<ConsolidateFindings | null> {
	const raw = await ledger(env, "consolidate").get(LAST_REPORT_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.week !== "string") return null;
		const stale = Array.isArray(parsed.stale) ? parsed.stale : [];
		const duplicate_candidates = Array.isArray(parsed.duplicate_candidates) ? parsed.duplicate_candidates : [];
		return {
			week: parsed.week,
			stale,
			duplicate_candidates,
			stale_count: typeof parsed.stale_count === "number" ? parsed.stale_count : stale.length,
			duplicate_count: typeof parsed.duplicate_count === "number" ? parsed.duplicate_count : duplicate_candidates.length,
		};
	} catch {
		return null;
	}
}

export type ClassifyResult = { stale: StaleNote[]; duplicate_candidates: DuplicateCandidate[]; scanned: number };

/** Pure classification over ALREADY-FETCHED note content (no I/O): flags staleness per
 *  `last_verified` frontmatter and groups same-looking titles into duplicate-candidate pairs.
 *  Shared by runConsolidate's weekly digest sweep and vault_consolidate_plan's on-demand scan
 *  (fns/vault_consolidate_plan.ts) — both already have note content in hand from their own
 *  read pass, so this only ever classifies, never fetches. A path missing from `contents` (a
 *  failed read) is silently skipped, not counted as scanned. */
export function classifyNotes(paths: string[], contents: Map<string, string>, cutoff: string, days: number): ClassifyResult {
	const stale: StaleNote[] = [];
	const keyToPaths = new Map<string, string[]>();
	let scanned = 0;
	for (const path of paths) {
		const content = contents.get(path);
		if (content === undefined) continue;
		scanned++;
		const fm = parseFrontmatter(content);
		const lv = typeof fm?.last_verified === "string" ? fm.last_verified : undefined;
		if (!lv) stale.push({ path, reason: "no last_verified marker" });
		else if (lv < cutoff) stale.push({ path, last_verified: lv, reason: `older than ${days}d` });

		const dk = duplicateKey(path);
		const list = keyToPaths.get(dk) ?? [];
		list.push(path);
		keyToPaths.set(dk, list);
		void extractWikilinks; // reserved for a future duplicate-scoring pass (link overlap) — not used in V1
	}

	const duplicate_candidates: DuplicateCandidate[] = [];
	for (const [dk, group] of keyToPaths) {
		if (group.length < 2) continue;
		for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) duplicate_candidates.push({ a: group[i], b: group[j], key: dk });
	}
	return { stale, duplicate_candidates, scanned };
}

function buildDigest(week: string, staleDaysUsed: number, stale: StaleNote[], dupes: DuplicateCandidate[], scanned: number, truncated: boolean, windowOffset: number, totalNotes: number): string {
	const lines: string[] = [`\n## Consolidation sweep — ${week} (${new Date().toISOString()})`];
	lines.push(`_${scanned} note(s) scanned${truncated ? ` (capped — window started at offset ${windowOffset} of ${totalNotes}, rotates each sweep so the whole vault is eventually covered)` : ""}, staleness threshold ${staleDaysUsed}d. Detection only — nothing was changed._`);
	if (stale.length) {
		lines.push(`\n### Stale (${stale.length}) — no \`last_verified\` or older than ${staleDaysUsed}d`);
		for (const s of stale) lines.push(`- \`${s.path}\`${s.last_verified ? ` — last verified ${s.last_verified}` : " — never verified"}`);
	} else {
		lines.push("\n### Stale — none found");
	}
	if (dupes.length) {
		lines.push(`\n### Possible duplicates (${dupes.length}) — same-looking title, review by hand`);
		for (const d of dupes) lines.push(`- \`${d.a}\` ↔ \`${d.b}\``);
	} else {
		lines.push("\n### Possible duplicates — none found");
	}
	return `${lines.join("\n")}\n`;
}

/** Run one consolidation cycle. Fail-closed: a dormant no-op unless CONSOLIDATE_ENABLED.
 *  Idempotent per ISO week (mirrors _weekly_recall's ledger) — the daily cron re-fires this
 *  every day, but the real scan+append runs at most once per week, `opts.force` bypasses the
 *  gate for an on-demand call. The ledger is marked only after a successful append, so a
 *  failed write leaves the week unmarked and the next tick retries. Same fail-closed guard
 *  applies if every note read fails (expired token, GitHub outage): that's reported as an
 *  error, not a false "0 stale, 0 dupes" digest, and the week stays unmarked. */
export async function runConsolidate(env: RtEnv, opts: { week?: string; force?: boolean }, deps: ConsolidateDeps): Promise<ConsolidateReport> {
	if (!hasConsolidate(env)) {
		return { dormant: true, note: "consolidate is disabled — set CONSOLIDATE_ENABLED to scan the vault for stale (unverified) and likely-duplicate notes, and append a report to the vault. Detection only: nothing is merged, deleted, or patched. Fail-closed: nothing runs until the flag is set." };
	}
	const week = String(opts.week ?? isoWeek(env.VAULT_TZ));
	const led = ledger(env, "consolidate");
	const key = `week::${week}`;
	if (!opts.force && (await led.seen(key))) return { week, skipped: true, note: "already ran this ISO week" };

	const days = staleDays(env);
	const cutoff = cutoffIso(days, new Date());

	let paths: string[];
	try {
		paths = await deps.listNotes(env);
	} catch (e) {
		const msg = `vault list failed: ${errMsg(e)}`;
		return { week, error: msg, note: msg };
	}
	const truncated = paths.length > MAX_NOTES_PER_SWEEP;
	const storedOffset = Number(await led.get(CURSOR_KEY));
	const windowOffset = Number.isFinite(storedOffset) && storedOffset >= 0 ? storedOffset : 0;
	const { window: scanPaths, nextOffset } = sweepWindow(paths, windowOffset, MAX_NOTES_PER_SWEEP);

	const contents = new Map<string, string>();
	for (const path of scanPaths) {
		try {
			contents.set(path, await deps.readNote(env, path));
		} catch {
			continue; // one unreadable note must not sink the whole sweep
		}
	}
	const { stale, duplicate_candidates, scanned } = classifyNotes(scanPaths, contents, cutoff, days);

	// Every read failing (vs. an empty vault) means the sweep saw nothing real — report it as a
	// failure rather than a false "0 stale, 0 dupes" digest, and leave the week unmarked so the
	// next tick retries instead of waiting a full week.
	if (scanPaths.length > 0 && scanned === 0) {
		return { week, scanned, truncated, window_offset: windowOffset, error: true, note: `all ${scanPaths.length} note read(s) failed — nothing scanned, skipping digest and ledger mark` };
	}

	try {
		await deps.digestAppend(env, `Consolidation/${week}.md`, buildDigest(week, days, stale, duplicate_candidates, scanned, truncated, windowOffset, paths.length));
		await led.mark(key);
		await led.mark(CURSOR_KEY, String(nextOffset));
		await led.mark(
			LAST_REPORT_KEY,
			JSON.stringify({
				week,
				stale: stale.slice(0, MAX_CACHED_FINDINGS),
				duplicate_candidates: duplicate_candidates.slice(0, MAX_CACHED_FINDINGS),
				stale_count: stale.length,
				duplicate_count: duplicate_candidates.length,
			}),
		);
		return { week, scanned, truncated, window_offset: windowOffset, next_offset: nextOffset, stale, duplicate_candidates, digest_written: true };
	} catch (e) {
		const msg = `vault append failed: ${errMsg(e)}`;
		return { week, scanned, truncated, window_offset: windowOffset, stale, duplicate_candidates, digest_written: false, error: msg, note: msg };
	}
}

/** The real deps: vault list/read/append via the obsidian fn (git-backed). Dynamically
 *  imported by the caller to keep the cron path from pulling in the vault surface when the
 *  feature is dormant, mirroring _weekly_recall.defaultDeps. Tests inject fakes instead. */
export async function defaultDeps(): Promise<ConsolidateDeps> {
	const { obsidian } = await import("./obsidian");
	return {
		listNotes: async (env) => {
			const r = await obsidian.run(env, { action: "list", backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault list failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return Array.isArray(parsed?.notes) ? parsed.notes.map(String) : [];
		},
		readNote: async (env, path) => {
			const r = await obsidian.run(env, { action: "read", path, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault read failed");
			return String(r.content?.[0]?.text ?? "");
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
	};
}
