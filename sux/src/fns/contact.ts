import { type Fn } from "../registry";
import { MAIL_TOOLS } from "../mail-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";
import { assembleTimeline } from "./_contact_timeline";

export const CONTACT_ACTIONS: Record<string, Dispatch> = {
	search: "contact_search",
	get: "contact_get",
	semantic: "contact_semantic",
	create: "contact_create",
	update: "contact_update",
	delete: "contact_delete",
};

// The `timeline` action is the one that isn't a passthrough to a contact_* tool — it assembles a
// person's cross-source history at QUERY TIME (v5 W8, sux#1288) and is handled in the wrapper
// below, so CONTACT_ACTIONS stays the pure tool-reachability partition the namespace completeness
// guard checks (namespace-fns.test.ts). Its description prose deliberately avoids the
// `contact({action:'timeline', …})` example shape — the dispatcher param-doc lint parses that
// shape as an example call and would look `timeline` up in CONTACT_ACTIONS (where it isn't).
const base = namespaceFn({
	name: "contact",
	description:
		"Fastmail contacts (JMAP ContactCard) through the one /mcp connector. {action, ...args}: search·get·semantic·create·update·delete·timeline. Each dispatch action's remaining args are that contact_* tool's own — e.g. contact({action:'search', query:'ada'}), contact({action:'semantic', q:'who do I know at that hospital'}) finds contacts by meaning (Workers-AI embeddings) rather than contact_search's exact-text filter, contact({action:'create', name, emails}). The query-time `timeline` action (read-only, zero-store) takes a person as name, id, or email and assembles their chronological history by fanning out over mail (messages to/from them), calendar (shared events), vault notes mentioning them, and files — merged, date-sorted oldest→newest, each item cited (mail id / calendar ref / vault path / file path). It writes nothing and materializes no note; a person with no reachable interactions returns an empty timeline, not an error.",
	tools: () => MAIL_TOOLS,
	actions: CONTACT_ACTIONS,
});

export const contact: Fn = {
	...base,
	inputSchema: {
		type: "object",
		additionalProperties: true, // the per-action fields ARE the target contact_* tool's own schema
		required: ["action"],
		properties: {
			action: {
				type: "string",
				enum: [...Object.keys(CONTACT_ACTIONS), "timeline"],
				description: "Which contact operation. The dispatch actions' remaining args are that contact_* tool's own; `timeline` takes name | id | email.",
			},
			name: { type: "string", description: "timeline: the person's name (also contact_create/update)." },
			id: { type: "string", description: "timeline / get / update / delete: the contact id." },
			email: { type: "string", description: "timeline: the person's email address." },
		},
	},
	run: async (env, args) => {
		const action = typeof args?.action === "string" ? args.action.trim() : "";
		if (action === "timeline") return assembleTimeline(env, args);
		return base.run(env, args);
	},
};
