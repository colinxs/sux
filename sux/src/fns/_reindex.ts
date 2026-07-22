import type { RtEnv } from "../registry";
import { contactSemanticIndex } from "./_contact_semantic";
import { filesSemanticIndex } from "./_files_semantic";
import { mailSemanticIndex } from "./_mail_semantic";
import { listChunks, listDomains } from "./_source";
import { errMsg } from "./_util";
import { CORPUS_INDEX, type CorpusUnit, hasVectorize, upsertCorpus, upsertSourceChunks } from "./_vectorize";
import { vaultSemanticIndex } from "./_vault_semantic";
import { vaultCfg } from "./obsidian";

// _reindex — the backfill/repopulate path for the unified Vectorize index (#1290). The index
// starts EMPTY; until it's populated it answers nothing, so this is REQUIRED, not optional.
// It reads the existing corpus — the KV cosine cores (vault/mail/files/contacts) and the
// `_source` chunk store (oracle/assim/phi/advise) — and upserts every chunk into `sux-corpus`
// under its per-domain namespace, REUSING each chunk's already-stored embedding (no re-embed
// on the source-chunk domains; vault/mail/files/contacts rebuild their KV index once here,
// which also warms the fallback caches as a bonus).
//
// IDEMPOTENT + RESUMABLE: stable vector ids (_vectorize.vectorId) mean re-running upserts in
// place, never duplicates — so a run that dies partway is safe to re-run, and a caller can
// target ONE domain at a time (the `domains` filter) if a full pass exceeds the request
// budget. Each domain runs independently and its failure is captured, never fatal to the rest
// — a partial backfill is a valid, resumable state.
//
// This is off the query path entirely (run via `oracle {action:"reindex"}` post-deploy, or a
// future scheduled tick); a full vault/mail/files rebuild + embed is expected to be expensive
// and is exactly why it must never run on `ask`.

/** The natural-source domains backed by a KV cosine core (their own build path embeds; we
 *  reuse those embeddings) plus `source` — the umbrella over every `_source` chunk domain
 *  (oracle/assim/phi/advise), swept in one listDomains pass. */
export type ReindexDomain = "vault" | "mail" | "files" | "contacts" | "source";
export const REINDEX_DOMAINS: ReindexDomain[] = ["vault", "mail", "files", "contacts", "source"];

export type ReindexDomainResult = { indexed: number; note?: string; error?: string };
export type ReindexReport = { index: string; domains: Record<string, ReindexDomainResult>; total: number };

