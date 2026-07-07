import { type Fn, fail, ok } from "../registry";

// CrossRef Works API (api.crossref.org) — keyless, free scholarly metadata keyed
// on DOIs. No residential proxy: a public bibliographic endpoint with no bot wall,
// so a plain fetch is correct and cheaper.

const API = "https://api.crossref.org/works";

function normItem(d: any): Record<string, unknown> {
	const authors = Array.isArray(d?.author)
		? d.author.map((a: any) => [a?.given, a?.family].filter(Boolean).join(" ").trim()).filter(Boolean)
		: [];
	const parts = d?.published?.["date-parts"]?.[0];
	const year = Array.isArray(parts) && parts.length ? Number(parts[0]) || null : null;
	return {
		doi: d?.DOI ?? null,
		title: Array.isArray(d?.title) ? d.title[0] ?? null : null,
		authors,
		journal: Array.isArray(d?.["container-title"]) ? d["container-title"][0] ?? null : null,
		year,
		citations: Number(d?.["is-referenced-by-count"]) || 0,
		url: d?.URL ?? (d?.DOI ? `https://doi.org/${d.DOI}` : null),
	};
}

export const crossref: Fn = {
	name: "crossref",
	description:
		"Search CrossRef Works (keyless, free) — scholarly DOI metadata across every discipline. Provide `term` (matched across titles, authors, and metadata). Returns normalized JSON { count, results:[{ doi, title, authors[], journal, year, citations, url }] }. Tune with `rows` (default 10, max 50).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search terms (matched across CrossRef metadata)." },
			rows: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	ttl: 1800,
	run: async (_env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const rows = Math.min(50, Math.max(1, Number(args?.rows) || 10));

		const p = new URLSearchParams({ query: term, rows: String(rows) });
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`);
		} catch (e) {
			return fail(`CrossRef fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`CrossRef API HTTP ${resp.status}.`);
		const j: any = await resp.json();
		const results = (j?.message?.items ?? []).map(normItem);
		return ok(JSON.stringify({ count: results.length, results }, null, 2));
	},
};
