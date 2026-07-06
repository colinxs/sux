import { type Fn, fail, ok } from "../registry";
import { hasAI, llm, textFromUrlOr } from "../ai";
import { kagiTool } from "../kagi";

export const summarize: Fn = {
	name: "summarize",
	description:
		"Summarize text or a web page. Dispatches on input: a `url` (with the Kagi gateway configured) goes to Kagi's Universal Summarizer — which handles long documents and YouTube natively; `text` (or no Kagi key) uses Workers AI. style: bullets (default) | paragraph | tldr. max_words caps the Workers-AI output length.",
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
		const url = args?.url ? String(args.url) : undefined;
		const style = String(args?.style ?? "bullets");

		// Julia-style dispatch: URLs go to Kagi's Universal Summarizer when the
		// gateway is configured — better existing tooling than stripping the page
		// ourselves and truncating 24k chars into a 3B model. Any failure falls
		// through to the Workers-AI path so summarize never gets worse.
		if (url && env.KAGI_API_KEY) {
			try {
				const r = await kagiTool(env, "kagi_summarizer", { url, summary_type: style === "tldr" ? "takeaway" : "summary" });
				const text = r?.content?.[0]?.text?.trim();
				if (text && !r?.isError) return ok(text);
			} catch {
				/* fall through to Workers AI */
			}
		}

		if (!hasAI(env)) return fail('Workers AI binding not configured (add "ai" to wrangler).');
		const input = await textFromUrlOr(env, String(args?.text ?? ""), url);
		if (!input) return fail("Provide `text` or a fetchable `url`.");
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
