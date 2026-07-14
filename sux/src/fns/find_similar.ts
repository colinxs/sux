import { type Fn, fail, failWith, ok } from "../registry";
import { oj } from "./_util";

type ExaResult = { title?: string; url?: string; publishedDate?: string; author?: string; score?: number; id?: string };

const normalize = (results: ExaResult[]) =>
	results.map((r) => ({ title: r.title ?? "", url: r.url ?? "", published: r.publishedDate ?? null, author: r.author ?? null, score: r.score ?? null }));

export const find_similar: Fn = {
	name: "find_similar",
	cost: 3,
	description:
		"Exa neural 'more like this'. Give a `url` to find pages semantically similar to it (POST /findSimilar), or a `query` for a neural web search (POST /search, type=neural) — exactly one is required. Returns normalized results (title, url, published, author, score) as JSON, ranked by neural relevance. Needs EXA_API_KEY (key at exa.ai).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "Find pages similar to this URL." },
			query: { type: "string", description: "Neural search query (used when no url is given)." },
			num_results: { type: "integer", minimum: 1, maximum: 25, default: 10 },
		},
	},
	cacheable: true,
	ttl: 900,
	run: async (env, args) => {
		if (!env.EXA_API_KEY) return failWith("not_configured", "Exa not configured (EXA_API_KEY). Key at exa.ai.");

		const url = String(args?.url ?? "").trim();
		const query = String(args?.query ?? "").trim();
		if (!url && !query) return fail("Provide either url (find similar pages) or query (neural search).");

		const numResults = Math.min(25, Math.max(1, Number(args?.num_results) || 10));
		const endpoint = url ? "https://api.exa.ai/findSimilar" : "https://api.exa.ai/search";
		const body = url ? { url, numResults } : { query, numResults, type: "neural" };

		const resp = await fetch(endpoint, {
			method: "POST",
			headers: { "x-api-key": env.EXA_API_KEY, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!resp.ok) return fail(`Exa HTTP ${resp.status}.`);

		const j = (await resp.json()) as { results?: ExaResult[] };
		const results = normalize(j?.results ?? []);
		if (!results.length) return fail(url ? `No pages similar to ${url}.` : `No results for "${query}".`);

		return ok(oj(results));
	},
};
