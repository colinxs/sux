import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { crossOrgMedicationAllergyConflicts } from "../mychart";
import { hasMychartReconcile } from "./_agenda";
import { errMsg, oj } from "./_util";

// mychart_reconcile_plan — the entrypoint for the LLM-drafted, human-approved half of #1005's
// cross-org reconciliation that issue's own sketch deferred: re-detects every current cross-org
// medication/allergy overlap (mychart.ts's crossOrgMedicationAllergyConflicts — the same detector
// _agenda.ts's mychart_conflict drop already surfaces), then starts a durable run (op:'mychart-
// reconcile-plan') that drafts a plain-English discrepancy summary + a templated outreach message
// per conflict and PAUSES for one human "draft this outreach message?" approval. Approval only
// ever writes the drafts to the vault for the human to read and send by hand — nothing here ever
// reaches mail's send path. Gated behind MYCHART_RECONCILE_ENABLED (same flag _agenda.ts's
// detector uses — fail-closed, and this manual entrypoint stays consistent with whether the
// detector is armed at all).
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export const mychart_reconcile_plan: Fn = {
	name: "mychart_reconcile_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable MyChart cross-org outreach drafting (#1008): re-runs #1005's cross-org medication/allergy overlap check, then starts a durable run (op:'mychart-reconcile-plan') that drafts a plain-English discrepancy summary + a templated 'may overlap — verify with your provider' outreach message per conflict (caps.llm.summarize condenses the plain facts only — never asked to diagnose or invent), then PAUSES for one human 'draft this outreach message?' approval before writing anything. Approval writes each approved draft as a vault note under 'MyChart Outreach/' for you to review and send by hand — this NEVER sends or drafts an email itself. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"draft this outreach message?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate drafts nothing after 24h (fails closed). Needs MYCHART_RECONCILE_ENABLED and 2+ connected, ever-pulled MyChart orgs.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			max: { type: "integer", minimum: 1, maximum: 50, description: "Max conflicts to draft outreach for this batch (default 20)." },
		},
	},
	run: async (env, a) => {
		if (!hasMychartReconcile(env)) {
			return failWith("not_configured", "mychart_reconcile_plan is disabled — set MYCHART_RECONCILE_ENABLED (and AGENDA_ENABLED) to arm it. Nothing detected or drafted until it's set.");
		}
		try {
			const max = numClamp(a?.max, 1, 50, 20);
			const conflicts = await crossOrgMedicationAllergyConflicts(env);
			if (!conflicts.length) return ok(oj({ scanned: 0, note: "no cross-org conflicts found — nothing to draft" }));
			const input = conflicts.slice(0, max);
			const res = await runVerb({ op: "mychart-reconcile-plan", input, mode: "durable" }, env);
			return ok(
				oj({
					scanned: input.length,
					total_conflicts: conflicts.length,
					...res,
					note: 'durable run started — drafts a discrepancy summary + outreach message per conflict, then pauses for a human \'draft this outreach message?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"draft this outreach message?"}` ({approved:true|false}). Approval only writes vault drafts — never sends mail.',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