/** Group an array by a key, preserving order — used to number a source's chunks per-source
 *  (vault/files emit many chunks per path) so `sub` is a stable within-source index. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const it of items) (m.get(key(it)) ?? m.set(key(it), []).get(key(it))!).push(it);
	return m;
}

async function reindexVault(env: RtEnv): Promise<ReindexDomainResult> {
	const cfg = vaultCfg(env);
	if ("error" in cfg) return { indexed: 0, note: "vault not configured" };
	const idx = await vaultSemanticIndex(env, cfg);
	if (!idx) return { indexed: 0, note: "vault index unavailable (no KV or HEAD unresolved)" };
	const units: CorpusUnit[] = [];
	for (const [path, chunks] of groupBy(idx.chunks, (c) => c.path)) {
		chunks.forEach((c, sub) => units.push({ sourceKey: path, sub, pointer: `vault:${path}`, text: c.text, embedding: c.embedding }));
	}
	return { indexed: await upsertCorpus(env, "vault", units) };
}

async function reindexMail(env: RtEnv): Promise<ReindexDomainResult> {
	if (!(env as { FASTMAIL_TOKEN?: string }).FASTMAIL_TOKEN) return { indexed: 0, note: "mail not configured" };
	const idx = await mailSemanticIndex(env);
	if (!idx) return { indexed: 0, note: "mail index unavailable" };
	// The passage text mirrors _answer.ts's fromMailIndex so a Vectorize-served mail citation
	// reads identically to a cosine-served one (header + preview; the pointer is the JMAP id).
	const units: CorpusUnit[] = idx.chunks.map((c) => ({
		sourceKey: c.id,
		sub: 0,
		pointer: `mail:${c.id}`,
		text: `${c.subject || "(no subject)"} — from ${c.from}${c.receivedAt ? ` on ${c.receivedAt}` : ""}\n${c.text}`,
		embedding: c.embedding,
	}));
	return { indexed: await upsertCorpus(env, "mail", units) };
}

async function reindexFiles(env: RtEnv): Promise<ReindexDomainResult> {
	const idx = await filesSemanticIndex(env);
	if (!idx) return { indexed: 0, note: "files not configured" };
	const units: CorpusUnit[] = [];
	for (const [path, chunks] of groupBy(idx.chunks, (c) => c.path)) {
		chunks.forEach((c, sub) => units.push({ sourceKey: path, sub, pointer: `files:${path}`, text: c.text, embedding: c.embedding }));
	}
	return { indexed: await upsertCorpus(env, "files", units) };
}

async function reindexContacts(env: RtEnv): Promise<ReindexDomainResult> {
	const idx = await contactSemanticIndex(env);
	if (!idx) return { indexed: 0, note: "contacts not configured" };
	// Mirrors _answer.ts's fromContactsIndex passage text.
	const units: CorpusUnit[] = idx.chunks.map((c) => ({
		sourceKey: c.id,
		sub: 0,
		pointer: `contact:${c.id}`,
		text: `${c.name}${c.company ? ` · ${c.company}` : ""}${c.emails.length ? ` · ${c.emails.join(", ")}` : ""}${c.phones.length ? ` · ${c.phones.join(", ")}` : ""}`,
		embedding: c.embedding,
	}));
	return { indexed: await upsertCorpus(env, "contacts", units) };
}

/** Sweep every `_source` chunk domain (oracle/assim/phi/advise) in one listDomains pass and
 *  upsert via the SAME id scheme the write-path tap uses — so a live-written chunk and its
 *  backfilled copy collapse to one vector. Reuses stored embeddings; never re-embeds. */
async function reindexSourceChunks(env: RtEnv): Promise<ReindexDomainResult> {
	const domains = await listDomains(env);
	let indexed = 0;
	for (const d of domains) indexed += await upsertSourceChunks(env, await listChunks(env, d));
	return { indexed, note: `${domains.length} source domain(s)` };
}

const RUNNERS: Record<ReindexDomain, (env: RtEnv) => Promise<ReindexDomainResult>> = {
	vault: reindexVault,
	mail: reindexMail,
	files: reindexFiles,
	contacts: reindexContacts,
	source: reindexSourceChunks,
};

/** Populate `sux-corpus` from the existing corpus. Runs each requested domain independently,
 *  capturing (never throwing) per-domain errors so a partial backfill is a valid resumable
 *  state. Throws only when the Vectorize binding is absent (nothing to populate). */
export async function reindexCorpus(env: RtEnv, opts: { domains?: ReindexDomain[] } = {}): Promise<ReindexReport> {
	if (!hasVectorize(env)) throw new Error(`Vectorize binding not bound — cannot reindex ${CORPUS_INDEX}.`);
	const which = opts.domains?.length ? opts.domains.filter((d): d is ReindexDomain => (REINDEX_DOMAINS as string[]).includes(d)) : REINDEX_DOMAINS;
	const domains: Record<string, ReindexDomainResult> = {};
	let total = 0;
	for (const d of which) {
		try {
			const r = await RUNNERS[d](env);
			domains[d] = r;
			total += r.indexed;
		} catch (e) {
			domains[d] = { indexed: 0, error: errMsg(e) };
			console.log(`reindex: domain=${d} failed: ${errMsg(e)}`);
		}
	}
	console.log(`reindex: ${CORPUS_INDEX} total=${total} domains=${which.map((d) => `${d}:${domains[d]?.indexed ?? 0}`).join(",")}`);
	return { index: CORPUS_INDEX, domains, total };
}

