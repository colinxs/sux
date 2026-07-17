// Leaf logic for the `mail-triage-plan` durable op (registry.ts): reuses _mail_triage's
// EXISTING classify rules to turn a page of messages into a batch of proposed, reversible
// `label:add` writes — nothing else. Deliberately narrower than _mail_triage's own auto-act
// loop: no archive/unarchive/undelete/draft-reply here (those stay behind their own higher
// confidence bars in the autonomous loop). This durable op has exactly one write kind, so the
// human `ask` gate it pauses on ("apply these label changes?") is simple to reason about —
// approve applies every proposed label, reject/timeout applies none.
import { ACTION_FOR, CONFIDENCE_THRESHOLD, classifyMessage, isAutoActAllowed, isSensitiveSender, type TriageMsg } from "../fns/_mail_triage.js";

export type LabelPlanItem = { id: string; label: string; add: boolean; confidence: number; reason: string };

/** Classify one message into a proposed `label:add`, or null when it doesn't clear every bar:
 *  below CONFIDENCE_THRESHOLD, not a label op (or not on the auto-act allow-list), or a
 *  sensitive sender (health/finance/insurance/gov/legal) — those always need a human's own eyes
 *  on the category tag too, `important` excepted (elevating attention is always the safe direction). */
export function classifyForLabelPlan(msg: TriageMsg): LabelPlanItem | null {
	if (!msg?.id) return null;
	const c = classifyMessage(msg);
	if (c.confidence < CONFIDENCE_THRESHOLD) return null;
	const op = c.op ?? ACTION_FOR[c.label];
	if (!op || op.kind !== "label" || !op.add || !isAutoActAllowed(op)) return null;
	if (isSensitiveSender(String(msg.from ?? "")) && c.label !== "important") return null;
	return { id: msg.id, label: op.label, add: true, confidence: c.confidence, reason: c.reason };
}

/** Drop the non-actionable `null`s a per-message classify pass leaves behind. */
export function compactLabelPlan(items: Array<LabelPlanItem | null>): LabelPlanItem[] {
	return items.filter((i): i is LabelPlanItem => i !== null);
}
