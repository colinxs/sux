import { type Fn } from "../registry";
import { MAIL_TOOLS } from "../mail-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";

export const CONTACT_ACTIONS: Record<string, Dispatch> = {
	search: "contact_search",
	get: "contact_get",
	semantic: "contact_semantic",
	create: "contact_create",
	update: "contact_update",
	delete: "contact_delete",
};

export const contact: Fn = namespaceFn({
	name: "contact",
	description:
		"Fastmail contacts (JMAP ContactCard) through the one /mcp connector. {action, ...args}: search·get·semantic·create·update·delete. Each action's remaining args are that contact_* tool's own — e.g. contact({action:'search', query:'ada'}), contact({action:'semantic', q:'who do I know at that hospital'}) finds contacts by meaning (Workers-AI embeddings) rather than contact_search's exact-text filter, contact({action:'create', name, emails}).",
	tools: () => MAIL_TOOLS,
	actions: CONTACT_ACTIONS,
});
