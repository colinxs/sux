import { type Fn } from "../registry";
import { MAIL_TOOLS } from "../mail-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";

// The mail-flow slice of MAIL_TOOLS (calendar/tasks live under `calendar`, contacts under
// `contact`, and the raw `jmap` conduit stays a universal leaf via `fn`).
// mail_masked/mail_vacation carry their own action arg, so those flatten into
// verb-level actions that re-inject the inner one.
export const MAIL_ACTIONS: Record<string, Dispatch> = {
	search: "mail_search",
	read: "mail_read",
	thread: "mail_thread",
	mailboxes: "mail_mailboxes",
	identities: "mail_identities",
	draft: "mail_draft",
	send: "mail_send",
	schedule: "mail_schedule",
	scheduled: "mail_scheduled",
	unschedule: "mail_unschedule",
	upload: "mail_upload",
	archive: "mail_archive",
	move: "mail_move",
	quota: "mail_quota",
	vacation_get: { tool: "mail_vacation", inject: { action: "get" } },
	vacation_set: { tool: "mail_vacation", inject: { action: "set" } },
	masked_list: { tool: "mail_masked", inject: { action: "list" } },
	masked_create: { tool: "mail_masked", inject: { action: "create" } },
	masked_disable: { tool: "mail_masked", inject: { action: "disable" } },
	masked_enable: { tool: "mail_masked", inject: { action: "enable" } },
	masked_delete: { tool: "mail_masked", inject: { action: "delete" } },
};

export const mail: Fn = namespaceFn({
	name: "mail",
	description:
		"Fastmail email through the one /mcp connector. {action, ...args}: search·read·thread·mailboxes·identities·draft·send·schedule·scheduled·unschedule·upload·archive·move·quota·vacation_get·vacation_set·masked_list·masked_create·masked_disable·masked_enable·masked_delete. Each action's remaining args are that mail_* tool's own — e.g. mail({action:'send', to, subject, text}), mail({action:'move', ids:['msg1'], mailbox:'junk'}) — the target arg is `mailbox` (role like inbox/archive/junk/trash, a display name, or a raw id), not `mailboxId`/`to`. send STAGES a preview by default (re-call with commit_token, or force:true to send in one shot). Calendars/tasks are the 'calendar' verb; contacts the 'contact' verb.",
	tools: () => MAIL_TOOLS,
	actions: MAIL_ACTIONS,
});
