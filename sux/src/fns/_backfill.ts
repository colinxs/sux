import type { RtEnv } from "../registry";
import { type EnumerateResult, enumerateDomain, REINDEX_DOMAINS, type ReindexDomain } from "./_reindex";
import { errMsg } from "./_util";
import { CORPUS_INDEX, hasVectorize, upsertIndexUnits } from "./_vectorize";

// _backfill — the DURABLE, BATCHED, RESUMABLE job that drives `sux-corpus` to full population
// (#1315). A synchronous one-shot pass (embed/upsert a whole domain in one request) TIMES OUT
// on the real corpus, so `vectorCount` sat at ~2 and vault/mail/files retrieval was served by
// the cosine fallback instead of Vectorize (that one-shot path, `reindexCorpus`, had zero
// production callers by the time #1363 removed it — `backfillTick` below is the sole driver).
// This does BOUNDED work per invocation and resumes from a persisted cursor until every domain
// is indexed.
//
// DURABILITY MECHANISM: a CRON that advances a per-domain KV cursor each tick — NOT a Cloudflare
// Workflow. The op-engine Workflow runtime (`op-engine/durable.ts`) interprets a STATIC-SHAPE
// `Op` tree with replay-memoized steps; a cursor-driven "upsert the next window, advance, repeat
// until done" loop isn't that shape, and modeling it as one would add a whole registry plan +
// caps wiring for no gain. The cron path already hosts a dozen resumable sub-jobs
// (`index.ts` scheduled()), each dormant-by-default behind an env flag, dynamically imported,
// self-bounding its budget — the backfill is exactly that pattern with the least new surface.
// Rides the FREQUENT (~5min) cron so it converges in hours, then no-ops cheaply once every
// domain's cursor is `done`.
//
// PER-TICK BOUND: each domain is advanced one bounded WINDOW at a time (`BATCH` units upserted),
// persisting the cursor after EVERY window, and a tick keeps advancing windows only until a soft
// wall-clock budget (`BUDGET_MS`) — so a tick converges fast but never runs unbounded, and a
// crash/eviction mid-tick resumes from the last persisted cursor.
//
// IDEMPOTENT: enumeration + upsert reuse the stable f(domain,sourceKey,sub) vector ids, so a
// re-run (or a window re-processed after a mid-tick eviction) upserts in place, never duplicates.
// FAIL-OPEN: an unreadable domain (cold cache / unavailable index) leaves its cursor and retries
// next tick — it's never marked done on a not-ready read, and never sinks the other domains.

export type BackfillDomain = ReindexDomain;
export const BACKFILL_DOMAINS: BackfillDomain[] = REINDEX_DOMAINS;

