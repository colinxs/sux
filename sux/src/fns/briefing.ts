import { type Fn, failWith, ok } from "../registry";
import { defaultDeps, hasBriefing, hasBriefingStageDrafts, runBriefing } from "./_briefing";
import { errMsg, oj } from "./_util";

// briefing — the manual + cron entrypoint for the morning virtual-assistant digest. It
// fans out READ-ONLY across unread/important mail, calendar, tasks, and bill/deadline cues,
// composes ONE "good morning" digest with a single llm() synthesis, appends it to today's
// Daily note, and (only when armed) STAGES reply drafts to the Drafts folder — NEVER sends.
// DORMANT unless BRIEFING_ENABLED; summarize-and-nudge only (stages zero drafts) until
// BRIEFING_STAGE_DRAFTS is ALSO set. The same run() is invoked once daily by the cron tick.
export const briefing: Fn = {
	name: "briefing",
	surface: "leaf",
	cacheable: false,
	// Stages drafts + appends a note, so not readOnly; but every act is reversible
	// (drafts sit in Drafts, the append is git-reversible) and idempotent per day.
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		"Morning briefing: fans out READ-ONLY across your unread/important mail, calendar, tasks, and bill/deadline cues, and composes ONE high-signal 'good morning' digest. Reply drafts are STAGED to your Drafts folder for approval — NEVER sent. The digest is appended to today's Daily note. action:'run' (default) composes+stages; 'log' points at where past briefings live. DORMANT unless BRIEFING_ENABLED; summarize-and-nudge only (stages zero drafts) until BRIEFING_STAGE_DRAFTS is ALSO set. dry_run:true composes and returns, mutating nothing. Each source (mail/calendar/tasks/bills) degrades independently — an unconfigured one is skipped, never fatal.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["run", "log"], default: "run", description: "run a briefing cycle, or point at where past briefings live." },
			date: { type: "string", description: "ISO date (YYYY-MM-DD) to brief (default today in VAULT_TZ)." },
			sources: { type: "array", items: { type: "string", enum: ["mail", "calendar", "tasks", "bills"] }, description: "Sections to include (default all four; each degrades independently)." },
			max_mail: { type: "integer", minimum: 1, maximum: 50, description: "Cap unread messages scanned (default 10)." },
			horizon_days: { type: "integer", minimum: 0, maximum: 14, description: "Calendar/task look-ahead in days (default 1 = today)." },
			draft: { type: "boolean", description: "Stage reply drafts for flagged mail (default true; needs BRIEFING_STAGE_DRAFTS). false = summarize + nudge only." },
			dry_run: { type: "boolean", description: "Compose + return only; stage nothing (no drafts, no digest write)." },
			cycle_id: { type: "string", description: "Idempotency handle (default briefing::<date>)." },
			limit: { type: "integer", description: "action:'log' — entries to return." },
		},
	},
	run: async (env, a) => {
		// Fail-closed master gate: with BRIEFING_ENABLED unset the entire feature is a no-op.
		if (!hasBriefing(env)) {
			return ok(oj({ dormant: true, note: "briefing is disabled. Set BRIEFING_ENABLED to compose+append a digest (summarize + nudge); additionally set BRIEFING_STAGE_DRAFTS to stage reply drafts to your Drafts folder (never sent). Nothing happens until the flag is set." }));
		}
		const action = String(a?.action ?? "run");
		try {
			if (action === "log") {
				// The durable record is the Daily notes (git-reversible), not a second store — point there.
				return ok(oj({ note: "Past briefings are appended to your Daily notes (Daily/<date>.md), which are git-reversible. Re-run `briefing` to regenerate today's; pass dry_run:true to preview without writing.", stage_drafts_enabled: hasBriefingStageDrafts(env) }));
			}
			const deps = await defaultDeps();
			const report = await runBriefing(
				env,
				{
					date: a?.date ? String(a.date) : undefined,
					sources: Array.isArray(a?.sources) ? a.sources : undefined,
					max_mail: a?.max_mail,
					horizon_days: a?.horizon_days,
					draft: typeof a?.draft === "boolean" ? a.draft : undefined,
					dry_run: a?.dry_run === true,
					cycle_id: a?.cycle_id ? String(a.cycle_id) : undefined,
				},
				deps,
			);
			return ok(oj(report));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
