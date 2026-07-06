import { type Fn, fail, ok } from "../registry";
import { appendFeedback } from "./_feedback";

export const issue: Fn = {
	name: "issue",
	description:
		"Log a bug/issue with the sux server to its server-side feedback log (KV). Use when a tool errors, returns wrong output, or a capability is missing. Persisted and readable at GET /feedback?type=issue. Pair of `suggest`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The problem, concisely — what tool, what happened, expected vs actual." },
			tool: { type: "string", description: "Optional: the sux tool name the issue is about (enables GET /feedback?tool= filtering)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide `text` describing the issue.");
		const tool = String(args?.tool ?? "").trim() || undefined;
		const { total, at } = await appendFeedback(env, "issue", text, tool);
		return ok(`Logged issue #${total} at ${new Date(at).toISOString()}. Read the backlog: GET /feedback?type=issue`);
	},
};
