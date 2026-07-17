// Leaf logic for the `vault-consolidate-plan` durable op (registry.ts): turns a batch of
// consolidate-detected duplicate CANDIDATES (paths + already-fetched content, from
// fns/_consolidate.ts's classifyNotes/duplicateKey grouping) into a batch of proposed,
// REVERSIBLE note merges — nothing else. Deliberately non-destructive: the canonical note
// gets the merged content (a `write`), the duplicate note is never deleted, only appended
// with a pointer back to the canonical note (an `append`) — so a wrong merge judgment is
// always undoable by hand (or `git revert`), mirroring `_mail_triage_plan.ts`'s
// "reversible-only" bar for what this durable-op tier is allowed to auto-apply after a
// single human approval.
import { runReconcile, type Caps } from "@suxos/lib";

export type DuplicateClusterInput = { a: string; aContent: string; b: string; key: string; bContent: string };
export type MergePlanItem = { keep: string; archive: string; mergedContent: string; key: string };

/** Deterministic canonical pick: the lexicographically-first path always wins the "keep"
 *  slot and the other becomes "archive" — no external tie-break state needed, so replay
 *  (and two independent runs over the same cluster) always agree. */
function canonicalOrder(a: string, b: string): [keep: string, archive: string] {
	return a <= b ? [a, b] : [b, a];
}

/** Propose one cluster's merge: content-address both notes' current text and faithful-union
 *  them (suxlib's op/reconcile.ts — the same dedup-by-content-block merge assimilate-pdfs
 *  already uses for its PDF pages), so identical passages collapse instead of duplicating,
 *  then resolve the merged handle back to text for the sink to write. Returns null for a
 *  malformed cluster (missing path/content) rather than throwing — one bad item must not
 *  sink the whole batch's `map` fan-out. */
export async function proposeMerge(c: DuplicateClusterInput, caps: Caps): Promise<MergePlanItem | null> {
	if (!c?.a || !c?.b || !c.aContent || !c.bContent) return null;
	const [keep, archive] = canonicalOrder(c.a, c.b);
	const orderedContent = keep === c.a ? [c.aContent, c.bContent] : [c.bContent, c.aContent];
	const handles = await Promise.all(orderedContent.map((text) => caps.store.put(new TextEncoder().encode(text), "text/markdown")));
	const merged = await runReconcile({ mode: "faithful-union" }, handles, caps.store);
	const mergedContent = new TextDecoder().decode(await caps.store.get(merged));
	return { keep, archive, mergedContent, key: c.key };
}

/** Drop the non-actionable `null`s a per-cluster propose pass leaves behind. */
export function compactMergePlan(items: Array<MergePlanItem | null>): MergePlanItem[] {
	return items.filter((i): i is MergePlanItem => i !== null);
}
