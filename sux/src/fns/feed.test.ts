import { describe, expect, it, vi } from "vitest";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>My Blog</title>
  <item><title>First &amp; Foremost</title><link>https://ex.com/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>&lt;p&gt;Hello world&lt;/p&gt;</description></item>
  <item><title>Second</title><link>https://ex.com/2</link><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate><description>More</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry><title>Entry One</title><link href="https://a.com/e1"/><updated>2024-01-01T00:00:00Z</updated><summary>Sum one</summary></entry>
</feed>`;

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response(RSS, { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { feed } from "./feed";

describe("feed", () => {
	it("parses RSS items and decodes entities", async () => {
		const r = await feed.run({} as any, { xml: RSS });
		const out = JSON.parse(r.content[0].text);
		expect(out.kind).toBe("rss");
		expect(out.title).toBe("My Blog");
		expect(out.count).toBe(2);
		expect(out.items[0].title).toBe("First & Foremost");
		expect(out.items[0].link).toBe("https://ex.com/1");
		expect(out.items[0].summary).toBe("Hello world"); // tags stripped
	});

	it("detects Atom and reads link href", async () => {
		const r = await feed.run({} as any, { xml: ATOM });
		const out = JSON.parse(r.content[0].text);
		expect(out.kind).toBe("atom");
		expect(out.items[0].link).toBe("https://a.com/e1");
		expect(out.items[0].published).toBe("2024-01-01T00:00:00Z");
	});

	it("prefers the rel=alternate link over an earlier rel=edit link", async () => {
		const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry><title>E</title><link rel="edit" href="https://a.com/edit"/><link rel="alternate" href="https://a.com/real"/><updated>2024-01-01T00:00:00Z</updated></entry>
</feed>`;
		const out = JSON.parse((await feed.run({} as any, { xml })).content[0].text);
		expect(out.items[0].link).toBe("https://a.com/real"); // the canonical entry URL, not the edit endpoint
	});

	it("falls back to the first link when no rel=alternate is present", async () => {
		const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>E</title><link href="https://a.com/only"/><updated>2024-01-01T00:00:00Z</updated></entry>
</feed>`;
		const out = JSON.parse((await feed.run({} as any, { xml })).content[0].text);
		expect(out.items[0].link).toBe("https://a.com/only");
	});

	it("respects the limit", async () => {
		const r = await feed.run({} as any, { xml: RSS, limit: 1 });
		expect(JSON.parse(r.content[0].text).count).toBe(1);
	});

	it("errors without xml or url", async () => {
		const r = await feed.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("survives out-of-range numeric entities instead of throwing RangeError", async () => {
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
			<item><title>Bad &#x110000; hex &#99999999999; dec</title><link>https://ex.com/1</link></item>
		</channel></rss>`;
		const r = await feed.run({} as any, { xml });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		expect(out.items[0].title).toBe("Bad � hex � dec");
	});

	it("does not double-decode escaped entities into markup", async () => {
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
			<item><title>escaped &amp;lt;b&amp;gt; markup</title><link>https://ex.com/1</link><description>escaped &amp;lt;b&amp;gt; markup</description></item>
		</channel></rss>`;
		const r = await feed.run({} as any, { xml });
		const out = JSON.parse(r.content[0].text);
		// `&amp;lt;` is the escaped form of the literal text `&lt;` — it must decode
		// once to `&lt;`, not twice into `<` that the summary stripper would delete.
		expect(out.items[0].title).toBe("escaped &lt;b&gt; markup");
		expect(out.items[0].summary).toBe("escaped &lt;b&gt; markup");
	});

	it("fails on an upstream error page instead of parsing an empty feed", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("<html>Too Many Requests</html>", { status: 429 }));
		const r = await feed.run({} as any, { url: "https://ex.com/feed.xml" });
		expect(r.isError).toBe(true); // errors never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
