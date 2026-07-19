// Leaf logic for the `mychart-reconcile-plan` durable op (registry.ts): the LLM-drafted half of
// #1005's cross-org reconciliation the issue's own sketch deferred — turns one already-detected
// MyChartConflict (mychart.ts's crossOrgMedicationAllergyConflicts) into a plain-English
// discrepancy summary + a templated outreach message the human can review and forward to a
// provider, PAUSED behind an `ask` gate before any of it reaches mail's send path (registry.ts
// never wires this op's sink to mail_send/mail_draft — see caps.ts's mychartOutreachSink).
//
// caps.llm.summarize is used ONLY to condense the plain facts below into readable prose — its
// system prompt (ai.ts's llm()) is a fixed "summarize the following content concisely and
// faithfully", and the facts text is itself the ONLY input, so there's nothing here for the
// model to invent, diagnose, or embellish beyond what crossOrgMedicationAllergyConflicts already
// found. The outreach message wraps that summary in the same "may overlap — verify with your
// provider" non-diagnostic framing detectMychartConflictDrops already uses (_agenda.ts) — never a
// claim, always a prompt to check.
import type { Caps } from "@suxos/lib";

export type MychartConflictInput = { medOrg: string; medId: string; medName: string; allergyOrg: string; allergyId: string; allergySubstance: string };
export type MychartOutreachPlanItem = MychartConflictInput & { summary: string; draftMessage: string };

/** Draft one conflict's plain-English summary + outreach message. Returns null for a malformed
 *  item (any field missing/empty) rather than throwing — one bad item must not sink the whole
 *  batch's `map` fan-out. */
export async function proposeMychartOutreach(c: MychartConflictInput, caps: Caps): Promise<MychartOutreachPlanItem | null> {
	if (!c?.medOrg || !c?.medId || !c?.medName || !c?.allergyOrg || !c?.allergyId || !c?.allergySubstance) return null;
	const facts = `A medication named "${c.medName}" is active on file at ${c.medOrg}. An allergy to "${c.allergySubstance}" is on file at ${c.allergyOrg}. These two records may textually overlap, but this has not been clinically verified — only a provider can confirm whether it's a real concern.`;
	const summarized = (await caps.llm.summarize(facts)).trim();
	const summary = summarized || facts;
	const draftMessage = `Hi — I wanted to flag a possible discrepancy between my charts: ${summary} Could you please confirm whether this is a concern? Thank you.`;
	return { ...c, summary, draftMessage };
}

/** Drop the non-actionable `null`s a per-conflict propose pass leaves behind. */
export function compactMychartOutreachPlan(items: Array<MychartOutreachPlanItem | null>): MychartOutreachPlanItem[] {
	return items.filter((i): i is MychartOutreachPlanItem => i !== null);
}
