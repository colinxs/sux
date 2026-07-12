import { type Fn, failWith, ok } from "../registry";
import { defaultDeps, hasMailTriage, runTriage } from "./_mail_triage";
import { bulkUndo, readTriageEntries } from "./_mail_triage_log";
import { errMsg, oj } from "./_util";

// mail_triage — the manual + cron entrypoint for the mail-triage bot. It orchestrates the
// existing mail verbs (mail_search + moveMessages) through a classify → confidence-gate →
// act(reversible-only) → log → digest loop. DORMANT unless MAIL_TRIAGE_ENABLED is set, and
// suggest-only until MAIL_TRIAGE_ACT is ALSO set (see _mail_triage.ts). Never deletes.
// The same run() is invoked once daily by the cron tick in index.ts.
export const mail_triage: Fn = {
	name: "mail_triage",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"Autonomous mail triage: classify inbox messages and (when armed) file them with REVERSIBLE moves only — archive/junk, NEVER delete. action:'run' (default) processes new/unseen messages once (idempotent per message); 'undo' reverses a whole cycle by its cycle_id (the undo handle in the digest); 'log' reads the action log. DORMANT unless MAIL_TRIAGE_ENABLED is set; suggest-only (no moves) until MAIL_TRIAGE_ACT is also set. Pass dry_run:true to force suggest-only. Each cycle appends a did/suggests/undo digest to the vault Daily note.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["run", "undo", "log"], default: "run", description: "run a cycle, undo a cycle (needs cycle_id), or read the log." },
			mailbox: { type: "string", description: "Source mailbox role to triage (default inbox)." },
			max: { type: "integer", minimum: 1, maximum: 100, description: "Max messages to process this cycle (default 25)." },
			dry_run: { type: "boolean", description: "Force suggest-only: classify + digest, mutate nothing (even if MAIL_TRIAGE_ACT is set)." },
			unread: { type: "boolean", description: "Only consider unread messages." },
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
			const report = await runTriage(env, { mailbox: a?.mailbox ? String(a.mailbox) : undefined, max: a?.max, dry_run: a?.dry_run === true, cycle_id: a?.cycle_id ? String(a.cycle_id) : undefined, budget_ms: a?.budget_ms, unread: a?.unread === true }, deps);
			return ok(oj(report));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
