import { type Fn, fail, ok } from "../registry";
import { hasAI, llm } from "../ai";

export const grammar: Fn = {
	name: "grammar",
	description:
		"Correct grammar, spelling, and punctuation in text without changing its meaning, tone, or style. " +
		"By default returns only the corrected text; set `explain: true` to also list the changes made. Uses Workers AI.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to correct." },
			explain: { type: "boolean", description: "If true, append a brief list of the corrections after the fixed text.", default: false },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail('Workers AI binding not configured (add "ai" to wrangler).');
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide non-empty `text`.");
		const explain = args?.explain === true;
		const system = explain
			? "You are a copy editor. Fix grammar, spelling, and punctuation without changing meaning, tone, or word choice beyond what is needed. " +
				"Output the corrected text, then a line '---', then a short bulleted list of the changes you made."
			: "You are a copy editor. Fix grammar, spelling, and punctuation without changing meaning, tone, or word choice beyond what is needed. " +
				"Output ONLY the corrected text — no preamble, quotes, or commentary.";
		try {
			const out = await llm(env, system, text.slice(0, 12_000), Math.min(2048, Math.ceil(text.length / 2) + 256));
			return ok(out || "(empty result)");
		} catch (e) {
			return fail(`grammar failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
