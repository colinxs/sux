import { type Fn, fail, ok } from "../registry";
import { hasAI, llm, textFromUrlOr } from "../ai";

export const summarize: Fn = {
	name: "summarize",
	description: "Summarize text or a web page with Workers AI. Give `text` or a `url`. style: bullets (default) | paragraph | tldr. max_words caps the output length.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			text: { type: "string" },
			url: { type: "string" },
			style: { type: "string", enum: ["bullets", "paragraph", "tldr"], default: "bullets" },
			max_words: { type: "integer", default: 150 },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail("Workers AI binding not configured (add \"ai\" to wrangler).");
		const input = await textFromUrlOr(env, String(args?.text ?? ""), args?.url ? String(args.url) : undefined);
		if (!input) return fail("Provide `text` or a fetchable `url`.");
		const style = String(args?.style ?? "bullets");
		const maxWords = Number(args?.max_words) || 150;
		const shape = style === "tldr" ? "a single TL;DR sentence" : style === "paragraph" ? "one tight paragraph" : "concise bullet points";
		try {
			const out = await llm(
				env,
				`You are a precise summarizer. Produce ${shape}. Stay under ${maxWords} words. No preamble.`,
				input.slice(0, 24_000),
				Math.ceil(maxWords * 2),
			);
			return ok(out || "(empty summary)");
		} catch (e) {
			return fail(String((e as Error).message ?? e));
		}
	},
};
