import { type Fn, fail, ok } from "../registry";

// Guardian Content API (content.guardianapis.com) — official, free key rides
// the query string. Full-text search across Guardian content by `term`.

const API = "https://content.guardianapis.com/search";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

async function api(url: string): Promise<any> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) throw new Error(`Guardian API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function normResult(d: any): Record<string, unknown> {
	const f = d?.fields ?? {};
	return {
		title: d?.webTitle,
		url: d?.webUrl,
		published: d?.webPublicationDate,
		section: d?.sectionName,
		summary: f?.trailText,
		thumbnail: f?.thumbnail,
		byline: f?.byline,
	};
}

export const guardian: Fn = {
	name: "guardian",
	description:
		"Guardian Content API (official, free) — full-text search across The Guardian's content by `term`. " +
		"Needs GUARDIAN_API_KEY (free at open-platform.theguardian.com). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search text." },
			page_size: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	ttl: 900,
	run: async (env, args) => {
		if (!env.GUARDIAN_API_KEY) return fail("Guardian API not configured (GUARDIAN_API_KEY). Free key at open-platform.theguardian.com.");

		const term = String(args?.term ?? "").trim();
		if (!term) return fail("guardian requires a `term`.");
		const pageSize = Math.min(50, Math.max(1, Number(args?.page_size) || 10));

		try {
			const sp = new URLSearchParams({
				q: term,
				"api-key": env.GUARDIAN_API_KEY,
				"show-fields": "trailText,thumbnail,byline",
				"page-size": String(pageSize),
			});
			const j = await api(`${API}?${sp}`);
			const results = (Array.isArray(j?.response?.results) ? j.response.results : []).map(normResult);
			return ok(JSON.stringify({ source: "guardian", term, count: results.length, results }, null, 2));
		} catch (e) {
			return fail(`guardian failed: ${errMsg(e)}`);
		}
	},
};
