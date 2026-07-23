import { llm } from "../ai";
import type { RtEnv } from "../registry";
import { cosine } from "./_embed";
import { coarseDomain, deleteCorpusIds, upsertSourceChunks, vectorId } from "./_vectorize";

// The AUTHORITATIVE-SOURCE substrate behind the `advise` fn — the tier-1 store the
// grounded advisor is gated by. Modeled one-for-one on _examples.ts: a KV-backed set of
// embedded passages, each carrying its own embedding (for brute-force kNN retrieval) and a
// `source_id` (the per-document undo handle — every chunk records which source it came from,
// so forgetting a document scan-and-deletes exactly that source's chunks).
//
// DISTINCT key space from the neighbours: _examples.ts owns "sux:learn:example:" (labeled
// exemplars), oracle.ts owns "sux:oracle:" (one whole-KB blob). This owns two prefixes —
// "sux:source:chunk:<domain>:" (the retrieval-chunked tier-1 detail) and "sux:profile:<domain>"
// (the always-injected tier-1 summary).
//
// SHARED substrate, not distinct: oracle.ts's two-tier storage (#1235) also chunks/embeds
// each learned topic into THIS SAME "sux:source:chunk:<domain>:" keyspace (study.ts rides the
// same path via oracle's learnTopic). A bare topic name would collide 1:1 with an `advise`
// domain of the same name — a co-named oracle/study topic could silently delete or contaminate
// an advise knowledge base (#1242). oracle.ts's `sourceDomain()` therefore namespaces every
// topic as "oracle:<topic>" before it ever reaches putChunk/listChunks/deleteDomain here, so it
// can't alias one of advise's bare-string domains (e.g. "therapy", "cardiac-diet"). Any FUTURE
// caller of this module must namespace its own domain argument the same defensive way — this
// module itself does nothing to prevent two callers' domains from colliding.
//
// KV brute-force cosine (not Vectorize) is the same deliberate KISS choice _examples.ts:48
// documents: a program/care-plan/diet is tens–hundreds of chunks; a linear scan over a few
// hundred 768-dim vectors is microseconds. Vectorize is the deferred upgrade when a domain's
// source set outgrows a linear scan.

const CHUNK_PREFIX = "sux:source:chunk:";
const PROFILE_PREFIX = "sux:profile:";

const chunkKey = (domain: string, id: string) => `${CHUNK_PREFIX}${domain}:${id}`;
const chunkDomainPrefix = (domain: string) => `${CHUNK_PREFIX}${domain}:`;
const profileKey = (domain: string) => `${PROFILE_PREFIX}${domain}`;

/** A three-tier authority stack: tier-1 sources GOVERN advice; tier-3 general knowledge may
 *  only elaborate where tier 1 is silent, never contradict it. `contextual` (tier 2) is the
 *  user's own life, gathered live by recall — it grounds advice but doesn't direct it. */
export type Authority = "authoritative" | "contextual";

export type SourceChunk = {
	id: string;
	/** the document this passage came from — the bulk-undo handle (forget deletes one source_id). */
	source_id: string;
	domain: string;
	authority: Authority;
	title: string;
	text: string;
	/** bge embedding of `text`; absent only if it was stored before AI was configured. */
	embedding?: number[];
	ts: number;
};

/** A per-domain distilled synthesis of the authoritative sources — the tier-1 SUMMARY that is
 *  ALWAYS injected into every advise call (so governing directives are present even when passage
 *  retrieval misses them; the design's limitation-2 mitigation). The chunks are the tier-1 detail;
 *  this is the tier-1 summary. Both are tier 1. Mirrors the preferences.ts distilled-profile shape. */
export type Profile = {
	domain: string;
	/** the consolidated profile prose: framework, patterns, directives (rules advice must honor), tools. */
	distilled: string;
	source_ids: string[];
	updated_at: number;
};

export function newId(): string {
	return crypto.randomUUID();
}

// --- chunking ---------------------------------------------------------------

const TARGET = 1_000;
const MAX = 1_400;

/** Split extracted prose into ~800–1200-char passages on paragraph/heading boundaries, so each
 *  embedded chunk is a self-contained retrievable unit. A single paragraph longer than MAX is
 *  hard-split so no chunk blows the embedder's context. Mirrors oracle's token-bound distill idiom. */
export function chunkText(text: string, target = TARGET, max = MAX): string[] {
	const paras = text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let cur = "";
	const flush = () => {
		if (cur.trim()) chunks.push(cur.trim());
		cur = "";
	};
	for (let p of paras) {
		// A monster paragraph can't ride in one chunk — hard-split it on whitespace near `max`.
		while (p.length > max) {
			flush();
			let cut = p.lastIndexOf(" ", max);
			if (cut < max * 0.6) cut = max; // no space to break on — fall back to a hard cut
			chunks.push(p.slice(0, cut).trim());
			p = p.slice(cut).trim();
		}
		if (cur && cur.length + p.length + 2 > max) flush();
		cur = cur ? `${cur}\n\n${p}` : p;
		if (cur.length >= target) flush();
	}
	flush();
	return chunks;
}

