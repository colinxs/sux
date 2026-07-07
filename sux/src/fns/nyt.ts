import { type Fn, fail, ok } from "../registry";

// NYT Article Search API (api.nytimes.com) — official, free key rides the
// query string. Full-text search across New York Times articles by `term`.

const API = "https://api.nytimes.com/svc/search/v2/articlesearch.json";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

async function api(url: string): Promise<any> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) throw new Error(`NYT API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function normDoc(d: any): Record<string, unknown> {
	return {
		title: d?.headline?.main,
		abstract: d?.abstract,
		url: d?.web_url,
		published: d?.pub_date,
		byline: d?.byline?.original,
		section: d?.section_name,
	};
}

export const nyt: Fn = {
	name: "nyt",
	description:
		"NYT Article Search API (official, free) — full-text search across New York Times articles by `term`. " +
		"Needs NYT_API_KEY (free at developer.nytimes.com). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search text." },
			limit: { type: "integer", minimum: 1, maximum: 10, default: 10 },
		},
	},
	cacheable: true,
	ttl: 900,
	run: async (env, args) => {
		if (!env.NYT_API_KEY) return fail("NYT API not configured (NYT_API_KEY). Free key at developer.nytimes.com.");

		const term = String(args?.term ?? "").trim();
		if (!term) return fail("nyt requires a `term`.");
		const limit = Math.min(10, Math.max(1, Number(args?.limit) || 10));

		try {
			const sp = new URLSearchParams({ q: term, "api-key": env.NYT_API_KEY, page: "0" });
			const j = await api(`${API}?${sp}`);
			const docs = (Array.isArray(j?.response?.docs) ? j.response.docs : []).slice(0, limit).map(normDoc);
			return ok(JSON.stringify({ source: "nyt", term, count: docs.length, articles: docs }, null, 2));
		} catch (e) {
			return fail(`nyt failed: ${errMsg(e)}`);
		}
	},
};
