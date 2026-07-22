import type { RtEnv } from "../registry";
import { cosine, decodeEmbedding, embed, encodeEmbedding } from "./_embed";
import { chunkText } from "./_source";
import { obsidian } from "./obsidian";
import { type VaultCfg, readVaultSemanticBlob, vaultHead, writeVaultSemanticBlob } from "./obsidian";

// The vault_semantic substrate: brute-force KV cosine kNN over the vault's own notes —
// same deliberate KISS choice _source.ts:16 documents (no Vectorize; a few hundred
// 768-dim chunks is a microsecond linear scan). DISTINCT from _source.ts's chunk store
// (that's the `advise` fn's user-ingested authoritative sources, keyed by domain) — this
// owns the vault-mcp derived-index's cache contract: HEAD-keyed, rebuilt on vault change,
// same as vault-mcp.ts's buildVaultIndex/vaultIndex. A separate full-body read pass (the
// derived index only keeps a ~300-char excerpt per note, not enough to embed meaningfully).

// Bumped 1→2 (#722): #717 repacked chunk.embedding from a raw number[] to a base64
// string (encodeEmbedding) WITHOUT bumping this, so a pre-#717 blob's version:1 passed
// the cache-hit check below and fromStored's decodeEmbedding(number[]) threw atob()
// InvalidCharacterError. Bumping invalidates any such stale blob so it rebuilds instead
// of crashing; isStoredSemanticIndex is a second, permanent line of defense against the
// same class of drift next time the persisted shape changes.
const VERSION = 2;
// Mirrors vault-mcp.ts's INDEX_MAX — bounds a pathological vault, well above the real ~500-note size.
const INDEX_MAX = 5000;

export type SemanticChunk = { path: string; title: string; text: string; embedding: number[] };
export type SemanticIndex = { sha: string; version: number; at: number; total: number; truncated: boolean; chunks: SemanticChunk[] };

// The persisted shape mirrors SemanticIndex but with each chunk's embedding packed via
// encodeEmbedding (base64 Float32, ~4x smaller than JSON's full-precision doubles) — the
// KV blob's overwhelming bulk is 768-dim vectors, and at the vault-mcp-documented ~500-note
// real vault size, the unpacked JSON form sits right at KV's 25MiB value cap (#717).
type StoredSemanticChunk = { path: string; title: string; text: string; embedding: string };
type StoredSemanticIndex = Omit<SemanticIndex, "chunks"> & { chunks: StoredSemanticChunk[] };

function toStored(index: SemanticIndex): StoredSemanticIndex {
	return { ...index, chunks: index.chunks.map((c) => ({ ...c, embedding: encodeEmbedding(c.embedding) })) };
}

function fromStored(stored: StoredSemanticIndex): SemanticIndex {
	return { ...stored, chunks: stored.chunks.map((c) => ({ ...c, embedding: decodeEmbedding(c.embedding) })) };
}

/** Defensive second line against the exact #722 drift class: a cached blob whose shape
 *  doesn't actually match StoredSemanticIndex (chunk.embedding must be a base64 string,
 *  not a raw number[]) is treated as a cache miss and rebuilt, rather than trusted just
 *  because its `version` field happened to match. */
function isStoredSemanticIndex(v: unknown): v is StoredSemanticIndex {
	if (!v || typeof v !== "object") return false;
	const s = v as StoredSemanticIndex;
	return Array.isArray(s.chunks) && s.chunks.every((c) => typeof c?.embedding === "string");
}

const titleOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/** Read every note in full, chunk it, and embed every chunk (batched). Mirrors vault-mcp.ts's
 *  buildVaultIndex shape (list → per-note read → derive), but keeps the full chunked body
 *  instead of a short excerpt, since that's what a semantic search needs to rank against. */
