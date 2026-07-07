import { type Fn, fail, ok } from "../registry";

// Wolfram Alpha (api.wolframalpha.com) — computational knowledge answers. Both
// endpoints return text/plain, not JSON: `short` hits the one-line result API;
// `full` hits the richer LLM API. The appid rides the query string.

const SHORT_URL = "https://api.wolframalpha.com/v1/result";
const LLM_URL = "https://www.wolframalpha.com/api/v1/llm-api";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

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
			const p = new URLSearchParams({ appid: env.WOLFRAM_APP_ID });
			if (mode === "full") {
				p.set("input", query);
				const resp = await fetch(`${LLM_URL}?${p}`, { headers: { Accept: "text/plain" } });
				const text = await resp.text().catch(() => "");
				if (!resp.ok) throw new Error(`Wolfram LLM API HTTP ${resp.status}: ${text.slice(0, 300)}`);
				return ok(text.trim() || `No Wolfram Alpha answer for '${query}'.`);
			}
			p.set("i", query);
			const resp = await fetch(`${SHORT_URL}?${p}`, { headers: { Accept: "text/plain" } });
			const text = await resp.text().catch(() => "");
			if (!resp.ok) throw new Error(`Wolfram result API HTTP ${resp.status}: ${text.slice(0, 300)}`);
			return ok(text.trim() || `No Wolfram Alpha answer for '${query}'.`);
		} catch (e) {
			return fail(`wolfram (${mode}) failed: ${errMsg(e)}`);
		}
	},
};
