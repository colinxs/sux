import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { cosine } from "./_embed";
import { errMsg } from "./_util";
import { isoWeek } from "./_weekly_recall";
import { sweepWindow } from "./_consolidate";
import type { SemanticChunk } from "./_vault_semantic";
import type { MailSemanticChunk } from "./_mail_semantic";
import type { FilesSemanticChunk } from "./_files_semantic";
import type { ContactSemanticChunk } from "./_contact_semantic";

// _cross_semantic — the standing cross-domain half of #785: vault_semantic/mail_semantic/
// files_semantic (_vault_semantic.ts/_mail_semantic.ts/_files_semantic.ts) each already embed
// their own domain, but nothing runs the three indices AGAINST EACH OTHER to find durable
// relationships (a vault note whose nearest neighbors are specific emails and a Dropbox file).
// This module is the PURE detector half — cosine-rank the vault's chunks against a pooled
// mail+files target set, threshold, cap. No caps/env needed (mirrors _consolidate.ts's
// classifyNotes: the pure classification stays a plain function, testable with fixed vectors,
// with the actual index fetches left to the calling fn). The action half (registry.ts's
// `cross-semantic-plan` op + caps.ts's `related-links` sink) proposes these as an APPEND-ONLY
// "Related" block on the vault note — never a mail/file mutation, never a vault delete — mirroring
// vault-consolidate-plan's reversible-only bar.

// SAFETY (fail-closed): CROSS_SEMANTIC_ENABLED unset ⇒ vault_cross_link_plan refuses to run.
// Read-only detection composes existing semantic indices; the only write (an append-only
// "Related" block) happens after a human "add these related links?" approval, same as
// vault-consolidate-plan — but this still gates behind an explicit flag, since a new, noisier
// (cross-domain) class of vault write shouldn't arm itself just because AI + a vault happen to
// be configured. flagOn treats "0"/"false"/"off" as OFF explicitly, so an explicit
// CROSS_SEMANTIC_ENABLED=0 stays off rather than arming on mere presence (mirrors
// _consolidate.ts's flagOn).
const flagOn = (v: string | undefined): boolean => {
	const s = (v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off";
};
export const hasCrossSemantic = (env: RtEnv): boolean => flagOn((env as { CROSS_SEMANTIC_ENABLED?: string }).CROSS_SEMANTIC_ENABLED);

// Cross-domain similarity is noisier than same-domain kNN (email previews, vault prose, and
// file text have different length/style distributions — the issue's own "honest caveat"), so
// the bar sits well above topKByCosine's k=8-and-take-whatever-ranks-highest same-domain
// default: a candidate must actually be a close match, not just the closest of a mediocre lot.
const MIN_SCORE = 0.75;
// Per-note and total caps bound both the "Related" block's size (a wall of low-signal links
// helps nobody) and the human-approval batch's size, mirroring vault-consolidate-plan's
// maxClusters bound.
const MAX_PER_NOTE = 3;
const MAX_TOTAL = 50;

// Cost is O(vaultChunks × targets) cosine calls with no cap of its own — each domain's OWN
// index already self-caps (vault 5000/mail 1000/files 3000/contacts 2000), so a full-size vault
// can still drive ~5000×6000=30M cosine calls in one invocation, worst case. That was tolerable when this
// only ran on an explicit human-triggered vault_cross_link_plan call; #948's unattended weekly
// cron sweep has no human watching, and a mid-computation CPU-time kill isn't a catchable JS
// exception, so the sweep's ledger key never gets marked and it silently retries the same
// failure forever. Bound the pair count before the double loop runs, by capping how many vault
// chunks get scanned against a given target-set size (~2M pairs ≈ 1.5s of cosine calls on 768-dim
// vectors — well under a Worker's CPU budget) rather than capping targets, since targets is
// already the smaller, self-capped pooled set.
const MAX_PAIRS = 2_000_000;

export type CrossDomainItem = { domain: "mail" | "files" | "contacts"; key: string; label: string; embedding: number[] };
export type CrossLink = { vaultPath: string; domain: "mail" | "files" | "contacts"; key: string; label: string; score: number };

/** Pool mail_semantic's chunks into the domain-tagged shape crossDomainLinks ranks against —
 *  `key` is the message id (a durable JMAP identity), `label` the subject (what a human reads
 *  in the proposed "Related" block). Chunks that never embedded (a transient batch hiccup, same
 *  gap topKMailByCosine already filters) are skipped. */
export function mailToCrossItems(chunks: MailSemanticChunk[]): CrossDomainItem[] {
	return chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).map((c) => ({ domain: "mail" as const, key: c.id, label: c.subject, embedding: c.embedding }));
}

