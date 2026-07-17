import { type Fn } from "../registry";
import { VAULT_TOOLS } from "../vault-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";

export const VAULT_ACTIONS: Record<string, Dispatch> = {
	read: "vault_read",
	list: "vault_list",
	write: "vault_write",
	append: "vault_append",
	edit: "vault_edit",
	delete: "vault_delete",
	capture: "vault_capture",
	batch_append: "vault_batch_append",
	daily_read: "vault_daily_read",
	daily_append: "vault_daily_append",
	backlinks: "vault_backlinks",
	query: "vault_query",
	patch: "vault_patch",
	tags: "vault_tags",
	tasks: "vault_tasks",
	search_body: "vault_search_body",
	semantic: "vault_semantic",
};

export const vault: Fn = namespaceFn({
	name: "vault",
	description:
		"Obsidian vault (git-backed) through the one /mcp connector. {action, ...args}: read·list·write·append·edit·delete(confirm:true)·capture·batch_append·daily_read·daily_append·backlinks·query·patch·tags·tasks·search_body·semantic. Each action's remaining args are that vault_* tool's own — e.g. vault({action:'read', path:'Inbox/x.md'}), vault({action:'write', path, content}). Writes are git commits (history is the undo); delete needs confirm:true.",
	tools: () => VAULT_TOOLS,
	actions: VAULT_ACTIONS,
});
