import type { RtEnv } from "../registry";
import { listFullChanges } from "./_dropbox-full";
import { FILES_SEMANTIC_TEXT_EXT } from "./_files_semantic";
import type { DuplicateFileCluster } from "./_files_consolidate";

// Byte-identical duplicate detection for #1015/#1022: _files_consolidate.ts's cosine
// clustering only ever sees files_semantic's embeddings, which are scoped to small TEXTUAL
// files (FILES_SEMANTIC_TEXT_EXT) — a screenshot, PDF, or other binary download can never be
// embedded, so it can never cluster there. Dropbox's list_folder already returns a free
// `content_hash` per file (its own whole-file content digest, no download needed), so exact
// duplicates among everything ELSE (non-textual files) are just a group-by over that field —
// far cheaper than the "re-embed via a vision model" lift #1022 flagged as out of reach.
// Feeds the SAME {paths} cluster shape files_consolidate_plan.ts already proposes/archives,
// just from a second, complementary detection source.

// Mirrors _files_consolidate.ts's MAX_FILES_FOR_DEDUP — bounds the group-by pass against one
// huge account rather than left uncapped.
const MAX_FILES_FOR_BINARY_DEDUP = 3000;
// Mirrors _files_semantic.ts's MAX_LIST_PAGES — caps the list_folder/continue paging loop.
const MAX_LIST_PAGES = 5;

/** A live list_folder(/continue) entry worth hashing: a non-empty file with a content_hash,
 *  OUTSIDE the textual extensions files_semantic already covers — keeps this detector
 *  strictly complementary to findDuplicateFiles rather than double-proposing the same file. */
function isCandidate(e: any): e is { kind: "file"; path: string; size: number; content_hash: string } {
	return e?.kind === "file" && typeof e?.path === "string" && typeof e?.content_hash === "string" && e.content_hash.length > 0 && typeof e?.size === "number" && e.size > 0 && !FILES_SEMANTIC_TEXT_EXT.test(e.path);
}

/** Page list_folder(/continue) from a fresh whole-account listing, collecting up to
 *  MAX_FILES_FOR_BINARY_DEDUP matching (path, content_hash) pairs across at most
 *  MAX_LIST_PAGES pages — mirrors _files_semantic.ts's collectCandidates, stateless (no
 *  cursor persisted): every call re-lists from scratch, since a hash group-by is cheap enough
 *  not to need files_semantic's incremental-index machinery. */
export async function collectBinaryCandidates(env: RtEnv): Promise<{ files: Array<{ path: string; content_hash: string }>; truncated: boolean }> {
	let cursor: string | undefined;
	const files: Array<{ path: string; content_hash: string }> = [];
	let truncated = false;
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const r = await listFullChanges(env, cursor);
		for (const e of r.entries) if (isCandidate(e)) files.push({ path: e.path, content_hash: e.content_hash });
		cursor = r.cursor;
		if (files.length >= MAX_FILES_FOR_BINARY_DEDUP) {
			truncated = true;
			break;
		}
		if (!r.has_more) break;
		if (page === MAX_LIST_PAGES - 1) truncated = true;
	}
	return { files: files.slice(0, MAX_FILES_FOR_BINARY_DEDUP), truncated };
}

/** Group candidate files by content_hash — a Dropbox content_hash match IS a byte-identical
 *  file (it's a whole-file digest), so no threshold/similarity pass is needed the way the
 *  cosine cluster needs SIMILARITY_THRESHOLD. Singleton hashes (nothing else matched) are
 *  dropped, same contract as findDuplicateFiles. */
export function findBinaryDuplicateFiles(files: Array<{ path: string; content_hash: string }>): DuplicateFileCluster[] {
	const byHash = new Map<string, string[]>();
	for (const f of files) {
		const list = byHash.get(f.content_hash) ?? [];
		list.push(f.path);
		byHash.set(f.content_hash, list);
	}
	const clusters: DuplicateFileCluster[] = [];
	for (const paths of byHash.values()) {
		if (paths.length < 2) continue;
		clusters.push({ paths });
	}
	return clusters;
}
