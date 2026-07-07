import { type Fn, fail, ok } from "../registry";
import { fetchText, isHttpUrl } from "./_util";

/** Extract and decode every <loc>…</loc> URL from a sitemap document. */
function extractLocs(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) =>
		m[1]
			.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
			.replace(/&amp;/gi, "&")
			.trim(),
	);
}

export const sitemap: Fn = {
	name: "sitemap",
	description:
		"Fetch and parse an XML sitemap. Give `url` (a sitemap.xml or a sitemap index). Extracts every <loc> URL. For a <sitemapindex> it returns the child sitemap URLs and sets kind='sitemapindex'; a plain <urlset> returns page URLs with kind='urlset'. Returns JSON { kind, count, urls } capped at 1000.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL of the sitemap or sitemap index." },
			limit: { type: "integer", default: 1000, minimum: 1, maximum: 1000, description: "Max URLs to return." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return fail("url must be an absolute http(s) URL.");
		const limit = Math.min(Number(args?.limit) || 1000, 1000);

		// Sitemaps run big (spec allows 50MB) — raise the byte cap well past the
		// 2MB default so a full urlset isn't silently truncated mid-<loc>.
		const xml = (await fetchText(env, url, { maxBytes: 10_000_000 })).text;
		if (!xml.trim()) return fail(`Empty response from ${url}.`);

		const isIndex = /<sitemapindex[\s>]/i.test(xml);
		const urls = extractLocs(xml).slice(0, limit);
		return ok(JSON.stringify({ kind: isIndex ? "sitemapindex" : "urlset", count: urls.length, urls }, null, 2));
	},
};
