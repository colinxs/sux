import { type Fn, fail, failWith, ok } from "../registry";
import { errMsg, oj } from "./_util";

// Tavily (api.tavily.com) — LLM-oriented search that returns a synthesized answer
// alongside ranked results. The api_key rides the JSON body of a single POST.

const API = "https://api.tavily.com/search";


function normResult(r: any): Record<string, unknown> {
	return {
		title: r?.title,
		url: r?.url,
		content: r?.content,
		score: typeof r?.score === "number" ? r.score : undefined,
	};
}

export const tavily: Fn = {
	name: "tavily",
	description:
		"Tavily (LLM-oriented web search, free 1k/mo) — returns a synthesized `answer` plus ranked results for a `query`. " +
		"`depth`: basic (fast) or advanced (deeper). Needs TAVILY_API_KEY (free at tavily.com). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Search query." },
			max_results: { type: "integer", minimum: 1, maximum: 20, default: 8 },
			depth: { type: "string", enum: ["basic", "advanced"], default: "basic" },
		},
	},
	cacheable: true,
	ttl: 600,
	run: async (env, args) => {
		if (!env.TAVILY_API_KEY) return failWith("not_configured", "Tavily not configured (TAVILY_API_KEY). Free 1k/mo at tavily.com.");

		const query = String(args?.query ?? "").trim();
		if (!query) return fail("`query` is required.");
		const maxResults = Math.min(20, Math.max(1, Number(args?.max_results) || 8));
		const depth = args?.depth === "advanced" ? "advanced" : "basic";

		try {
			const resp = await fetch(API, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: maxResults, include_answer: true, search_depth: depth }),
			});
			if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
			const j: any = await resp.json();
			const results = (j?.results ?? []).map(normResult);
			return ok(oj({ provider: "tavily", query, answer: j?.answer ?? undefined, count: results.length, results }));
		} catch (e) {
			return fail(`tavily failed: ${errMsg(e)}`);
		}
	},
};
