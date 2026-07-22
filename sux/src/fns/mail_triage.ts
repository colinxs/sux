import { type Fn, failWith, ok } from "../registry";
import { defaultDeps, hasMailTriage, runTriage } from "./_mail_triage";
import { bulkUndo, readTriageEntries } from "./_mail_triage_log";
import { errMsg, oj } from "./_util";

// mail_triage — the manual + cron entrypoint for the mail-triage bot. It orchestrates the
// existing mail verbs (mail_search + moveMessages/labelMessages + mail_draft) through a classify →
// confidence-gate → act → log → digest loop. DORMANT unless MAIL_TRIAGE_ENABLED is set, and
// suggest-only until MAIL_TRIAGE_ACT is ALSO set (see _mail_triage.ts). The auto-act allow-list
// is exactly label:add / archive / unarchive / undelete — archive (the one attention-reducing op)
// only above the high archive-confidence bar — plus draft-reply, which stages a reply DRAFT for a
// personal message that asks for one and NEVER sends. Never a junk-move, label-remove, delete, or
// send. The same run() is invoked once daily by the cron tick.
export const mail_triage: Fn = {
	name: "mail_triage",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"Autonomous mail triage: classify inbox messages and (when armed) act with REVERSIBLE ops ONLY — add a label, archive, unarchive, undelete — plus draft-reply, which stages a suggested reply DRAFT (to Drafts, for your review) for a personal message that asks for a reply and NEVER sends. NEVER a junk-move, label-remove, delete, or send. Archiving (the one op that hides mail) fires only when highly confident; below that bar a declutter guess is labeled in place instead. action:'run' (default) processes new/unseen messages once (idempotent per message); 'undo' reverses a whole cycle by its cycle_id (moves/labels only — staged drafts are left for you to send or delete); 'log' reads the action log. Pass sweep_backlog:true to page through the EXISTING backlog (already-read mail included by default) instead of just the newest page — still reversible-only, and strictly LABEL-only: a sweep never stages reply drafts (stale reply cues in old mail suggest a `personal` label instead). DORMANT unless MAIL_TRIAGE_ENABLED is set; suggest-only (no actions) until MAIL_TRIAGE_ACT is also set. Pass dry_run:true to force suggest-only. Each cycle appends a did/suggests/undo digest to the vault Daily note.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["run", "undo", "log"], default: "run", description: "run a cycle, undo a cycle (needs cycle_id), or read the log." },
			mailbox: { type: "string", description: "Source mailbox role to triage (default inbox)." },
			max: { type: "integer", minimum: 1, maximum: 100, description: "Max messages to process this cycle (default 25; with sweep_backlog this is the total across all pages)." },
			dry_run: { type: "boolean", description: "Force suggest-only: classify + digest, mutate nothing (even if MAIL_TRIAGE_ACT is set)." },
			unread: { type: "boolean", description: "Only consider unread messages (default true, or false when sweep_backlog is set). Pass false to also scan read mail." },
			sweep_backlog: { type: "boolean", description: "Sweep the existing backlog: page through search results (instead of just the newest page) until the mailbox is exhausted, `max` is reached, or the budget runs out. Still reversible-only (same classify to confidence-gate to act to log loop)." },
			cycle_id: { type: "string", description: "Override the cycle id (for undo, or deterministic/idempotent runs)." },
			budget_ms: { type: "integer", description: "Self-imposed wall-clock budget for the loop (cron bypasses FN_DEADLINE_MS)." },
			limit: { type: "integer", minimum: 1, maximum: 500, description: "action:'log' — how many log entries to return." },
		},
	},
	run: async (env, a) => {
		// Fail-closed master gate: with MAIL_TRIAGE_ENABLED unset the entire feature is a no-op.
		if (!hasMailTriage(env)) {
			return ok(oj({ dormant: true, note: "mail_triage is disabled. Set MAIL_TRIAGE_ENABLED to run classify+suggest+digest; additionally set MAIL_TRIAGE_ACT to allow reversible moves. Nothing happens until the flag is set." }));
		}
		const action = String(a?.action ?? "run");
		try {
			if (action === "log") {
				const entries = await readTriageEntries(env, { cycle: a?.cycle_id ? String(a.cycle_id) : undefined, limit: a?.limit });
				return ok(oj({ count: entries.length, entries }));
			}
			if (action === "undo") {
				if (!a?.cycle_id) return failWith("bad_input", "mail_triage undo needs a `cycle_id` (the undo handle from a digest or a run report).");
				const res = await bulkUndo(env, String(a.cycle_id));
				return ok(oj(res));
			}
			const deps = await defaultDeps();
			const report = await runTriage(env, { mailbox: a?.mailbox ? String(a.mailbox) : undefined, max: a?.max, dry_run: a?.dry_run === true, cycle_id: a?.cycle_id ? String(a.cycle_id) : undefined, budget_ms: a?.budget_ms, unread: typeof a?.unread === "boolean" ? a.unread : undefined, sweep_backlog: a?.sweep_backlog === true }, deps);
			return ok(oj(report));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
