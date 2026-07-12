import { type Fn, fail, ok } from "../registry";
import { appendFeedback } from "./_feedback";

export const suggest: Fn = {
	name: "suggest",
	description:
		"Log a feature/capability request for the sux server to its server-side feedback log (KV). Use when a tool is missing, an option would help, or a workflow would be nicer. Persisted and readable at GET /feedback?type=suggest. Pair of `issue`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The request, concisely — what capability is wanted and why it would help." },
			tool: { type: "string", description: "Optional: the sux tool name the request is about (enables GET /feedback?tool= filtering)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide `text` describing the request.");
		const tool = String(args?.tool ?? "").trim() || undefined;
		const { total, at } = await appendFeedback(env, "suggest", text, tool);
		return ok(`Logged suggestion #${total} at ${new Date(at).toISOString()}. Read the backlog: GET /feedback?type=suggest`);
	},
};