// --- chunk store (KV) -------------------------------------------------------

export async function putChunk(env: RtEnv, c: SourceChunk): Promise<void> {
	const value = JSON.stringify(c);
	// Stamp {ts,size} into the key's KV METADATA so sourceStats() (the #1278 KV-bet observability)
	// can total a domain's blob_size_bytes + indexed_at from list() alone — no value GETs on the
	// observability path. The stored VALUE is unchanged; metadata is orthogonal to it, so retrieval
	// (listChunks/topKPassages) is untouched. Chunks written before this shipped carry no metadata
	// and self-heal on their next re-index (assimilate re-indexes per ingest, oracle per learn).
	const metadata: ChunkMeta = { ts: c.ts, size: new TextEncoder().encode(value).length };
	await env.OAUTH_KV?.put(chunkKey(c.domain, c.id), value, { metadata });
	// Write-path tap into the unified Vectorize index (#1290/#1311): every chunk that lands in KV
	// ALSO upserts into `sux-corpus` under its coarse namespace, keyed by the SAME KV id the
	// backfill uses — so live writes and a reindex sweep never duplicate. Best-effort and
	// fail-open (upsertSourceChunks no-ops without the binding and never throws); the KV write
	// above is the source of truth and must never be gated on the index accelerator.
	await upsertSourceChunks(env, [c]);
}

/** Load every chunk in a domain, paginating KV list() (caps at 1000 keys/page). The linear scan
 *  retrieval walks — the cost that would eventually trigger Vectorize (deferred, per _examples.ts:48). */
export async function listChunks(env: RtEnv, domain: string): Promise<SourceChunk[]> {
	const kv = env.OAUTH_KV;
	if (!kv) return [];
	const prefix = chunkDomainPrefix(domain);
	const out: SourceChunk[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix, cursor });
		for (const k of page.keys) {
			const raw = await kv.get(k.name);
			if (!raw) continue;
			try {
				out.push(JSON.parse(raw) as SourceChunk);
			} catch {
				/* skip an unparseable chunk */
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	out.sort((a, b) => a.ts - b.ts);
	return out;
}

/** Enumerate the domains that have any authoritative source stored (scans the chunk key space).
 *  Splits each key on its LAST colon, not its first: a namespaced domain like oracle.ts's
 *  "oracle:<topic>" (#1242) contains a colon itself, and `chunkKey`'s trailing `:${id}` (a
 *  colon-free UUID from `newId()`) is the only segment guaranteed not to contain one — splitting
 *  on the first colon instead would truncate every such domain down to just "oracle". */
export async function listDomains(env: RtEnv): Promise<string[]> {
	const kv = env.OAUTH_KV;
	if (!kv) return [];
	const domains = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: CHUNK_PREFIX, cursor });
		for (const k of page.keys) {
			const rest = k.name.slice(CHUNK_PREFIX.length);
			const i = rest.lastIndexOf(":");
			if (i > 0) domains.add(rest.slice(0, i));
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return [...domains].sort();
}

// --- KV-bet observability (v5 W5, #1278) ------------------------------------
// The KV brute-force cosine store is a deliberate KISS bet with a HARD ceiling: KV's 25MiB
// packed-value cap ≈ ~4.5k chunks/domain at ~5–6KB/chunk (v5 arc doc §2.2). The unified Vectorize
// read index has since LANDED (sux#1290/#1311) — but KV stays the SOURCE OF TRUTH (putChunk writes
// KV first, then upserts the accelerator), and the per-domain KV cosine cores are RETAINED as the
// parity-first fallback, stripped only after the prod soak (sux#1308). So this ceiling is still
// live: this block makes the bet OBSERVABLE — per-domain chunk_count + blob_size_bytes + indexed_at
// and a near-ceiling flag (the arc doc §2.3 trigger (a), "any single domain crosses ~4.5k chunks")
// — so a KV core nearing the cap is caught before the fallback is shed, and the fill of the
// source-of-truth keyspace stays visible. Computed from list() metadata alone — cheap, never an
// O(corpus) scan.

/** The KV-bet ceiling per domain (arc doc §2.2/§2.3): KV's 25MiB packed-blob cap, ≈4.5k chunks at
 *  ~5–6KB/chunk — the point past which the retained KV cosine core (fallback to the sux#1290/#1311
 *  Vectorize index, kept until the sux#1308 soak completes) stops being safe. */
