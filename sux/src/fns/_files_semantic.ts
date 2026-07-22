import type { RtEnv } from "../registry";
import { cosine, decodeEmbedding, embed, encodeEmbedding } from "./_embed";
import { hasDropboxFull, listFullChanges, readFull } from "./_dropbox-full";
import { chunkText } from "./_source";

// files_semantic — the vault_semantic/mail_semantic pattern (_vault_semantic.ts /
// _mail_semantic.ts: brute-force KV cosine kNN over Workers-AI embeddings) applied to
// recall's files (Dropbox Mode B) leg. Neither the vault's cache key (git HEAD) nor
// mail's (JMAP Email `state`) exists for Dropbox — the nearest analog is Dropbox's own
// `list_folder` cursor, so this index is keyed by `cursor` and MAINTAINED INCREMENTALLY
// via list_folder/continue (upsert changed paths, drop deleted ones) rather than rebuilt
// wholesale on every request. An invalidated/expired cursor (Dropbox's loose analog of
// JMAP's cannotCalculateChanges — there's no distinct error type, just a reset-shaped
// error_summary) falls back to a full rebuild, same as a mail `state` that aged out.
//
// Scope is deliberately narrow: only the small textual files recall.ts's fromFiles
// would already inline (FILE_SIZE_CAP + FILES_SEMANTIC_TEXT_EXT — MUST match the
// criteria at recall.ts:173's keyword leg, so the semantic index never claims coverage
// the keyword leg wouldn't also have offered). Dropbox Mode B's file set is far less
// bounded than a vault or a mailbox (opt-in over a WHOLE account), so both the number of
// files considered per build/update AND the total chunk count are hard-capped.

const VERSION = 1;
// Bounds total CHUNKS kept in the index (not files — a single matching file can produce
// many chunks). Sized above mail's 1000-message INDEX_MAX since a chunk is a smaller
// retrieval unit than a whole message, but still a firm cap against an unbounded
// whole-Dropbox corpus (the issue's "honest caveat": Mode B's file set is less bounded
// than the vault/mailbox).
const INDEX_MAX = 3000;
// Caps the number of FILES considered per build/update pass, independent of INDEX_MAX —
// bounds the readFull/embed fan-out itself so one huge account's cursor exhaustion can't
// dominate a single request; the rest is picked up on a later incremental pass.
const MAX_FILES = 500;
// Only small textual files are ever embedded — mirrors fromFiles's own inline gate
// (recall.ts:173), so the semantic index never covers ground the keyword leg wouldn't.
export const FILE_SIZE_CAP = 200_000;
export const FILES_SEMANTIC_TEXT_EXT = /\.(md|txt|json|csv|tsv|ya?ml|xml|html?)$/i;
// list_folder/continue pages at most this many pages per call; caps the paging loop
// against a huge backlog (a first-ever build, or an update stale by months) rather than
// looping unbounded — mirrors _mail_semantic.ts's MAX_CHANGE_PAGES.
const MAX_LIST_PAGES = 5;
// Single Dropbox (Mode B) account — no repo/branch dimension, unlike the vault's
// per-repo keying. Mirrors mail's KV_KEY: one fixed key.
const KV_KEY = "sux:files:semantic";

export type FilesSemanticChunk = { path: string; text: string; embedding: number[] };
export type FilesSemanticIndex = { cursor: string; version: number; at: number; total: number; truncated: boolean; chunks: FilesSemanticChunk[] };

// Persisted shape packs each chunk's embedding via encodeEmbedding (base64 Float32) —
// same ~4x space saving as the vault/mail semantic stores (#717); embeddings dominate
// the blob.
type StoredFilesSemanticChunk = Omit<FilesSemanticChunk, "embedding"> & { embedding: string };
type StoredFilesSemanticIndex = Omit<FilesSemanticIndex, "chunks"> & { chunks: StoredFilesSemanticChunk[] };

