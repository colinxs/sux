import { type Fn, fail, ok } from "../registry";
import { hasAI, llm } from "../ai";

// Named tones get a tailored instruction; any other string is used verbatim.
const TONE_GUIDE: Record<string, string> = {
	nonviolent:
		"Nonviolent Communication (NVC): observations without evaluation, feelings, needs, and clear requests. Remove blame, judgment, and demands. Keep it honest and specific, not passive.",
	polite: "warm, courteous, and considerate, with softened requests and appreciation",
	professional: "clear, concise, and businesslike, without slang or emotional language",
	friendly: "casual, warm, and approachable, as if writing to a friend",
	assertive: "direct and confident, stating needs and boundaries plainly without aggression",
	empathetic: "understanding and validating, acknowledging the other person's perspective and feelings",
	formal: "formal register: no contractions, precise word choice, respectful distance",
	concise: "as terse as possible while preserving meaning; cut filler",
	diplomatic: "tactful and even-handed, de-escalating and acknowledging multiple viewpoints",
};

export const tone: Fn = {
	name: "tone",
	description:
		"Rewrite text in a given tone while preserving its meaning. `tone` defaults to 'nonviolent' (Nonviolent Communication). " +
		`Named tones: ${Object.keys(TONE_GUIDE).join(", ")}. Any other string is used as a free-form tone instruction. Returns only the rewritten text. Uses Workers AI.`,
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to transform." },
			tone: { type: "string", description: "Target tone (named or free-form). Default 'nonviolent'.", default: "nonviolent" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail('Workers AI binding not configured (add "ai" to wrangler).');
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide non-empty `text`.");
		const toneName = String(args?.tone ?? "nonviolent").trim() || "nonviolent";
		const guide = TONE_GUIDE[toneName.toLowerCase()] ?? `a ${toneName} tone`;
		try {
			const out = await llm(
				env,
				`You rewrite text to change its tone while preserving the original meaning, facts, and intent. ` +
					`Target tone: ${guide}. Output ONLY the rewritten text — no preamble, quotes, or commentary.`,
				text.slice(0, 12_000),
				Math.min(2048, Math.ceil(text.length / 2) + 256),
			);
			return ok(out || "(empty result)");
		} catch (e) {
			return fail(`tone failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