// --- automatic batched backfill (#1315) -------------------------------------
//
// A sync `oracle {action:"reindex"}` over the WHOLE corpus (or even one heavy domain) can
// exceed a single Worker request's lifetime — reindexVault/reindexMail/etc. each rebuild a
// domain's full KV cosine core and upsert ALL of it in one call. `domains` already lets a
// caller scope one manual call to one domain, but that still relies on an operator
// remembering to run it repeatedly. This adds the unattended half: a cron tick that runs
// EXACTLY one domain (the existing per-domain granularity IS the batching) and rotates a
// persisted KV cursor across REINDEX_DOMAINS, so the full corpus backfills over multiple
// ticks instead of one oversized request. The manual `oracle reindex` action above is
// untouched — a separate, still-useful operator escape hatch to force one domain NOW.

/** Fail-closed master switch — mirrors _assimilate.ts's flagOn: an explicit "0"/"false"/"off"
 *  stays off rather than arming on mere presence. A SEPARATE decision from hasVectorize (is
 *  the binding present) — an operator must explicitly arm the unattended cron write into
 *  Vectorize, same reasoning as every other `_ENABLED` cron flag in this repo. Read via a
 *  local structural cast (mirrors reindexMail's FASTMAIL_TOKEN cast above) rather than adding
 *  to RtEnv, since this flag has exactly one reader. */
const flagOn = (v: string | undefined): boolean => {
	const s = (v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off";
};
export const hasVectorizeBackfill = (env: RtEnv): boolean => flagOn((env as { VECTORIZE_BACKFILL_ENABLED?: string }).VECTORIZE_BACKFILL_ENABLED);

/** The rotation cursor: a plain string (one of REINDEX_DOMAINS), not a numeric index, so a raw
 *  `wrangler kv key get` reads it directly without decoding. */
const REINDEX_CURSOR_KEY = "sux:reindex:cursor";

function isReindexDomain(v: unknown): v is ReindexDomain {
	return typeof v === "string" && (REINDEX_DOMAINS as string[]).includes(v);
}

/** Pure: the domain that follows `completed` in the fixed REINDEX_DOMAINS rotation, wrapping
 *  back to the first after the last — kept KV-free so the wrap-around is directly testable. */
export function rotateReindexDomain(completed: ReindexDomain): ReindexDomain {
	const i = REINDEX_DOMAINS.indexOf(completed);
	return REINDEX_DOMAINS[(i + 1) % REINDEX_DOMAINS.length];
}

/** Read the rotation cursor. Defaults to the FIRST domain when unset or holding a stale/
 *  invalid value (e.g. a domain retired from REINDEX_DOMAINS since it was written) — a
 *  corrupt cursor should restart the lap, never wedge the rotation. */
export async function nextReindexDomain(env: RtEnv): Promise<ReindexDomain> {
	const raw = await env.OAUTH_KV?.get(REINDEX_CURSOR_KEY);
	return isReindexDomain(raw) ? raw : REINDEX_DOMAINS[0];
}

/** Advance the cursor past `completed` to the next domain in rotation. */
export async function advanceReindexCursor(env: RtEnv, completed: ReindexDomain): Promise<void> {
	await env.OAUTH_KV?.put(REINDEX_CURSOR_KEY, rotateReindexDomain(completed));
}

/** One cron tick of the automatic backfill: reindex exactly the cursor's current domain, then
 *  advance the cursor. Fail-closed — a dormant no-op unless VECTORIZE_BACKFILL_ENABLED is
 *  armed. STEADY STATE IS FREE: upsertCorpus's stable ids make a repeat pass over an
 *  already-caught-up domain a same-count no-op upsert, so once the first full lap finishes,
 *  rotating forever after costs only that one domain's read + re-upsert per tick — no separate
 *  "done backfilling" state to track or gate on. */
export async function reindexCorpusTick(env: RtEnv): Promise<(ReindexReport & { domain: ReindexDomain; next: ReindexDomain }) | { dormant: true }> {
	if (!hasVectorizeBackfill(env)) return { dormant: true };
	const domain = await nextReindexDomain(env);
	const report = await reindexCorpus(env, { domains: [domain] });
	await advanceReindexCursor(env, domain);
	const next = rotateReindexDomain(domain);
	console.log(`reindex tick: domain=${domain} indexed=${report.total} next=${next}`);
	return { ...report, domain, next };
}