// flagOn treats "0"/"false"/"off" as OFF explicitly (mirrors _cross_semantic.ts/_consolidate.ts),
// so an explicit VECTORIZE_BACKFILL_ENABLED=0 stays off rather than arming on mere presence.
const flagOn = (v: string | undefined): boolean => {
	const s = (v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off";
};

/** Whether the durable backfill cron sub-job is armed. Fail-closed: dormant unless
 *  VECTORIZE_BACKFILL_ENABLED is truthy AND the Vectorize binding is bound (nothing to fill
 *  without it). The manual `oracle {action:"reindex"}` path is NOT gated by this flag — this
 *  only governs the unattended cron tick. */
export const hasBackfill = (env: RtEnv): boolean => flagOn((env as { VECTORIZE_BACKFILL_ENABLED?: string }).VECTORIZE_BACKFILL_ENABLED) && hasVectorize(env);

const CURSOR_PREFIX = "sux:corpus:backfill:";
const cursorKey = (d: BackfillDomain): string => `${CURSOR_PREFIX}${d}`;

/** Vectors upserted per window — a tick's Vectorize work is capped at this regardless of corpus
 *  size (the bound the synchronous reindex lacked). Under Vectorize's own 1000/upsert ceiling. */
const BATCH = 200;
/** Soft wall-clock ceiling for one tick: keep advancing windows (each persisting the cursor)
 *  until elapsed exceeds this, then stop and resume next tick. scheduled() bypasses
 *  FN_DEADLINE_MS, so this is the only bound — kept well under a request's real lifetime. */
const BUDGET_MS = 20_000;

/** Per-domain resume state. `offset` is the next position in the domain's stably-ordered unit
 *  list; `total` is that list's length once first enumerated (null before). `done` ⇔ offset has
 *  reached total. `processed` counts vectors actually sent (≤ offset, since embeddingless units
 *  are skipped by the upsert). */
export type DomainCursor = { offset: number; processed: number; total: number | null; done: boolean; note?: string; updatedAt: number };

const emptyCursor = (): DomainCursor => ({ offset: 0, processed: 0, total: null, done: false, updatedAt: 0 });

async function readCursor(env: RtEnv, d: BackfillDomain): Promise<DomainCursor> {
	const raw = await env.OAUTH_KV?.get(cursorKey(d));
	if (!raw) return emptyCursor();
	try {
		const c = JSON.parse(raw) as Partial<DomainCursor>;
		return {
			offset: Number(c.offset) || 0,
			processed: Number(c.processed) || 0,
			total: c.total == null ? null : Number(c.total),
			done: Boolean(c.done),
			...(typeof c.note === "string" ? { note: c.note } : {}),
			updatedAt: Number(c.updatedAt) || 0,
		};
	} catch {
		return emptyCursor();
	}
}

async function writeCursor(env: RtEnv, d: BackfillDomain, c: DomainCursor): Promise<void> {
	await env.OAUTH_KV?.put(cursorKey(d), JSON.stringify(c));
}

export type BackfillDomainProgress = DomainCursor & { domain: BackfillDomain; remaining: number | null };
export type BackfillReport = {
	index: string;
	domains: BackfillDomainProgress[];
	processed: number;
	remaining: number | null;
	done: boolean;
	vectorCount?: number;
	elapsedMs: number;
};

/** Live index size from the Vectorize binding's `describe()` — the ground-truth `vectorCount`
 *  the cursor's `processed` should converge toward. Best-effort: null on any error or a binding
 *  that predates `describe()`. Note vectorize mutations are async, so `vectorCount` lags a burst
 *  of upserts by the index's processing window (it's not instantly consistent with `processed`). */
async function liveVectorCount(env: RtEnv): Promise<number | null> {
	try {
		const idx = (env as { VECTORIZE?: { describe?: () => Promise<{ vectorCount?: number }> } }).VECTORIZE;
		const info = await idx?.describe?.();
		return typeof info?.vectorCount === "number" ? info.vectorCount : null;
	} catch {
		return null;
	}
}

function toProgress(d: BackfillDomain, c: DomainCursor): BackfillDomainProgress {
	return { domain: d, ...c, remaining: c.total == null ? null : Math.max(0, c.total - c.offset) };
}

async function buildReport(env: RtEnv, which: BackfillDomain[], startedAt: number): Promise<BackfillReport> {
	const domains: BackfillDomainProgress[] = [];
	for (const d of which) domains.push(toProgress(d, await readCursor(env, d)));
	const processed = domains.reduce((n, d) => n + d.processed, 0);
	// remaining is only meaningful once every not-done domain has a known total; a not-yet-read
	// (cold) domain leaves it null rather than under-reporting.
	const anyUnknown = domains.some((d) => !d.done && d.remaining == null);
	const remaining = anyUnknown ? null : domains.reduce((n, d) => n + (d.remaining ?? 0), 0);
	const done = domains.every((d) => d.done);
	const vectorCount = await liveVectorCount(env);
	return { index: CORPUS_INDEX, domains, processed, remaining, done, ...(vectorCount != null ? { vectorCount } : {}), elapsedMs: Date.now() - startedAt };
}

/** Advance one domain by as many bounded windows as fit the remaining tick budget, persisting
 *  the cursor after each. Returns the domain's final cursor for this tick. Fail-open: a not-ready
 *  enumeration (cold cache / unavailable index) records the note and leaves the cursor un-done so
 *  the next tick retries; a thrown enumeration/upsert error does the same. */
async function advanceDomain(env: RtEnv, d: BackfillDomain, startedAt: number, budgetMs: number, batch: number, maxBatches: number): Promise<DomainCursor> {
	let cur = await readCursor(env, d);
	let batches = 0;
	while (!cur.done) {
		if (batches >= maxBatches) break;
		if (Date.now() - startedAt > budgetMs) break;
		batches++;
		let enumerated: EnumerateResult;
		try {
			enumerated = await enumerateDomain(env, d, { cached: true });
		} catch (e) {
			cur = { ...cur, note: errMsg(e), updatedAt: Date.now() };
			await writeCursor(env, d, cur);
			break;
		}
		if (!enumerated.ready) {
			cur = { ...cur, ...(enumerated.note ? { note: enumerated.note } : {}), updatedAt: Date.now() };
			await writeCursor(env, d, cur);
			break;
		}
		const total = enumerated.items.length;
		if (cur.offset >= total) {
			// Reached the end (or an empty domain) — authoritative, so mark done.
			cur = { offset: total, processed: cur.processed, total, done: true, ...(enumerated.note ? { note: enumerated.note } : {}), updatedAt: Date.now() };
			await writeCursor(env, d, cur);
			break;
		}
		const window = enumerated.items.slice(cur.offset, cur.offset + batch);
		const sent = await upsertIndexUnits(env, window);
		const offset = cur.offset + window.length;
		cur = { offset, processed: cur.processed + sent, total, done: offset >= total, ...(enumerated.note ? { note: enumerated.note } : {}), updatedAt: Date.now() };
		await writeCursor(env, d, cur);
	}
	return cur;
}

/** One durable backfill tick: advance each requested domain within the shared budget, then
 *  report progress. Idempotent + resumable via the per-domain cursor. Throws only when the
 *  Vectorize binding is absent (nothing to populate). */
export async function backfillTick(env: RtEnv, opts: { domain?: BackfillDomain; batchSize?: number; budgetMs?: number; maxBatches?: number } = {}): Promise<BackfillReport> {
	if (!hasVectorize(env)) throw new Error(`Vectorize binding not bound — cannot backfill ${CORPUS_INDEX}.`);
	const startedAt = Date.now();
	const batch = Math.max(1, opts.batchSize ?? BATCH);
	const budgetMs = Math.max(1_000, opts.budgetMs ?? BUDGET_MS);
	// Windows per domain per tick — unbounded by default (budgetMs is the real bound); a caller
	// can cap it to a fixed number of windows for a small, deterministic nudge.
	const maxBatches = Math.max(1, opts.maxBatches ?? Number.POSITIVE_INFINITY);
	const which = opts.domain ? [opts.domain] : BACKFILL_DOMAINS;
	for (const d of which) {
		if (Date.now() - startedAt > budgetMs) break;
		await advanceDomain(env, d, startedAt, budgetMs, batch, maxBatches);
	}
	return buildReport(env, which, startedAt);
}

/** Pure read of the backfill progress — the cursor state + live `vectorCount`, no upserts. The
 *  observability half of the `oracle {action:"status"|"reindex"}` surface. */
export async function backfillStatus(env: RtEnv, opts: { domain?: BackfillDomain } = {}): Promise<BackfillReport> {
	const which = opts.domain ? [opts.domain] : BACKFILL_DOMAINS;
	return buildReport(env, which, Date.now());
}

/** Clear the cursor(s) so the next tick starts a domain over from offset 0. Idempotent upserts
 *  (stable ids) make a full re-run a safe no-op cost, never a duplicate — this just re-arms the
 *  loop (e.g. after the corpus changed shape). Returns which cursors were cleared. */
export async function resetBackfill(env: RtEnv, opts: { domain?: BackfillDomain } = {}): Promise<{ reset: BackfillDomain[] }> {
	const which = opts.domain ? [opts.domain] : BACKFILL_DOMAINS;
	for (const d of which) await env.OAUTH_KV?.delete(cursorKey(d));
	return { reset: which };
}
