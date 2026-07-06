import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

const tag = (xml: string, name: string) =>
	xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\/${name}>`, "i"))?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();

export const feed: Fn = {
	name: "feed",
	description: "Parse an RSS or Atom feed into normalized items { title, link, published, summary }. Pass a feed url or raw xml.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string" },
			xml: { type: "string" },
			limit: { type: "integer", default: 30, minimum: 1, maximum: 200 },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let xml = String(args?.xml ?? "");
		if (!xml && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			xml = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!xml) return fail("Provide `xml` or `url`.");
		const limit = Number(args?.limit) || 30;

		const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
		const blocks = isAtom ? [...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)] : [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)];
		const items = blocks.slice(0, limit).map((m) => {
			const b = m[0];
			let link = tag(b, "link");
			if (isAtom) link = b.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? link;
			return {
				title: tag(b, "title") ?? null,
				link: link ?? null,
				published: tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? null,
				summary: (tag(b, "description") ?? tag(b, "summary") ?? "")?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || null,
			};
		});
		const feedTitle = tag(xml.replace(/<(item|entry)[\s\S]*/i, ""), "title");
		return ok(JSON.stringify({ feed: feedTitle ?? null, type: isAtom ? "atom" : "rss", count: items.length, items }, null, 2));
	},
};
