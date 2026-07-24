import { type Fn, fail, ok } from "../registry";
import { resolveFeedback } from "./_feedback";

export const feedback_resolve: Fn = {
	name: "feedback_resolve",
	description:
		"Mark a GET /feedback log entry resolved, optionally naming what it's now tracked by (e.g. a GitHub issue URL) — closes the loop when a feedback entry has been reconciled into an external tracker. Address the entry by the `kind`+`at` GET /feedback (or `issue`/`suggest`'s own response) echoed back for it — `at` accepts either the raw epoch-ms number or the ISO string GET /feedback prints. Never deletes: GET /feedback's default view just stops listing it (pass `?resolved=all` to see resolved entries too).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["kind", "at"],
		properties: {
			kind: { type: "string", enum: ["issue", "suggest"], description: "The entry's kind, as returned by GET /feedback." },
			at: { type: ["number", "string"], description: "The entry's `at` — epoch-ms number or the ISO string GET /feedback prints." },
			tracked_by: { type: "string", description: "Optional: what this entry is now tracked by (e.g. a GitHub issue URL)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const kind = String(args?.kind ?? "").trim();
		if (kind !== "issue" && kind !== "suggest") return fail("`kind` must be 'issue' or 'suggest'.");
		const atRaw = args?.at;
		const at = typeof atRaw === "number" ? atRaw : Date.parse(String(atRaw ?? ""));
		if (!Number.isFinite(at)) return fail("Provide the entry's `at` (epoch-ms or ISO string, from GET /feedback).");
		const tracked_by = typeof args?.tracked_by === "string" && args.tracked_by.trim() ? args.tracked_by.trim() : undefined;
		const found = await resolveFeedback(env, kind, at, tracked_by);
		return found ? ok(`Resolved ${kind} entry at ${new Date(at).toISOString()}${tracked_by ? ` (tracked by ${tracked_by})` : ""}.`) : fail(`No unresolved ${kind} entry at ${new Date(at).toISOString()}.`);
	},
};
