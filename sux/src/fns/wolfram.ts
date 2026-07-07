import { type Fn, fail, ok } from "../registry";

// Wolfram Alpha (api.wolframalpha.com) — computational knowledge answers. Both
// endpoints return text/plain, not JSON: `short` hits the one-line result API;
// `full` hits the richer LLM API. The appid rides the query string.

const SHORT_URL = "https://api.wolframalpha.com/v1/result";
const LLM_URL = "https://www.wolframalpha.com/api/v1/llm-api";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

// The full LLM API — richer, section-structured text. Used directly for mode:full,
// and as the fallback when the short API can't produce a one-line result.
async function fullAnswer(appid: string, query: string): Promise<string> {
	const p = new URLSearchParams({ appid, input: query });
	const resp = await fetch(`${LLM_URL}?${p}`, { headers: { Accept: "text/plain" } });
	const text = await resp.text().catch(() => "");
	if (!resp.ok) throw new Error(`Wolfram LLM API HTTP ${resp.status}: ${text.slice(0, 300)}`);
	return text.trim();
}

export const wolfram: Fn = {
	name: "wolfram",
	description:
		"Wolfram Alpha (official, free) — computational knowledge answers to a natural-language `query`. " +
		"`mode`: short (one-line plain-text result) or full (richer LLM-API text with sections). " +
		"Needs WOLFRAM_APP_ID (free at developer.wolframalpha.com). Returns plain text.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Natural-language question, e.g. \"distance from earth to moon\"." },
			mode: { type: "string", enum: ["short", "full"], default: "short" },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (env, args) => {
		if (!env.WOLFRAM_APP_ID) return fail("Wolfram Alpha not configured (WOLFRAM_APP_ID). Free key at developer.wolframalpha.com.");

		const query = String(args?.query ?? "").trim();
		if (!query) return fail("`query` is required.");
		const mode = args?.mode === "full" ? "full" : "short";

		try {
			if (mode === "full") {
				return ok((await fullAnswer(env.WOLFRAM_APP_ID, query)) || `No Wolfram Alpha answer for '${query}'.`);
			}
			// Short mode: the result API answers with 501 ("did not understand your
			// input") whenever there is no one-line result — that's a normal outcome,
			// not a failure, so fall back to the full LLM API rather than erroring.
			const p = new URLSearchParams({ appid: env.WOLFRAM_APP_ID, i: query });
			const resp = await fetch(`${SHORT_URL}?${p}`, { headers: { Accept: "text/plain" } });
			const text = (await resp.text().catch(() => "")).trim();
			if (resp.ok && text) return ok(text);
			if (resp.status === 501 || !text) {
				try {
					const full = await fullAnswer(env.WOLFRAM_APP_ID, query);
					if (full) return ok(full);
				} catch {
					// Full fallback also failed — degrade to a soft "no answer" below.
				}
				return ok(`No short Wolfram Alpha answer for '${query}'.`);
			}
			throw new Error(`Wolfram result API HTTP ${resp.status}: ${text.slice(0, 300)}`);
		} catch (e) {
			return fail(`wolfram (${mode}) failed: ${errMsg(e)}`);
		}
	},
};
