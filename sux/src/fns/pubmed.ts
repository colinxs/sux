import { type Fn, fail, ok, type RtEnv } from "../registry";

// NCBI E-utilities (eutils.ncbi.nlm.nih.gov) — keyless, free biomedical literature
// search. Two hops: esearch (term → PMID list) then esummary (PMIDs → article
// metadata), both JSON. No residential proxy: a public NIH endpoint with no bot
// wall. An optional NCBI_API_KEY raises the rate limit but is not required.

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

function authParam(env: RtEnv): string {
	return env.NCBI_API_KEY ? `&api_key=${encodeURIComponent(env.NCBI_API_KEY)}` : "";
}

async function getJson(url: string): Promise<any> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`NCBI E-utilities HTTP ${resp.status}.`);
	return resp.json();
}

function normArticle(d: any): Record<string, unknown> {
	const pmid = String(d?.uid ?? "");
	const authors = Array.isArray(d?.authors) ? d.authors.map((a: any) => String(a?.name ?? "")).filter(Boolean) : [];
	const doi = Array.isArray(d?.articleids) ? d.articleids.find((a: any) => a?.idtype === "doi")?.value ?? null : null;
	return {
		pmid,
		title: d?.title ?? null,
		authors,
		journal: d?.fulljournalname ?? d?.source ?? null,
		pubdate: d?.pubdate ?? null,
		doi,
		url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
	};
}

export const pubmed: Fn = {
	name: "pubmed",
	description:
		"Search PubMed / NCBI (keyless, free) — biomedical and life-sciences literature. Provide `term` (standard PubMed query syntax). Returns normalized JSON { count, results:[{ pmid, title, authors[], journal, pubdate, doi, url }] }. Tune with `retmax` (default 10, max 50). Honors an optional NCBI_API_KEY for a higher rate limit.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "PubMed query (supports field tags, e.g. 'crispr[Title]')." },
			retmax: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	ttl: 1800,
	run: async (env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const retmax = Math.min(50, Math.max(1, Number(args?.retmax) || 10));
		const key = authParam(env);

		try {
			const searchUrl = `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=${retmax}&retmode=json${key}`;
			const search = await getJson(searchUrl);
			const ids: string[] = search?.esearchresult?.idlist ?? [];
			if (!ids.length) return ok(JSON.stringify({ count: 0, results: [] }, null, 2));

			const summaryUrl = `${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json${key}`;
			const summary = await getJson(summaryUrl);
			const result = summary?.result ?? {};
			const results = ids.map((id) => result[id]).filter(Boolean).map(normArticle);
			return ok(JSON.stringify({ count: results.length, results }, null, 2));
		} catch (e) {
			return fail(`pubmed failed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
