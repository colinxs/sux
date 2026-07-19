import type { RtEnv } from "../registry";
import { cosine } from "./_embed";
import type { FilesSemanticChunk } from "./_files_semantic";

// Duplicate-FILE detection for #1015: files_semantic (_files_semantic.ts) already embeds
// every small textual Dropbox file (Mode B) for recall's kNN search — this reuses those SAME
// embeddings to cluster near-identical files, rather than reimplementing vault_consolidate_
// plan's basename-heuristic duplicateKey (_consolidate.ts) for a domain where a real content
// signal already exists. A file can be chunked into several pieces (_source.ts's chunkText);
// clustering compares FILES, not chunks, so a file's chunks are first folded into one
// representative vector (their mean) before the pairwise pass — mirrors
// _contact_consolidate.ts's union-find shape, cosine similarity instead of fuzzy-name/email/
// phone matching. Every cluster this produces is only ever a PROPOSAL a human approves or
// rejects (files_consolidate_plan.ts's durable run), never auto-applied.

// A truthy toggle ("0"/"false"/"off"/empty ⇒ off) — mirrors _consolidate.ts/_contact_consolidate.ts's
// flagOn, so an explicit FILES_CONSOLIDATE_ENABLED=0 stays off rather than arming on mere presence.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The file-consolidation sweep may run at all. Unset ⇒ the feature is dormant (no-op). */
export const hasFilesConsolidate = (env: RtEnv): boolean => flagOn(env.FILES_CONSOLIDATE_ENABLED);

export type DuplicateFileCluster = { paths: string[] };

// A near-duplicate file's mean chunk vector needs to cosine well above topKFilesByCosine's
// kNN retrieval bar (files_semantic's own ranking is a "roughly related" bar; this is
// "basically the same file") — high enough that two distinct files sharing boilerplate (a
// common template header) don't false-positive into a cluster.
const SIMILARITY_THRESHOLD = 0.97;
// Bounds the O(n²) cosine pass against files_semantic's own worst case (INDEX_MAX=3000
// chunks, so up to 3000 distinct files) — mirrors _contact_consolidate.ts's MAX_SEEN /
// _cross_semantic.ts's MAX_PAIRS reasoning: cosine over 768-dim vectors is cheap (~1.5s per
// 2M pairs per #785's measurement) but still bounded defensively rather than left uncapped.
const MAX_FILES_FOR_DEDUP = 1500;

/** Fold each file's chunk embeddings into one mean vector — the representative signal a
 *  whole-file duplicate comparison needs (a file's OWN chunks are near-identical to each
 *  other by construction, so their mean stays a faithful stand-in for "this file's content"). */
function meanEmbeddingsByFile(chunks: FilesSemanticChunk[]): Map<string, number[]> {
	const sums = new Map<string, { sum: number[]; n: number }>();
	for (const c of chunks) {
		if (!Array.isArray(c.embedding) || !c.embedding.length) continue;
		const entry = sums.get(c.path);
		if (!entry) {
			sums.set(c.path, { sum: [...c.embedding], n: 1 });
			continue;
		}
		for (let i = 0; i < entry.sum.length && i < c.embedding.length; i++) entry.sum[i] += c.embedding[i];
		entry.n++;
	}
	const out = new Map<string, number[]>();
	for (const [path, { sum, n }] of sums) out.set(path, sum.map((v) => v / n));
	return out;
}

/** Union-find over one file per embedded path (mean chunk vector) — two files land in the
 *  same cluster when their cosine similarity meets `threshold`. Singleton groups (nothing
 *  else matched) are dropped — only real candidate clusters of 2+ come back. Files beyond
 *  MAX_FILES_FOR_DEDUP are left out of THIS pass (a later index update/call picks them up,
 *  mirroring files_semantic's own truncated/incremental contract rather than blocking). */
export function findDuplicateFiles(chunks: FilesSemanticChunk[], threshold = SIMILARITY_THRESHOLD): DuplicateFileCluster[] {
	const byFile = meanEmbeddingsByFile(chunks);
	const paths = [...byFile.keys()].slice(0, MAX_FILES_FOR_DEDUP);
	const n = paths.length;
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};
	const vecs = paths.map((p) => byFile.get(p)!);
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (cosine(vecs[i], vecs[j]) >= threshold) union(i, j);
		}
	}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		const list = groups.get(r) ?? [];
		list.push(i);
		groups.set(r, list);
	}
	const clusters: DuplicateFileCluster[] = [];
	for (const idxs of groups.values()) {
		if (idxs.length < 2) continue;
		clusters.push({ paths: idxs.map((i) => paths[i]) });
	}
	return clusters;
}