export async function buildVaultSemanticIndex(env: RtEnv, sha: string, cfg: VaultCfg): Promise<SemanticIndex> {
	const listRes = await obsidian.run(env, { action: "list", backend: "git" });
	if (listRes.isError) throw new Error(listRes.content?.[0]?.text ?? "vault list failed");
	const listing = JSON.parse(listRes.content[0].text) as { notes?: string[] };
	const all = Array.isArray(listing.notes) ? listing.notes : [];
	const notes = all.slice(0, INDEX_MAX);
	let failed = 0;
	const perNote = await Promise.all(
		notes.map(async (path) => {
			// `list` returns dir-prefixed paths but `read` re-applies the dir itself — strip it
			// here, mirroring buildVaultIndex's identical fix for the same double-prefix 404.
			const readPath = cfg.dir && path.startsWith(`${cfg.dir}/`) ? path.slice(cfg.dir.length + 1) : path;
			const r = await obsidian.run(env, { action: "read", path: readPath, backend: "git" });
			if (r.isError) {
				failed++;
				return [];
			}
			const content = r.content[0].text as string;
			return chunkText(content).map((text) => ({ path, title: titleOf(path), text }));
		}),
	);
	const parts = perNote.flat();
	const vecs = parts.length ? await embed(env, parts.map((p) => p.text)) : [];
	const chunks: SemanticChunk[] = parts.map((p, i) => ({ ...p, embedding: vecs[i] ?? [] }));
	return { sha, version: VERSION, at: Date.now(), total: all.length, truncated: all.length > INDEX_MAX || failed > 0, chunks };
}

/** The semantic index for the current HEAD, rebuilt on HEAD mismatch — same bounded-stale
 *  contract as vault-mcp.ts's vaultIndex. Returns null when there's no KV or HEAD can't be
 *  resolved (offline); the caller reports not_configured rather than falling back to a live
 *  scan (embedding every note per-request is not an acceptable degrade). */
export async function vaultSemanticIndex(env: RtEnv, cfg: VaultCfg): Promise<SemanticIndex | null> {
	const head = env.OAUTH_KV ? await vaultHead(env, cfg) : null;
	if (!head) return null;
	const storedCached = (await readVaultSemanticBlob(env, cfg)) as StoredSemanticIndex | null;
	if (storedCached?.sha === head && storedCached?.version === VERSION && isStoredSemanticIndex(storedCached)) return fromStored(storedCached);
	const fresh = await buildVaultSemanticIndex(env, head, cfg);
	const wrote = await writeVaultSemanticBlob(env, cfg, toStored(fresh));
	if (!wrote) console.log(`vault_semantic: index write for ${cfg.repo}@${head} was dropped (over KV's 25MiB cap or a codec error) — every request will re-embed the vault until it fits`);
	return fresh;
}

/** Read-ONLY sibling of vaultSemanticIndex: return the CACHED index if a valid warm blob is
 *  present, else null — it NEVER builds. A full vault (re)build lists + reads + embeds every
 *  note, which exceeds a single request's lifetime; its KV write then never lands, so a
 *  query-path caller of the building variant re-embeds the whole vault on every call and blows
 *  its per-domain budget every time (#1298). `oracle ask` uses THIS instead: a warm cache still
 *  answers (bounded-stale — a HEAD drift is accepted here rather than triggering a rebuild),
 *  and a cold cache degrades that domain in milliseconds instead of burning the full budget. The
 *  real warm-index substrate — an out-of-band-built ANN index — is Vectorize (#1290). */
export async function vaultSemanticIndexCached(env: RtEnv, cfg: VaultCfg): Promise<SemanticIndex | null> {
	if (!env.OAUTH_KV) return null;
	const storedCached = (await readVaultSemanticBlob(env, cfg)) as StoredSemanticIndex | null;
	if (storedCached?.version === VERSION && isStoredSemanticIndex(storedCached)) return fromStored(storedCached);
	return null;
}

export type SemanticHit = { path: string; title: string; text: string; score: number };

/** Brute-force kNN: cosine-rank a domain's chunks against `queryVec`, take the top-k. Chunks
 *  that failed to embed (a transient batch hiccup) are skipped rather than scored as 0. */
export function topKByCosine(queryVec: number[], chunks: SemanticChunk[], k = 8): SemanticHit[] {
	return chunks
		.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
		.map((c) => ({ path: c.path, title: c.title, text: c.text, score: cosine(queryVec, c.embedding) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, k));
}
