import { llm } from "../ai";
import type { RtEnv } from "../registry";
import { cosine } from "./_embed";
import { upsertSourceChunks } from "./_vectorize";

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
	await env.OAUTH_KV?.put(chunkKey(c.domain, c.id), JSON.stringify(c));
	// Write-path tap into the unified Vectorize index (#1290): every chunk that lands in KV
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

/** Delete exactly the chunks belonging to one source document — the per-document undo. Returns
 *  how many were removed. Non-atomic (scan then delete), the acceptable race _examples.ts documents. */
export async function deleteSource(env: RtEnv, domain: string, source_id: string): Promise<number> {
	const all = await listChunks(env, domain);
	let n = 0;
	for (const c of all) {
		if (c.source_id === source_id) {
			await env.OAUTH_KV?.delete(chunkKey(domain, c.id));
			n++;
		}
	}
	return n;
}

/** Delete EVERY chunk in a domain, regardless of source_id — the whole-domain undo (a caller
 *  that namespaces a domain per whole topic/KB, like oracle.ts, forgets the lot in one call
 *  rather than enumerating source_ids itself). Returns how many were removed. */
export async function deleteDomain(env: RtEnv, domain: string): Promise<number> {
	const all = await listChunks(env, domain);
	for (const c of all) await env.OAUTH_KV?.delete(chunkKey(domain, c.id));
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

// --- observability (v5 WS5, #1278) ------------------------------------------

/** KV's per-key packed-blob cap is 25MiB; an embedded chunk (text + a 768-dim float embedding,
 *  JSON-serialized) runs ~5-6KB, so a single domain's chunk set approaches that cap somewhere
 *  around 4.5k chunks. This is the GRADUATION TRIGGER for sux#1290's pre-written Vectorize
 *  escape-hatch issue (held until a trigger fires) — instrumentation only, NOT auto-graduation;
 *  crossing it just means the KV-brute-force approach (_examples.ts:48's deliberate KISS choice)
 *  needs a human to go open/action #1290 for that domain. */
export const KV_CHUNK_CEILING = 4_500;
const KV_CHUNK_WARN_RATIO = 0.9;

export type DomainQueryStats = {
	source_domain: string;
	chunk_count: number;
	blob_size_bytes: number;
	retrieval_ms: number;
	indexed_at: number | null;
};

/** The one instrumented kNN query path (advise.ts/oracle.ts's retrieval, per #1278) — wraps
 *  listChunks + topKPassages with the timing/size/freshness fields Workers Observability keys
 *  on, so an approaching KV_CHUNK_CEILING shows up before it's hit blind rather than after.
 *  Behavior-identical to calling listChunks then topKPassages directly; this only adds the log. */
export async function queryDomain(env: RtEnv, domain: string, queryVec: number[], k = 6): Promise<{ passages: Passage[]; stats: DomainQueryStats }> {
	const start = Date.now();
	const chunks = await listChunks(env, domain);
	const passages = topKPassages(queryVec, chunks, k);
	const retrieval_ms = Date.now() - start;

	const chunk_count = chunks.length;
	const blob_size_bytes = chunks.reduce((sum, c) => sum + JSON.stringify(c).length, 0);
	const indexed_at = chunk_count ? Math.max(...chunks.map((c) => c.ts)) : null;

	const stats: DomainQueryStats = { source_domain: domain, chunk_count, blob_size_bytes, retrieval_ms, indexed_at };
	console.log(JSON.stringify({ event: "source_knn_query", ...stats }));

	if (chunk_count >= KV_CHUNK_CEILING) {
		console.warn(`source: domain=${domain} chunk_count=${chunk_count} is AT/OVER the ~${KV_CHUNK_CEILING}-chunk KV ceiling — open sux#1290 (Vectorize escape-hatch) if this domain keeps growing.`);
	} else if (chunk_count >= KV_CHUNK_CEILING * KV_CHUNK_WARN_RATIO) {
		console.warn(`source: domain=${domain} chunk_count=${chunk_count} is approaching the ~${KV_CHUNK_CEILING}-chunk KV ceiling — open sux#1290 (Vectorize escape-hatch) if this domain keeps growing.`);
	}

	return { passages, stats };
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