export const KV_CHUNK_CEILING = 4_500;
export const KV_BLOB_CEILING_BYTES = 25 * 1024 * 1024;
/** Warn at 90% of either bound so a nearing-cap domain has runway before hard degradation (the
 *  already-logged KV write-drop, arc doc §2.3 trigger (a)) — enough to confirm its Vectorize
 *  coverage (sux#1311) before the KV fallback is stripped (sux#1308). */
export const KV_CHUNK_WARN = Math.floor(KV_CHUNK_CEILING * 0.9);
export const KV_BLOB_WARN_BYTES = Math.floor(KV_BLOB_CEILING_BYTES * 0.9);

/** The near-ceiling predicate: a domain is near the cap when its chunk count OR its packed-blob
 *  size crosses the warn line. One shared function so every retrieval store (the chunk keyspace
 *  here + the packed semantic indices in _retrieval_stats.ts) alerts identically. */
export function nearCeiling(chunk_count: number, blob_size_bytes: number): boolean {
	return chunk_count >= KV_CHUNK_WARN || blob_size_bytes >= KV_BLOB_WARN_BYTES;
}

/** Per-key KV metadata putChunk stamps so sourceStats reads size/freshness from list() (no GETs). */
type ChunkMeta = { ts: number; size: number };

/** Per-domain observability for the KV brute-force store (#1278). `metered_chunks` < `chunk_count`
 *  means some chunks predate put-time metering — blob_size_bytes/indexed_at cover only the metered
 *  ones and converge as the domain re-indexes; `chunk_count` (the primary ceiling trigger) is always
 *  exact. `near_ceiling` flags a KV core nearing the cap (sux#1290/#1311 Vectorize is the read
 *  path; the KV cores are shed after the sux#1308 parity soak). */
export type SourceDomainStat = {
	domain: string;
	chunk_count: number;
	metered_chunks: number;
	blob_size_bytes: number;
	indexed_at: number | null;
	near_ceiling: boolean;
};

/** Per-domain KV-bet stats across the WHOLE chunk keyspace (assim:<stream> / phi:medical /
 *  oracle:<topic> / bare advise domains), computed from list() metadata alone — no value GETs.
 *  chunk_count is an exact key count; blob_size_bytes/indexed_at come from the {ts,size} metadata
 *  putChunk stamps (chunks written before metering count but don't total — reported via
 *  metered_chunks). Domains split on the LAST colon (matches listDomains, so a namespaced
 *  oracle:<topic>/assim:<stream>/phi:medical stays intact rather than truncating to its head). */
