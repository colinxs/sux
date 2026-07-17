import type { RtEnv } from "../registry";
import { cosine, embed } from "./_embed";
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

const VERSION = 1;
// Mirrors vault-mcp.ts's INDEX_MAX — bounds a pathological vault, well above the real ~500-note size.
const INDEX_MAX = 5000;
// Workers AI's bge-base-en-v1.5 caps a single embed() call at 100 texts — batch the vault's
// chunks into calls of this size rather than one call per chunk (N/EMBED_BATCH round-trips,
// not N) or one giant call that Workers AI would reject.
const EMBED_BATCH = 100;

export type SemanticChunk = { path: string; title: string; text: string; embedding: number[] };
export type SemanticIndex = { sha: string; version: number; at: number; total: number; truncated: boolean; chunks: SemanticChunk[] };

const titleOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

async function embedBatched(env: RtEnv, texts: string[]): Promise<number[][]> {
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await embed(env, texts.slice(i, i + EMBED_BATCH))));
	return out;
}

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
	const vecs = parts.length ? await embedBatched(env, parts.map((p) => p.text)) : [];
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
	const cached = (await readVaultSemanticBlob(env, cfg)) as SemanticIndex | null;
	if (cached?.sha === head && cached?.version === VERSION && Array.isArray(cached.chunks)) return cached;
	const fresh = await buildVaultSemanticIndex(env, head, cfg);
	await writeVaultSemanticBlob(env, cfg, fresh);
	return fresh;
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
