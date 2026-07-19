// Leaf logic for the `files-consolidate-plan` durable op (registry.ts): turns a batch of
// _files_consolidate.ts-detected duplicate-file CANDIDATE clusters (paths only —
// files_semantic's embeddings already did the similarity work upstream) into a batch of
// proposed, REVERSIBLE relocations — nothing else. Deliberately non-destructive, mirroring
// every other consolidate/reconcile leaf's bar: the canonical (lexicographically-first) path
// is left untouched, every other member is proposed to MOVE into a parallel
// `/Archive/Duplicates/` tree (caps.ts's filesDuplicatesSink, via the existing Mode-B
// moveFull primitive) — never a files_delete, so a wrong duplicate judgment is always
// undoable by moving the file back to its original path. A plain path transform needs no
// `caps` at all, so this stays a pure leaf, unlike vault-consolidate-plan's content-merging
// propose (which needs caps.store for suxlib's reconcile).

export type FileClusterInput = { paths: string[] };
export type FileDuplicatePlanItem = { keep: string; archives: string[]; moves: Array<{ from: string; to: string }> };

const ARCHIVE_ROOT = "/Archive/Duplicates";

/** Deterministic canonical pick: the lexicographically-first path always wins the "keep"
 *  slot — no external tie-break state needed, so replay (and two independent runs over the
 *  same group) always agree. Mirrors _vault_consolidate_plan.ts's canonicalOrder. */
function canonicalOrder(paths: string[]): [keep: string, archives: string[]] {
	const sorted = [...paths].sort();
	return [sorted[0], sorted.slice(1)];
}

/** Propose one cluster's relocation: every non-canonical member moves to
 *  `/Archive/Duplicates/<its own original absolute path>` — preserving the source folder
 *  structure under the archive root avoids destination collisions between same-named files
 *  from different folders, and keeps the move trivially reversible (move it back to `from`).
 *  Returns null for a malformed cluster (fewer than 2 paths) rather than throwing — one bad
 *  item must not sink the whole batch's `map` fan-out. */
export function proposeFileDuplicate(c: FileClusterInput): FileDuplicatePlanItem | null {
	if (!c?.paths || c.paths.length < 2) return null;
	const [keep, archives] = canonicalOrder(c.paths);
	const moves = archives.map((from) => ({ from, to: `${ARCHIVE_ROOT}${from}` }));
	return { keep, archives, moves };
}

/** Drop the non-actionable `null`s a per-cluster propose pass leaves behind. */
export function compactFileDuplicatePlan(items: Array<FileDuplicatePlanItem | null>): FileDuplicatePlanItem[] {
	return items.filter((i): i is FileDuplicatePlanItem => i !== null);
}