export async function sourceStats(env: RtEnv): Promise<SourceDomainStat[]> {
	const kv = env.OAUTH_KV;
	if (!kv) return [];
	type Acc = { chunk_count: number; metered_chunks: number; blob_size_bytes: number; indexed_at: number | null };
	const acc = new Map<string, Acc>();
	let cursor: string | undefined;
	do {
		const page = await kv.list<ChunkMeta>({ prefix: CHUNK_PREFIX, cursor });
		for (const k of page.keys) {
			const rest = k.name.slice(CHUNK_PREFIX.length);
			const i = rest.lastIndexOf(":");
			if (i <= 0) continue;
			const domain = rest.slice(0, i);
			const e = acc.get(domain) ?? { chunk_count: 0, metered_chunks: 0, blob_size_bytes: 0, indexed_at: null };
			e.chunk_count++;
			const md = k.metadata;
			if (md && typeof md.size === "number") {
				e.metered_chunks++;
				e.blob_size_bytes += md.size;
				if (typeof md.ts === "number") e.indexed_at = Math.max(e.indexed_at ?? 0, md.ts);
			}
			acc.set(domain, e);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return [...acc.entries()]
		.map(([domain, e]) => ({ domain, ...e, near_ceiling: nearCeiling(e.chunk_count, e.blob_size_bytes) }))
		.sort((a, b) => b.chunk_count - a.chunk_count || a.domain.localeCompare(b.domain));
}

/** Delete exactly the chunks belonging to one source document — the per-document undo. Returns
 *  how many were removed. Non-atomic (scan then delete), the acceptable race _examples.ts documents.
 *  Also purges each removed chunk's mirror vector from the unified Vectorize index (#1371) —
 *  otherwise a forgotten chunk keeps citing from `oracle ask` until a full reindexCorpus rebuild. */
export async function deleteSource(env: RtEnv, domain: string, source_id: string): Promise<number> {
	const all = await listChunks(env, domain);
	const removed = all.filter((c) => c.source_id === source_id);
	for (const c of removed) await env.OAUTH_KV?.delete(chunkKey(domain, c.id));
	const namespace = coarseDomain(domain);
	await deleteCorpusIds(env, await Promise.all(removed.map((c) => vectorId(namespace, c.id, ""))));
	return removed.length;
}

/** Delete EVERY chunk in a domain, regardless of source_id — the whole-domain undo (a caller
 *  that namespaces a domain per whole topic/KB, like oracle.ts, forgets the lot in one call
 *  rather than enumerating source_ids itself). Returns how many were removed. Also purges each
 *  chunk's mirror vector from the unified Vectorize index (#1371, same rationale as deleteSource). */
export async function deleteDomain(env: RtEnv, domain: string): Promise<number> {
	const all = await listChunks(env, domain);
	for (const c of all) await env.OAUTH_KV?.delete(chunkKey(domain, c.id));
	const namespace = coarseDomain(domain);
	await deleteCorpusIds(env, await Promise.all(all.map((c) => vectorId(namespace, c.id, ""))));
	return all.length;
}

export type Passage = { text: string; source_id: string; title: string; score: number };

/** Brute-force kNN over a domain's chunks: cosine-rank against `queryVec`, take the top-k. Chunks
 *  stored before AI was configured (no embedding) are skipped. Empty/embeddingless set → [] (never
 *  throws) — the gate then leans on the always-injected Profile alone. */
export function topKPassages(queryVec: number[], chunks: SourceChunk[], k = 6): Passage[] {
	return chunks
		.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
		.map((c) => ({ text: c.text, source_id: c.source_id, title: c.title, score: cosine(queryVec, c.embedding!) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, k));
}

// --- profile store (KV) -----------------------------------------------------

export async function loadProfile(env: RtEnv, domain: string): Promise<Profile | null> {
	const raw = await env.OAUTH_KV?.get(profileKey(domain));
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as Partial<Profile>;
		return {
			domain,
			distilled: String(p?.distilled ?? ""),
			source_ids: Array.isArray(p?.source_ids) ? p.source_ids.map(String) : [],
			updated_at: Number(p?.updated_at) || 0,
		};
	} catch {
		return null;
	}
}

async function saveProfile(env: RtEnv, p: Profile): Promise<void> {
	await env.OAUTH_KV?.put(profileKey(p.domain), JSON.stringify(p));
}

export async function deleteProfile(env: RtEnv, domain: string): Promise<void> {
	await env.OAUTH_KV?.delete(profileKey(domain));
}

/** How many chars of source material we feed one profile-distill pass (bound the model input,
 *  the oracle DISTILL_INPUT_CAP convention). */
const DISTILL_INPUT_CAP = 24_000;
const PROFILE_CAP = 8_000;

/** Consolidate a domain's authoritative source into a single coherent PROFILE — the tier-1 summary.
 *  Reuses oracle's re-distill call shape (fenced llm(), the source is untrusted data). Sections it
 *  by the four profile facets so the always-injected summary carries the governing directives. */
const PROFILE_SYSTEM =
	"You are distilling an AUTHORITATIVE program/plan/document into a concise PROFILE that will GOVERN future advice. Consolidate the material into a single self-contained profile with these labeled sections:\n" +
	"FRAMEWORK: the approach/model it prescribes (e.g. a therapeutic modality, a diet, an allocation).\n" +
	"PATTERNS: the recurring situations/triggers/behaviours it identifies.\n" +
	"DIRECTIVES: its explicit prescriptions and rules — the things advice MUST stay consistent with.\n" +
	"TOOLS: the concrete skills/steps/allowances it offers.\n" +
	"Preserve every distinct directive; omit fluff. Output only the profile, <= ~700 words.";

/** (Re)distill the whole domain's chunk set into its Profile and persist it — the continual update
 *  (new source lands → re-distill from the full set, oracle's rolling-KB idea). Returns the saved
 *  Profile. An empty consolidation (transient model hiccup) falls back to the concatenated chunks
 *  rather than discarding knowledge. */
export async function distillProfile(env: RtEnv, domain: string): Promise<Profile> {
	const chunks = await listChunks(env, domain);
	const source_ids = [...new Set(chunks.map((c) => c.source_id))];
	if (!chunks.length) {
		const empty: Profile = { domain, distilled: "", source_ids, updated_at: Date.now() };
		await saveProfile(env, empty);
		return empty;
	}
	const combined = chunks
		.map((c, i) => `Passage ${i + 1} (${c.title}):\n${c.text}`)
		.join("\n\n")
		.slice(0, DISTILL_INPUT_CAP);
	const distilled = (await llm(env, PROFILE_SYSTEM, combined, 1_400, "distill an authoritative profile")).trim() || combined.slice(0, PROFILE_CAP);
	const profile: Profile = { domain, distilled: distilled.slice(0, PROFILE_CAP), source_ids, updated_at: Date.now() };
	await saveProfile(env, profile);
	return profile;
}
