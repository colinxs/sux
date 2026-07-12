import { type Fn } from "../registry";
import { MAIL_TOOLS } from "../mail-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";

// The calendar + tasks + raw-CalDAV slice of MAIL_TOOLS. This is how `caldav` (NOT a
// universal leaf) becomes reachable on the one /mcp connector.
export const CALENDAR_ACTIONS: Record<string, Dispatch> = {
	list: "cal_list",
	events: "cal_events",
	create: "cal_create",
	update: "cal_update",
	delete: "cal_delete",
	task_list: "task_list",
	task_create: "task_create",
	task_update: "task_update",
	task_complete: "task_complete",
	caldav: "caldav",
};

export const calendar: Fn = namespaceFn({
	name: "calendar",
	description:
		"Fastmail calendars + tasks (CalDAV) through the one /mcp connector. {action, ...args}: list·events·create·update·delete·task_list·task_create·task_update·task_complete·caldav (raw). Each action's remaining args are that cal_*/task_* tool's own — e.g. calendar({action:'events', calendar, from, to}), calendar({action:'create', calendar, title, start, end}).",
	tools: () => MAIL_TOOLS,
	actions: CALENDAR_ACTIONS,
});
