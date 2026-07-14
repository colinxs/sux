import { type Fn, fail, ok } from "../registry";
import { hasAI, llm, textFromUrlOr } from "../ai";
import { kagiTool } from "../kagi";
import { readability } from "./readability";

/** YouTube URLs — Kagi's summarizer pulls the transcript; the local path has no transcript
 *  access and would only see the page's HTML chrome, so these stay routed to Kagi. */
function isYouTube(url: string): boolean {
	try {
		const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
		return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be";
	} catch {
		return false;
	}
}

/** Extract an article's readable text via the readability fn (region selection, not a blanket
 *  tag-strip). Returns "" on error/empty so callers can fall back to Kagi on a bad extraction. */
async function readableText(env: any, url: string): Promise<string> {
	try {
		const r = await readability.run(env, { url });
		if (r.isError) return "";
		const j = JSON.parse(r.content?.[0]?.text ?? "{}") as { text?: string };
		return String(j?.text ?? "").trim();
	} catch {
		return "";
	}
}

export const summarize: Fn = {
	name: "summarize",
	cost: 2,
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
		const maxWords = Math.min(2000, Math.max(1, Number(args?.max_words) || 150));
		const shape = style === "tldr" ? "a single TL;DR sentence" : style === "paragraph" ? "one tight paragraph" : "concise bullet points";
		const sys = `You are a precise summarizer. Produce ${shape}. Stay under ${maxWords} words. No preamble.`;

		// Kagi's Universal Summarizer over a URL — returns an ok Result on success, or null so the
		// caller falls through to the Workers-AI net. Kagi is a metered per-request endpoint.
		const viaKagi = async (u: string) => {
			try {
				const r = await kagiTool(env, "kagi_summarizer", { url: u, summary_type: style === "tldr" ? "takeaway" : "summary" });
				const text = r?.content?.[0]?.text?.trim();
				if (text && !r?.isError) {
					console.log(`summarize: backend=kagi url=${u}`);
					return ok(text);
				}
				console.warn(`summarize: Kagi returned ${r?.isError ? `an error — ${text || "(no detail)"}` : "an empty summary"}, falling back to Workers AI — ${u}`);
			} catch (e) {
				console.warn(`summarize: Kagi failed, falling back to Workers AI — ${String((e as Error).message ?? e)}`);
			}
			return null;
		};

		// Dispatch by URL shape. YouTube keeps going to Kagi (it pulls the transcript; the local path
		// has none). Ordinary article/blog URLs now try the local readability + Workers-AI path FIRST —
		// Kagi bills per request, and a readability-extracted article summarized by llama-3.2-3b is an
		// even trade for the common case. Kagi stays the fallback net for a weak extraction or a doc
		// longer than the local 24k window (which the local path truncates but Kagi does not).
		if (url && env.KAGI_API_KEY && (isYouTube(url) || !hasAI(env))) {
			const k = await viaKagi(url);
			if (k) return k;
		} else if (url && !isYouTube(url) && hasAI(env)) {
			const extracted = await readableText(env, url);
			// A good regex extraction is 200..24k chars; too short/empty means the parse failed, too
			// long means we'd silently drop the tail — both hand off to Kagi where it earns its cost.
			if (extracted.length >= 200 && extracted.length <= 24_000) {
				try {
					const out = await llm(env, sys, extracted, Math.ceil(maxWords * 2), "summarize");
					if (out?.trim()) {
						console.log(`summarize: backend=workers-ai url=${url}`);
						return ok(out);
					}
				} catch (e) {
					console.warn(`summarize: local extraction summarize failed, trying Kagi — ${String((e as Error).message ?? e)}`);
				}
			}
			if (env.KAGI_API_KEY) {
				const k = await viaKagi(url);
				if (k) return k;
			}
		}

		if (!hasAI(env)) return fail('Workers AI binding not configured (add "ai" to wrangler).');
		try {
			// Generic net: `text` input, or a url the branches above didn't summarize (no Kagi key, or a
			// fall-through). textFromUrlOr throws on upstream 4xx/5xx — fail() (never cached) instead of
			// summarizing a 403/404/consent wall and poisoning the cache for an hour.
			const input = await textFromUrlOr(env, String(args?.text ?? ""), url);
			if (!input) return fail("Provide `text` or a fetchable `url`.");
			const out = await llm(env, sys, input.slice(0, 24_000), Math.ceil(maxWords * 2), "summarize");
			// An empty model output is a failure, not a summary — fail() (never cached)
			// instead of serving "(empty summary)" for the next hour on a transient hiccup.
			if (!out?.trim()) return fail("summarize produced an empty result — retry.");
			console.log(`summarize: backend=workers-ai${url ? ` url=${url}` : ""}`);
			return ok(out);
		} catch (e) {
			return fail(String((e as Error).message ?? e));
		}
	},
};