/** Pool files_semantic's chunks the same way — `key`/`label` are both the Dropbox path (files
 *  have no separate title the way a vault note or an email subject does). */
export function filesToCrossItems(chunks: FilesSemanticChunk[]): CrossDomainItem[] {
	return chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).map((c) => ({ domain: "files" as const, key: c.path, label: c.path, embedding: c.embedding }));
}

/** Pool contact_semantic's chunks the same way — `key` is the ContactCard id (a durable JMAP
 *  identity), `label` the contact's name (what a human reads in the proposed "Related" block). */
export function contactsToCrossItems(chunks: ContactSemanticChunk[]): CrossDomainItem[] {
	return chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).map((c) => ({ domain: "contacts" as const, key: c.id, label: c.name, embedding: c.embedding }));
}

/** For each vault note (aggregated across its chunks), find the best-scoring mail/files items
 *  above `minScore`, at most `maxPerNote` per note, ranked and capped at `maxTotal` pairs overall
 *  — the standing "propose" half of #785's cross-domain backlink detector. A note can match the
 *  SAME target through more than one of its own chunks; only the target's best-scoring chunk
 *  match survives per note (a duplicate {domain,key} pair would just double-list the same email/
 *  file in the note's "Related" block for no added signal). */
export function crossDomainLinks(vaultChunks: SemanticChunk[], targets: CrossDomainItem[], opts?: { minScore?: number; maxPerNote?: number; maxTotal?: number }): CrossLink[] {
	const minScore = opts?.minScore ?? MIN_SCORE;
	const maxPerNote = opts?.maxPerNote ?? MAX_PER_NOTE;
	const maxTotal = opts?.maxTotal ?? MAX_TOTAL;
	if (!targets.length) return [];
	const chunkCap = Math.max(1, Math.floor(MAX_PAIRS / targets.length));
	const scanChunks = vaultChunks.length > chunkCap ? vaultChunks.slice(0, chunkCap) : vaultChunks;
	const bestByNote = new Map<string, Map<string, CrossLink>>();
	for (const vc of scanChunks) {
		if (!Array.isArray(vc.embedding) || !vc.embedding.length) continue;
		let best = bestByNote.get(vc.path);
		for (const t of targets) {
			const score = cosine(vc.embedding, t.embedding);
			if (score < minScore) continue;
			if (!best) {
				best = new Map<string, CrossLink>();
				bestByNote.set(vc.path, best);
			}
			const targetKey = `${t.domain}:${t.key}`;
			const cur = best.get(targetKey);
			if (!cur || score > cur.score) best.set(targetKey, { vaultPath: vc.path, domain: t.domain, key: t.key, label: t.label, score });
		}
	}
	const out: CrossLink[] = [];
	for (const best of bestByNote.values()) {
		out.push(
			...[...best.values()]
				.sort((a, b) => b.score - a.score)
				.slice(0, maxPerNote),
		);
	}
	return out.sort((a, b) => b.score - a.score).slice(0, maxTotal);
}

