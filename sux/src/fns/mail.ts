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
	semantic: "mail_semantic",
	mailboxes: "mail_mailboxes",
	mailbox_create: { tool: "mail_mailbox", inject: { action: "create" } },
	mailbox_rename: { tool: "mail_mailbox", inject: { action: "rename" } },
	mailbox_delete: { tool: "mail_mailbox", inject: { action: "delete" } },
	identities: "mail_identities",
	draft: "mail_draft",
	send: "mail_send",
	scheduled: "mail_scheduled",
	unschedule: "mail_unschedule",
	upload: "mail_upload",
	attachments: "mail_attachments",
	archive: "mail_archive",
	move: "mail_move",
	label_add: { tool: "mail_label", inject: { add: true } },
	label_remove: { tool: "mail_label", inject: { add: false } },
	quota: "mail_quota",
	vacation_get: { tool: "mail_vacation", inject: { action: "get" } },
	vacation_set: { tool: "mail_vacation", inject: { action: "set" } },
	masked_list: { tool: "mail_masked", inject: { action: "list" } },
	masked_create: { tool: "mail_masked", inject: { action: "create" } },
	masked_disable: { tool: "mail_masked", inject: { action: "disable" } },
	masked_enable: { tool: "mail_masked", inject: { action: "enable" } },
	masked_delete: { tool: "mail_masked", inject: { action: "delete" } },
	push_subscribe: { tool: "mail_push", inject: { action: "subscribe" } },
	push_unsubscribe: { tool: "mail_push", inject: { action: "unsubscribe" } },
	push_status: { tool: "mail_push", inject: { action: "status" } },
};

export const mail: Fn = namespaceFn({
	name: "mail",
	description:
		"Fastmail email through the one /mcp connector. {action, ...args}: search·read·thread·semantic·mailboxes·mailbox_create·mailbox_rename·mailbox_delete·identities·draft·send·scheduled·unschedule·upload·attachments·archive·move·label_add·label_remove·quota·vacation_get·vacation_set·masked_list·masked_create·masked_disable·masked_enable·masked_delete·push_subscribe·push_unsubscribe·push_status. Each action's remaining args are that mail_* tool's own — e.g. mail({action:'send', to, subject, text}), mail({action:'move', ids:['msg1'], mailbox:'junk'}) — the target arg is `mailbox` (role like inbox/archive/junk/trash, a display name, or a raw id), not `mailboxId`/`to`; mail({action:'mailbox_create', name:'Follow-up'}), mail({action:'mailbox_delete', mailbox:'Follow-up', force:true}); mail({action:'label_add', ids:['msg1'], label:'junk'}) / mail({action:'label_remove', ids:['msg1'], label:'junk'}) toggles a reversible keyword — mail({action:'search', label:'junk'}) finds which messages currently carry one; mail({action:'semantic', q:'what did the dentist say'}) finds messages by meaning (Workers-AI embeddings) rather than mail_search's exact-text filter; mail({action:'attachments', items:[{blobId}], dest:'store'}) exports attachments server-side to R2/Dropbox; mail({action:'push_subscribe'}) — arms near-real-time triage (Fastmail pushes on new mail instead of the ~5min cron wait); check readiness with mail({action:'push_status'}). send/mailbox_delete STAGE a preview by default (re-call with commit_token, or force:true to apply in one shot). Calendars/tasks are the 'calendar' verb; contacts the 'contact' verb.",
	tools: () => MAIL_TOOLS,
	actions: MAIL_ACTIONS,
	// Declare the array-shaped params so MCP clients serialize them through the front door intact
	// (an untyped array under additionalProperties:true was being dropped — mail_move/archive `ids[]`).
	properties: { ids: { type: "array", items: { type: "string" }, description: "Email ids (archive/move)." }, items: { type: "array", items: { type: "object" }, description: "Batch items (attachments export)." } },
});
