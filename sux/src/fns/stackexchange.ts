import { type Fn, fail, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";

// Stack Exchange search (api.stackexchange.com) — keyless advanced search over any
// site in the network (Stack Overflow, Super User, Server Fault, …). No residential
// proxy: a public API with no bot wall. The API gzips responses; a direct fetch
// auto-decompresses. An optional STACKEXCHANGE_KEY (&key=) raises the daily quota.

const API = "https://api.stackexchange.com/2.3/search/advanced";

function decodeEntities(s: string): string {
	return s
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");
}

function normItem(d: any): Record<string, unknown> {
	return {
		title: d?.title ? decodeEntities(String(d.title)) : null,
		url: d?.link ?? null,
		score: Number(d?.score) || 0,
		answered: Boolean(d?.is_answered),
		answers: Number(d?.answer_count) || 0,
		tags: Array.isArray(d?.tags) ? d.tags : [],
		created: d?.creation_date ?? null,
	};
}

export const stackexchange: Fn = {
	name: "stackexchange",
	description:
		"Search Stack Exchange (keyless, free) — questions across any network site (default stackoverflow; also superuser, serverfault, askubuntu, math, …). Provide `term`. Returns normalized JSON { count, results:[{ title, url, score, answered, answers, tags[], created }] }. Tune with `site` (default stackoverflow) and `pagesize` (default 10, max 30). Honors an optional STACKEXCHANGE_KEY for a higher quota.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search terms (matched in question titles/bodies)." },
			site: { type: "string", default: "stackoverflow", description: "Stack Exchange site API slug." },
			pagesize: { type: "integer", minimum: 1, maximum: 30, default: 10 },
		},
	},
	cacheable: true,
	ttl: 900,
	run: async (env: RtEnv, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const site = String(args?.site ?? "stackoverflow").trim() || "stackoverflow";
		const pagesize = Math.min(30, Math.max(1, Number(args?.pagesize) || 10));

		const p = new URLSearchParams({
			order: "desc",
			sort: "relevance",
			q: term,
			site,
			pagesize: String(pagesize),
			filter: "withbody",
		});
		if (env?.STACKEXCHANGE_KEY) p.set("key", env.STACKEXCHANGE_KEY);
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`, { signal: AbortSignal.timeout(20_000) });
		} catch (e) {
			return fail(`Stack Exchange fetch failed: ${errMsg(e)}`);
		}
		if (!resp.ok) {
			const hint =
				resp.status === 403 && !env?.STACKEXCHANGE_KEY
					? " Likely the shared anonymous quota (300 req/day/IP) is exhausted — set STACKEXCHANGE_KEY to raise it."
					: "";
			return fail(`Stack Exchange API HTTP ${resp.status}.${hint}`);
		}
		const j: any = await resp.json();
		const results = (j?.items ?? []).map(normItem);
		return ok(oj({ site, count: results.length, results }));
	},
};
