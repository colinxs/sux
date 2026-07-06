import { type Fn, fail, ok } from "../registry";
import { appendFeedback } from "./_feedback";

export const suggest: Fn = {
	name: "suggest",
	description:
		"Log a proposed improvement to the sux server to its server-side feedback log (KV). Use for feature ideas, better defaults, new tools, or wrappers worth adding. Persisted and readable at GET /feedback?type=suggest. Pair of `issue`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: { text: { type: "string", description: "The improvement, concisely — what to change and why it helps." } },
	},
	cacheable: false,
	run: async (env, args) => {
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide `text` describing the improvement.");
		const { total, at } = await appendFeedback(env, "suggest", text);
		return ok(`Logged suggestion #${total} at ${new Date(at).toISOString()}. Read the backlog: GET /feedback?type=suggest`);
	},
};
