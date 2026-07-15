import { type Fn, fail, ok } from "../registry";
import { fetchTextOk, oj } from "./_util";

/** Turn a numeric code point into text; out-of-range values become U+FFFD instead of throwing. */
function codePoint(cp: number): string {
	return cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
}

/** Decode the handful of entities that turn up in feed text. */
function decodeEntities(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
		// `&amp;` must decode last so escaped entities like `&amp;lt;` become the
		// literal text `&lt;` instead of being re-decoded into `<` markup.
		.replace(/&amp;/gi, "&");
}

/** First inner text of <name>…</name> within `xml`, entity-decoded. */
function tag(xml: string, name: string): string | null {
	const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
	return m ? decodeEntities(m[1]).trim() : null;
}

// Atom permits several <link>s per entry (alternate/edit/self/enclosure). The item URL
// is the rel="alternate" one (or the relless default per RFC 4287); fall back to the
// first link with an href so a feed that omits rel still resolves.
function atomLink(entry: string): string | null {
	const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)]
		.map((m) => m[1])
		.map((attrs) => ({ href: attrs.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? null, rel: attrs.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? null }))
		.filter((l) => l.href);
	const preferred = links.find((l) => l.rel === null || l.rel === "alternate") ?? links[0];
	return preferred?.href ?? null;
}

export const feed: Fn = {
	name: "feed",
	description:
		"Parse an RSS or Atom feed into normalized items { title, link, published, summary }. Provide `url` (fetched via residential proxy) or raw `xml`. Auto-detects RSS (<item>) vs Atom (<entry>). Returns JSON { kind:'rss'|'atom', title, count, items } capped at `limit` items (default 50). Basic HTML entities are decoded and summaries have tags stripped.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "Absolute http(s) URL of the feed." },
			xml: { type: "string", description: "Raw feed XML (used instead of fetching `url`)." },
			limit: { type: "integer", default: 50, minimum: 1, maximum: 200, description: "Max items to return." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let xml = String(args?.xml ?? "");
		if (!xml && args?.url) {
			// An error page is not a feed — fetchTextOk surfaces the status instead
			// of letting an empty items list get cached for an hour.
			const fetched = await fetchTextOk(env, args.url);
			if ("error" in fetched) return fail(fetched.error);
			xml = fetched.text;
		}
		if (!xml) return fail("Provide `xml` or `url`.");
		const limit = Math.min(200, Math.max(1, Number(args?.limit) || 50));

		const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
		const blocks = isAtom ? [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)] : [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];

		const items = blocks.slice(0, limit).map((m) => {
			const b = m[0];
			// Atom links live in a href attribute (pick the rel=alternate one); RSS links are element text.
			const link = isAtom ? atomLink(b) : tag(b, "link");
			const summaryRaw = tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content") ?? "";
			const summary = summaryRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || null;
			return {
				title: tag(b, "title"),
				link,
				published: tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? null,
				summary,
			};
		});

		// Feed-level title = first <title> before any item/entry block.
		const head = xml.replace(/<(item|entry)\b[\s\S]*/i, "");
		return ok(
			oj({ kind: isAtom ? "atom" : "rss", title: tag(head, "title"), count: items.length, items }),
		);
	},
};
