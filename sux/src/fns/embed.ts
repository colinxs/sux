import { type Fn, fail, ok } from "../registry";
import { hasAI, MODELS } from "../ai";

export const embed: Fn = {
	name: "embed",
	description: "Embed text into vectors with Workers AI (bge-base-en-v1.5, 768-dim). Pass `text` (string) or `texts` (array — broadcast). Returns { dims, vectors }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			text: { type: "string" },
			texts: { type: "array", items: { type: "string" } },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail("Workers AI binding not configured (add \"ai\" to wrangler).");
		const list = Array.isArray(args?.texts) ? args.texts.map(String) : args?.text ? [String(args.text)] : [];
		if (!list.length) return fail("Provide `text` or `texts`.");
		if (list.length > 100) return fail("Cap of 100 texts per call.");
		try {
			const r = await (env as any).AI.run(MODELS.embed, { text: list });
			const vectors: number[][] = r?.data ?? [];
			return ok(JSON.stringify({ model: MODELS.embed, dims: vectors[0]?.length ?? 0, count: vectors.length, vectors }));
		} catch (e) {
			return fail(`embed failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