function toStored(index: FilesSemanticIndex): StoredFilesSemanticIndex {
	return { ...index, chunks: index.chunks.map((c) => ({ ...c, embedding: encodeEmbedding(c.embedding) })) };
}
function fromStored(stored: StoredFilesSemanticIndex): FilesSemanticIndex {
	return { ...stored, chunks: stored.chunks.map((c) => ({ ...c, embedding: decodeEmbedding(c.embedding) })) };
}
/** Same defensive shape guard as _vault_semantic.ts's isStoredSemanticIndex / _mail_semantic.ts's
 *  isStoredMailSemanticIndex — a cached blob whose chunks aren't actually the current persisted
 *  shape is treated as a cache miss and rebuilt, never trusted just because `version` matched. */
function isStoredFilesSemanticIndex(v: unknown): v is StoredFilesSemanticIndex {
	if (!v || typeof v !== "object") return false;
	const s = v as StoredFilesSemanticIndex;
	return typeof s.cursor === "string" && Array.isArray(s.chunks) && s.chunks.every((c) => typeof c?.path === "string" && typeof c?.embedding === "string");
}

async function readBlob(env: RtEnv): Promise<unknown | null> {
	const raw = await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.get(KV_KEY).catch(() => null);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeBlob(env: RtEnv, blob: StoredFilesSemanticIndex): Promise<boolean> {
	try {
		await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.put(KV_KEY, JSON.stringify(blob));
		return true;
	} catch (e) {
		console.log(`files_semantic: index write failed: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** True when a live list_folder(/continue) entry is a small textual file worth embedding —
 *  the exact criteria fromFiles already applies at recall.ts:173, kept in sync by this
 *  being the ONE place either leg checks it against a listing entry. */
function isCandidate(e: any): e is { kind: "file"; path: string; size: number } {
	return e?.kind === "file" && typeof e?.path === "string" && typeof e?.size === "number" && e.size <= FILE_SIZE_CAP && FILES_SEMANTIC_TEXT_EXT.test(e.path);
}

/** Page list_folder(/continue) from `cursor` (undefined ⇒ a fresh whole-account listing),
 *  collecting up to MAX_FILES matching-criteria file paths across at most MAX_LIST_PAGES
 *  pages. `truncated` is set whenever the loop stopped short of exhausting the account
 *  (either cap hit) — a later incremental call picks up wherever this cursor left off.
 *  Returns EVERY candidate from the last page consumed, unsliced — `cursor` is only ever
 *  advanced to just past a page whose candidates are all included in `files`, so a caller
 *  that persists `cursor` never skips a file. Slicing to MAX_FILES here would drop the
 *  overshoot of a single big page while the returned cursor already points past it, and a
 *  later incremental pass resumes AFTER that cursor and never re-encounters them (#763). The
 *  overshoot this allows is bounded to at most one page, since the loop stops STARTING new
 *  pages once `files.length >= MAX_FILES`. */
async function collectCandidates(env: RtEnv, cursor?: string): Promise<{ files: string[]; cursor: string; truncated: boolean }> {
	let cur = cursor;
	let lastCursor = cursor ?? "";
	const files: string[] = [];
	let truncated = false;
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const r = await listFullChanges(env, cur);
		lastCursor = r.cursor || lastCursor;
		for (const e of r.entries) if (isCandidate(e)) files.push(e.path);
		cur = r.cursor;
		if (files.length >= MAX_FILES) {
			truncated = true;
			break;
		}
		if (!r.has_more) break;
		if (page === MAX_LIST_PAGES - 1) truncated = true; // hit the page cap with more still pending
	}
	return { files, cursor: lastCursor, truncated };
}

/** Read + chunk one candidate file. A per-file readFull failure (deleted between listing and
 *  read, transient error) must not sink the whole build — return no chunks for it rather than
 *  throwing. */
async function chunkFile(env: RtEnv, path: string): Promise<Array<{ path: string; text: string }>> {
	try {
		const r = await readFull(env, path);
		if (typeof r?.text !== "string" || !r.text.trim()) return [];
		return chunkText(r.text).map((text) => ({ path, text }));
	} catch {
		return [];
	}
}

/** Full rebuild: list the whole account (bounded by MAX_LIST_PAGES/MAX_FILES), read+chunk+embed
 *  every matching file. Chunks are kept in listing order (files have no cheap cross-account
 *  recency signal the way mail's receivedAt gives a "keep newest" rule) and hard-truncated to
 *  INDEX_MAX — embedding is skipped for anything past the cap rather than embedding-then-discarding. */
async function buildFull(env: RtEnv): Promise<FilesSemanticIndex> {
	const { files, cursor, truncated: listTruncated } = await collectCandidates(env);
	const perFile = await Promise.all(files.map((path) => chunkFile(env, path)));
	const failed = perFile.filter((c) => c.length === 0).length;
	const allParts = perFile.flat();
	const kept = allParts.slice(0, INDEX_MAX);
	const vecs = kept.length ? await embed(env, kept.map((p) => p.text)) : [];
	const chunks: FilesSemanticChunk[] = kept.map((p, i) => ({ ...p, embedding: vecs[i] ?? [] }));
	const truncated = listTruncated || allParts.length > INDEX_MAX || failed > 0;
	// `total` is the count of distinct FILES actually represented in the chunk set — Dropbox's
	// list_folder has no whole-account "total matching files" the way JMAP's Email/query gives
	// mail's buildFull a true mailbox count, so this is a lower bound (what's indexed), not a
	// whole-corpus count; `truncated` is what tells a caller more exists beyond it.
	return { cursor, version: VERSION, at: Date.now(), total: new Set(chunks.map((c) => c.path)).size, truncated, chunks };
}

/** Incremental update from `cached.cursor`: page list_folder/continue, collect every changed
 *  (live) path and every deleted path across pages, re-embed only the changed paths that still
 *  match the size/extension criteria, and drop ALL existing chunks whose path changed OR was
 *  deleted (a changed path that no longer qualifies — grew past the cap, renamed to a non-text
 *  extension — must not linger in the index just because it wasn't re-embedded). Returns null
 *  when Dropbox can no longer continue from `cached.cursor` (an invalidated/reset cursor) so the
 *  caller falls back to buildFull, mirroring _mail_semantic.ts's cannotCalculateChanges → null
 *  → rebuild contract. */
async function applyChanges(env: RtEnv, cached: FilesSemanticIndex): Promise<{ index: FilesSemanticIndex; changed: boolean } | null> {
	let cursor = cached.cursor;
	const changedPaths = new Set<string>();
	const toEmbedPaths = new Set<string>();
	const deletedPaths = new Set<string>();
	let pageCapped = false;
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		let r: Awaited<ReturnType<typeof listFullChanges>>;
		try {
			r = await listFullChanges(env, cursor);
		} catch (e) {
			// Dropbox has no distinct "cannotCalculateChanges" error type the way JMAP does — an
			// invalidated/expired cursor surfaces as a plain error whose error_summary is
			// reset-shaped. Anything else (auth, transport) rethrows; the caller's own try/catch
			// around applyChanges falls back to buildFull too, same net effect either way.
			if (/reset/i.test(e instanceof Error ? e.message : String(e))) return null;
			throw e;
		}
		for (const e of r.entries) {
			if (typeof e?.path !== "string") continue;
			changedPaths.add(e.path);
			if (isCandidate(e)) toEmbedPaths.add(e.path);
		}
		for (const p of r.deleted) deletedPaths.add(p);
		cursor = r.cursor || cursor;
		if (!r.has_more) break;
		if (page === MAX_LIST_PAGES - 1) pageCapped = true; // hit the page cap with more still pending
	}
	// Nothing to persist: same chunk set, so a re-serialize + KV `put` would buy nothing but a
	// bumped `at`. `changed: false` tells the caller to skip the write; the next call simply
	// re-diffs from the same (still-valid) cached.cursor.
	if (!changedPaths.size && !deletedPaths.size) return { index: cached, changed: false };
	const dropped = new Set([...changedPaths, ...deletedPaths]);
	const perFile = await Promise.all([...toEmbedPaths].map((path) => chunkFile(env, path)));
	const freshParts = perFile.flat();
	const vecs = freshParts.length ? await embed(env, freshParts.map((p) => p.text)) : [];
	const fresh: FilesSemanticChunk[] = freshParts.map((p, i) => ({ ...p, embedding: vecs[i] ?? [] }));
	const keptOld = cached.chunks.filter((c) => !dropped.has(c.path));
	// `fresh` first, `keptOld` second: on a full-index eviction below, slicing to INDEX_MAX must
	// keep the just-changed/new chunks over stale ones, mirroring mail's recency-ordered eviction
	// (#734/#731) — files have no receivedAt to sort by, but "just touched" is the same signal.
	let chunks = [...fresh, ...keptOld];
	const truncated = cached.truncated || pageCapped || chunks.length > INDEX_MAX;
	if (chunks.length > INDEX_MAX) chunks = chunks.slice(0, INDEX_MAX);
	return { index: { cursor, version: VERSION, at: Date.now(), total: new Set(chunks.map((c) => c.path)).size, truncated, chunks }, changed: true };
}

/** The files semantic index — incrementally maintained (list_folder/continue) against the
 *  cached cursor, falling back to a full rebuild when there's no cache, a shape drift, a version
 *  mismatch, or the cursor can no longer be continued. Returns null when Dropbox Mode B isn't
 *  configured (hasDropboxFull — the read credential; write is a separate, unrelated gate),
 *  mirroring _mail_semantic.ts's null-on-unconfigured contract. Deliberately does NOT also gate
 *  on hasAI — the caller (recall.ts's fromFiles) already checks that before calling in, matching
 *  fromMail's hasAI(env) guard around mailSemanticIndex. */
export async function filesSemanticIndex(env: RtEnv): Promise<FilesSemanticIndex | null> {
	if (!hasDropboxFull(env)) return null;
	const storedCached = await readBlob(env);
	if (isStoredFilesSemanticIndex(storedCached) && storedCached.version === VERSION) {
		const cached = fromStored(storedCached);
		try {
			const result = await applyChanges(env, cached);
			if (result) {
				if (result.changed) {
					const wrote = await writeBlob(env, toStored(result.index));
					if (!wrote) console.log("files_semantic: incremental index write dropped (over KV's 25MiB cap or a codec error) — next call re-diffs from the same cursor");
				}
				return result.index;
			}
		} catch (e) {
			console.log(`files_semantic: incremental update failed (${e instanceof Error ? e.message : String(e)}) — falling back to a full rebuild`);
		}
	}
	const fresh = await buildFull(env);
	const wrote = await writeBlob(env, toStored(fresh));
	if (!wrote) console.log("files_semantic: index write for full rebuild was dropped (over KV's 25MiB cap or a codec error) — every request will re-embed until it fits");
	return fresh;
}

/** Read-ONLY sibling of filesSemanticIndex: return the CACHED index if a valid warm blob is
 *  present, else null — it NEVER runs applyChanges (Dropbox list round-trips) or a full rebuild.
 *  Same reason as the vault/mail cached siblings (#1298): keep the `oracle ask` query path off
 *  network/embed work so it can't blow its per-domain budget every call. Warm answers
 *  bounded-stale; cold degrades fast. The real substrate fix is the Vectorize index (#1290). */
export async function filesSemanticIndexCached(env: RtEnv): Promise<FilesSemanticIndex | null> {
	if (!hasDropboxFull(env)) return null;
	const storedCached = await readBlob(env);
	if (isStoredFilesSemanticIndex(storedCached) && storedCached.version === VERSION) return fromStored(storedCached);
	return null;
}

export type FilesSemanticHit = { path: string; text: string; score: number };

/** Brute-force kNN: cosine-rank the files chunks against `queryVec`, take the top-k. Mirrors
 *  topKByCosine/topKMailByCosine's identical KISS choice — a bounded, ≤INDEX_MAX-sized corpus is
 *  a microsecond linear scan, no Vectorize needed. No `title` field (files have no natural title
 *  the way a vault note's filename gives one) — just `path`. */
export function topKFilesByCosine(queryVec: number[], chunks: FilesSemanticChunk[], k = 8): FilesSemanticHit[] {
	return chunks
		.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
		.map((c) => ({ path: c.path, text: c.text, score: cosine(queryVec, c.embedding) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, k));
}
