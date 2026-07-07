import { type Fn, fail, ok } from "../registry";

// OpenAlex (api.openalex.org) — keyless, free, open scholarly graph (250M+ works).
// Single JSON endpoint: /works?search=<term>. No residential proxy: a public,
// bot-wall-free API. A `mailto` politeness param is optional and lets OpenAlex
// route us to their faster pool; harmless when absent.

const API = "https://api.openalex.org/works";
const MAILTO = "colinxsummers@gmail.com";

function normWork(w: any): Record<string, unknown> {
	const authors = Array.isArray(w?.authorships)
		? w.authorships.map((a: any) => String(a?.author?.display_name ?? "")).filter(Boolean)
		: [];
	return {
		id: w?.id ?? null,
		title: w?.display_name ?? w?.title ?? null,
		year: w?.publication_year ?? null,
		authors,
		doi: w?.doi ?? null,
		citations: typeof w?.cited_by_count === "number" ? w.cited_by_count : null,
		url: w?.primary_location?.landing_page_url ?? w?.id ?? null,
		oa_url: w?.open_access?.oa_url ?? null,
	};
}

export const openalex: Fn = {
	name: "openalex",
	description:
		"Search OpenAlex (keyless, free) — a 250M+ work open scholarly graph spanning every discipline, with citation counts and open-access links. Provide `term`. Returns normalized JSON { count, results:[{ id, title, year, authors[], doi, citations, url, oa_url }] }. Tune with `per_page` (default 10, max 50).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Free-text search across title, abstract, and fulltext." },
			per_page: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	ttl: 1800,
	run: async (_env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const perPage = Math.min(50, Math.max(1, Number(args?.per_page) || 10));

		const p = new URLSearchParams({ search: term, "per-page": String(perPage), mailto: MAILTO });
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`);
		} catch (e) {
			return fail(`OpenAlex fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`OpenAlex API HTTP ${resp.status}.`);
		const j: any = await resp.json();
		const results = (Array.isArray(j?.results) ? j.results : []).map(normWork);
		return ok(JSON.stringify({ count: results.length, results }, null, 2));
	},
};
