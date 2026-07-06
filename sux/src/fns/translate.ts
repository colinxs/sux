import { type Fn, fail, ok } from "../registry";
import { hasAI, MODELS } from "../ai";

export const translate: Fn = {
	name: "translate",
	description: "Translate text with Workers AI (m2m100). to: target language code (e.g. es, fr, de, ja, zh). from: source code (optional; auto-detect otherwise).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "to"],
		properties: {
			text: { type: "string" },
			to: { type: "string", description: "Target language code, e.g. 'es'." },
			from: { type: "string", description: "Source language code (optional)." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail("Workers AI binding not configured (add \"ai\" to wrangler).");
		const text = String(args?.text ?? "");
		const to = String(args?.to ?? "").trim();
		if (!text) return fail("Provide `text`.");
		if (!to) return fail("Provide target language `to`.");
		try {
			const r = await (env as any).AI.run(MODELS.translate, {
				text: text.slice(0, 24_000),
				target_lang: to,
				...(args?.from ? { source_lang: String(args.from) } : {}),
			});
			return ok(String(r?.translated_text ?? "").trim() || "(empty translation)");
		} catch (e) {
			return fail(`translate failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