// ── Cron sweep (#948) — the standing half of vault_cross_link_plan's detection, so a ready
// batch of candidates surfaces in _agenda.ts's daily digest instead of requiring a manual
// call. Mirrors _consolidate.ts's weekly-cadence shape: the daily cron re-fires this every
// day, but the real rank runs at most once an ISO week, caching the result for the agenda
// loop to read. DETECTION ONLY — applying a match still needs a manual vault_cross_link_plan
// call (the durable, human-approved "Related" block append); this sweep never starts that run
// itself, so a daily tick can't pile up unanswered approval gates.

/** The ledger key holding the most recent sweep's findings (bounded), so a read-only
 *  consumer (the agenda loop) can pick them up without re-ranking the indices. */
const LAST_REPORT_KEY = "last-report";

/** The ledger key holding the rotating vaultChunks scan cursor — mirrors _consolidate.ts's
 *  CURSOR_KEY. crossDomainLinks' own MAX_PAIRS cap otherwise always scans the SAME leading
 *  vaultChunks slice on every sweep (#968): a vault big enough to trip the cap would
 *  permanently skip the same tail of notes instead of getting covered over successive runs. */
const CURSOR_KEY = "sweep-offset";

/** Caps how many link candidates the cached last-report carries — enough for a digest
 *  line, not the full batch (mirrors _consolidate's MAX_CACHED_FINDINGS). */
const MAX_CACHED_LINKS = 20;

/** `count` holds the REAL (untruncated) total from the sweep that produced this cache
 *  entry — `links` itself is capped to MAX_CACHED_LINKS, so a consumer needing an accurate
 *  count (the agenda digest) must read `count`, not `links.length`. */
export type CrossSemanticFindings = { week: string; links: CrossLink[]; count: number };

/** The most recent sweep's findings (bounded to MAX_CACHED_LINKS), read from the ledger
 *  cache — never re-ranks the indices. Returns null if the sweep has never completed a
 *  cycle (dormant, KV unavailable, or a corrupt/missing cache entry). */
export async function lastCrossSemanticFindings(env: RtEnv): Promise<CrossSemanticFindings | null> {
	const raw = await ledger(env, "cross_semantic").get(LAST_REPORT_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.week !== "string") return null;
		const links = Array.isArray(parsed.links) ? parsed.links : [];
		return { week: parsed.week, links, count: typeof parsed.count === "number" ? parsed.count : links.length };
	} catch {
		return null;
	}
}

export type CrossSemanticSweepDeps = {
	vaultChunks: (env: RtEnv) => Promise<SemanticChunk[] | null>;
	mailChunks: (env: RtEnv) => Promise<MailSemanticChunk[]>;
	filesChunks: (env: RtEnv) => Promise<FilesSemanticChunk[]>;
	contactsChunks: (env: RtEnv) => Promise<ContactSemanticChunk[]>;
};

export type CrossSemanticSweepReport = {
	week?: string;
	dormant?: boolean;
	skipped?: boolean;
	error?: string;
	links?: CrossLink[];
	count?: number;
	truncated?: boolean;
	window_offset?: number;
	next_offset?: number;
	note?: string;
};

/** Run one cross-domain-link detection cycle. Fail-closed: a dormant no-op unless
 *  CROSS_SEMANTIC_ENABLED. Idempotent per ISO week (mirrors _consolidate.ts's
 *  runConsolidate) — `opts.force` bypasses the gate for an on-demand call. The ledger is
 *  marked only after a successful rank, so a failed vault-index fetch leaves the week
 *  unmarked and the next tick retries. A missing mail/files index just means fewer targets
 *  to rank against (mirrors vault_cross_link_plan.ts: each leg is optional, not fatal). */
