import { type Fn } from "../registry";
import { MAIL_TOOLS } from "../mail-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";

// The calendar + tasks + raw-CalDAV slice of MAIL_TOOLS. This is how `caldav` (NOT a
// universal leaf) becomes reachable on the one /mcp connector.
export const CALENDAR_ACTIONS: Record<string, Dispatch> = {
	list: "cal_list",
	events: "cal_events",
	search: "cal_search",
	create: "cal_create",
	update: "cal_update",
	delete: "cal_delete",
	task_list: "task_list",
	task_create: "task_create",
	task_update: "task_update",
	task_complete: "task_complete",
	task_delete: "cal_delete",
	caldav: "caldav",
};

export const calendar: Fn = namespaceFn({
	name: "calendar",
	description:
		"Fastmail calendars + tasks (CalDAV) through the one /mcp connector. {action, ...args}: list·events·search·create·update·delete·task_list·task_create·task_update·task_complete·task_delete·caldav (raw). Each action's remaining args are that cal_*/task_* tool's own — e.g. calendar({action:'events', calendar, start, end}), calendar({action:'search', query, start?, end?, calendars?}) fans out across calendars for a keyword instead of naming one, calendar({action:'create', calendar, summary, start, end}), calendar({action:'delete', href, confirm:true}), calendar({action:'task_delete', href, confirm:true}) — href comes from create's/events'/list's own response, not a guessable uid.",
	tools: () => MAIL_TOOLS,
	actions: CALENDAR_ACTIONS,
});
