import { type Fn, failWith, ok } from "../registry";
import { errMsg, oj } from "./_util";
import { type AgendaOpts, defaultDeps, hasAgenda, runAgenda } from "./_agenda";

// The agenda front verb — run the "figure out what to do" loop on demand (it also rides
// the daily cron). Detects life 'drops' across your mail + calendar, records a reversible
// Todoist-task proposal for each (the W1 kernel — nothing acts until you approve via the
// `proposals` verb), and composes/delivers one calm digest. See fns/_agenda.ts.

export const agenda: Fn = {
	name: "agenda",
	surface: "front",
	cacheable: false,
	description:
		"Figure out what needs you — scan your mail + calendar for 'drops about to happen' (a prescription lapsing, a payment failing, a medical message, an unanswered personal note, an upcoming appointment), record a REVERSIBLE Todoist-task proposal for each (approve/snooze/reject via the `proposals` verb — nothing acts until you say so), and compose ONE calm digest of it all. action:'run' (default) runs a cycle; dry_run:true detects + shows the digest but records/sends nothing. DORMANT unless AGENDA_ENABLED; the digest is appended to today's Daily note, and additionally EMAILED to you when AGENDA_EMAIL is also set. Detectors are cheap rules (no model sorts your mail); each source degrades independently. This is the proactive half of the agent — cut the noise, catch the drop.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["run"], default: "run" },
			date: { type: "string", description: "ISO date (YYYY-MM-DD) to run for (default today in VAULT_TZ)." },
			max_mail: { type: "integer", minimum: 1, maximum: 50, description: "Cap unread messages scanned (default 25)." },
			horizon_days: { type: "integer", minimum: 0, maximum: 14, description: "Calendar look-ahead in days (default 2)." },
			dry_run: { type: "boolean", description: "Detect + compose the digest, but record no proposals and send nothing." },
		},
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	run: async (env, a) => {
		if (!hasAgenda(env)) return failWith("not_configured", "agenda is disabled — set AGENDA_ENABLED to detect life 'drops' and record reversible task proposals (approve them via the `proposals` verb); also set AGENDA_EMAIL to mail the digest to yourself. Fail-closed: nothing runs, and nothing acts until you approve.");
		try {
			const deps = await defaultDeps();
			const opts: AgendaOpts = { date: a?.date, max_mail: a?.max_mail, horizon_days: a?.horizon_days, dry_run: a?.dry_run === true };
			const report = await runAgenda(env, opts, deps);
			return ok(oj(report));
		} catch (e) {
			return failWith("upstream_error", `agenda failed: ${errMsg(e)}`);
		}
	},
};
