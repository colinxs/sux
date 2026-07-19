import { type Fn, type RtEnv, failWith, ok } from "../registry";
import { runVerb } from "./run";
import type { TriageMsg } from "./_mail_triage";
import { errMsg, oj } from "./_util";

// mail_triage_plan — the entrypoint for the DURABLE, human-approved sibling of mail_triage:
// fetch a page of inbox messages, then start a `run` of the `mail-triage-plan` op
// (op-engine/registry.ts), which classifies each message with _mail_triage's existing rules
// into a batch of proposed REVERSIBLE label:add writes and PAUSES for one human "apply these
// label changes?" approval before applying any of them. Unlike mail_triage (which can act
// autonomously once MAIL_TRIAGE_ACT is armed), this path never auto-applies anything — every
// batch survives isolate eviction and multi-day pauses, and is answerable/cancellable via the
// `run` front verb.
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

// Read as a truthy toggle ("0"/"false"/"off"/empty → off) rather than mere presence, so an
// explicit MAIL_TRIAGE_PLAN_ENABLED=0 stays off — mirrors _mail_triage.ts's flagOn.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The durable, human-approved triage-plan auto-start loop may run at all. Unset → dormant (no-op). */
export const hasMailTriagePlan = (env: RtEnv): boolean => flagOn(env.MAIL_TRIAGE_PLAN_ENABLED);

export const mail_triage_plan: Fn = {
	name: "mail_triage_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"Durable inbox-triage-with-approval: fetches a page of inbox messages and starts a durable run (op:'mail-triage-plan') that classifies each with mail_triage's existing rules into proposed REVERSIBLE label:add changes ONLY (never archive/unarchive/undelete/draft-reply, never a sensitive health/finance/insurance/gov sender unless the label is 'important'), then PAUSES for one human 'apply these label changes?' approval before applying anything. Nothing is ever auto-applied. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"apply these label changes?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate applies nothing after 24h (fails closed).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			mailbox: { type: "string", description: "Source mailbox role to scan (default inbox)." },
			max: { type: "integer", minimum: 1, maximum: 100, description: "Max messages to classify this batch (default 25)." },
			unread: { type: "boolean", description: "Only consider unread messages (default true)." },
		},
	},
	run: async (env, a) => {
		try {
			const mail = await import("../mail-mcp");
			const searchTool = mail.MAIL_TOOLS.find((t) => t.name === "mail_search");
			if (!searchTool) return failWith("upstream_error", "mail_search tool not found");
			const mailbox = a?.mailbox ? String(a.mailbox) : "inbox";
			const max = numClamp(a?.max, 1, 100, 25);
			const unread = a?.unread !== false;
			const r = await searchTool.run(env, { mailbox, ...(unread ? { unread: true } : {}), limit: max });
			if (r.isError) return failWith("upstream_error", r.content?.[0]?.text ?? "mail_search failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			const messages: TriageMsg[] = (parsed.emails ?? []).map((e: any) => ({
				id: String(e?.id ?? ""),
				from: e?.from,
				subject: e?.subject,
				preview: e?.preview,
				mailboxes: Array.isArray(e?.labels) ? e.labels : undefined,
			}));
			if (!messages.length) return ok(oj({ mailbox, scanned: 0, note: "no messages to triage" }));
			const res = await runVerb({ op: "mail-triage-plan", input: messages, mode: "durable" }, env);
			return ok(
				oj({
					mailbox,
					scanned: messages.length,
					...res,
					note: 'durable run started — classifies each message, then pauses for a human \'apply these label changes?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"apply these label changes?"}` ({approved:true|false}).',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
