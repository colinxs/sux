import { type Fn, fail, ok, type RtEnv } from "../registry";

// Semantic Scholar Academic Graph (api.semanticscholar.org) — keyless paper search
// across ~200M papers. No residential proxy: a public academic API with no bot
// wall. An optional S2_API_KEY (x-api-key header) raises the rate limit but is not
// required.

const API = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = "title,abstract,year,authors,citationCount,url,externalIds,openAccessPdf";

function normPaper(d: any): Record<string, unknown> {
	const authors = Array.isArray(d?.authors) ? d.authors.map((a: any) => String(a?.name ?? "")).filter(Boolean) : [];
	return {
		id: d?.paperId ?? null,
		title: d?.title ?? null,
		abstract: d?.abstract ?? null,
		year: Number.isFinite(d?.year) ? d.year : d?.year ?? null,
		authors,
		citations: Number(d?.citationCount) || 0,
		url: d?.url ?? null,
		pdf: d?.openAccessPdf?.url ?? null,
	};
}

export const semantic_scholar: Fn = {
	name: "semantic_scholar",
	description:
		"Search Semantic Scholar (keyless, free) — the Academic Graph across every field of research. Provide `term`. Returns normalized JSON { count, results:[{ id, title, abstract, year, authors[], citations, url, pdf }] }. Tune with `limit` (default 10, max 50). Honors an optional S2_API_KEY for a higher rate limit.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search terms." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	ttl: 1800,
	run: async (env: RtEnv, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));

		const p = new URLSearchParams({ query: term, limit: String(limit), fields: FIELDS });
		const headers: Record<string, string> = { Accept: "application/json" };
		if (env?.S2_API_KEY) headers["x-api-key"] = env.S2_API_KEY;
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`, { headers });
		} catch (e) {
			return fail(`Semantic Scholar fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`Semantic Scholar API HTTP ${resp.status}.`);
		const j: any = await resp.json();
		const results = (j?.data ?? []).map(normPaper);
		return ok(JSON.stringify({ count: results.length, results }, null, 2));
	},
};