export async function runCrossSemanticSweep(env: RtEnv, opts: { week?: string; force?: boolean }, deps: CrossSemanticSweepDeps): Promise<CrossSemanticSweepReport> {
	if (!hasCrossSemantic(env)) {
		return { dormant: true, note: "cross_semantic sweep is disabled — set CROSS_SEMANTIC_ENABLED to have the daily cron rank the vault's semantic index against mail+files and surface cross-domain link candidates through the agenda digest. Fail-closed: nothing runs until the flag is set." };
	}
	const week = String(opts.week ?? isoWeek(env.VAULT_TZ));
	const led = ledger(env, "cross_semantic");
	const key = `week::${week}`;
	if (!opts.force && (await led.seen(key))) return { week, skipped: true, note: "already ran this ISO week" };

	let vaultChunks: SemanticChunk[] | null;
	try {
		vaultChunks = await deps.vaultChunks(env);
	} catch (e) {
		const msg = `vault semantic index failed: ${errMsg(e)}`;
		return { week, error: msg, note: msg };
	}
	if (!vaultChunks) return { week, skipped: true, note: "vault semantic index not configured (needs Workers-AI + a configured vault) — nothing to rank" };

	const [mailChunks, filesChunks, contactsChunks] = await Promise.all([deps.mailChunks(env).catch(() => []), deps.filesChunks(env).catch(() => []), deps.contactsChunks(env).catch(() => [])]);
	const targets: CrossDomainItem[] = [...mailToCrossItems(mailChunks), ...filesToCrossItems(filesChunks), ...contactsToCrossItems(contactsChunks)];

	// Rotate which vaultChunks slice gets scanned each sweep, same shape as
	// _consolidate.ts's sweepWindow cursor — otherwise crossDomainLinks' own MAX_PAIRS cap
	// would scan the same leading slice forever (#968). The window is sized to exactly the
	// cap crossDomainLinks would apply anyway, so pre-slicing here makes its internal cap a
	// no-op rather than double-truncating.
	const chunkCap = targets.length ? Math.max(1, Math.floor(MAX_PAIRS / targets.length)) : vaultChunks.length;
	const truncated = vaultChunks.length > chunkCap;
	const storedOffset = Number(await led.get(CURSOR_KEY));
	const windowOffset = Number.isFinite(storedOffset) && storedOffset >= 0 ? storedOffset : 0;
	const { window: scanChunks, nextOffset } = sweepWindow(vaultChunks, windowOffset, chunkCap);
	const links = targets.length ? crossDomainLinks(scanChunks, targets) : [];

	await led.mark(key);
	await led.mark(CURSOR_KEY, String(nextOffset));
	await led.mark(LAST_REPORT_KEY, JSON.stringify({ week, links: links.slice(0, MAX_CACHED_LINKS), count: links.length }));

	return { week, links, count: links.length, truncated, window_offset: windowOffset, next_offset: nextOffset };
}

/** The real deps: the vault/mail/files semantic indices (each already incrementally
 *  cached — see _vault_semantic.ts/_mail_semantic.ts/_files_semantic.ts), pooled into plain
 *  chunk arrays. Dynamically imported by the caller to keep the cron path from pulling in
 *  the semantic-index surface when the feature is dormant, mirroring _consolidate.ts's
 *  defaultDeps. Tests inject fakes instead. */
export async function defaultDeps(): Promise<CrossSemanticSweepDeps> {
	const { vaultCfg } = await import("./obsidian");
	const { vaultSemanticIndex } = await import("./_vault_semantic");
	const { mailSemanticIndex } = await import("./_mail_semantic");
	const { filesSemanticIndex } = await import("./_files_semantic");
	const { contactSemanticIndex } = await import("./_contact_semantic");
	return {
		vaultChunks: async (env) => {
			const cfg = vaultCfg(env);
			if ("error" in cfg) return null;
			const idx = await vaultSemanticIndex(env, cfg);
			return idx ? idx.chunks : null;
		},
		mailChunks: async (env) => {
			const idx = await mailSemanticIndex(env);
			return idx ? idx.chunks : [];
		},
		filesChunks: async (env) => {
			const idx = await filesSemanticIndex(env);
			return idx ? idx.chunks : [];
		},
		contactsChunks: async (env) => {
			const idx = await contactSemanticIndex(env);
			return idx ? idx.chunks : [];
		},
	};
}
