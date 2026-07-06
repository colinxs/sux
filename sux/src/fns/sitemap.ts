import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const sitemap: Fn = {
	name: "sitemap",
	description: "Fetch and parse a sitemap.xml (or sitemap index) and return the listed URLs. Give a sitemap url or any site url (─ /sitemap.xml is tried). Follows one level of index nesting.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Sitemap URL, or any URL on the site." },
			limit: { type: "integer", default: 1000, minimum: 1, maximum: 5000 },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const input = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(input)) return fail("url must be absolute http(s).");
		const limit = Number(args?.limit) || 1000;
		const smUrl = /sitemap.*\.xml/i.test(input) ? input : new URL("/sitemap.xml", input).href;

		const fetchLocs = async (u: string) => {
			const xml = await (await smartFetch(env, u, {})).text();
			return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => m[1].trim());
		};

		let locs = await fetchLocs(smUrl);

		const nested = locs.filter((l) => /\.xml($|\?)/i.test(l));
		if (nested.length && nested.length === locs.length) {
			const all: string[] = [];
			for (const sm of nested.slice(0, 50)) {
				try {
					all.push(...(await fetchLocs(sm)));
				} catch {

				}
				if (all.length >= limit) break;
			}
			locs = all;
		}
		const urls = locs.slice(0, limit);
		return ok(JSON.stringify({ sitemap: smUrl, count: urls.length, urls }, null, 2));
	},
};
