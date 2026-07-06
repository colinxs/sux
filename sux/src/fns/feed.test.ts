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

	it("respects the limit", async () => {
		const r = await feed.run({} as any, { xml: RSS, limit: 1 });
		expect(JSON.parse(r.content[0].text).count).toBe(1);
	});

	it("errors without xml or url", async () => {
		const r = await feed.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an upstream error page instead of parsing an empty feed", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("<html>Too Many Requests</html>", { status: 429 }));
		const r = await feed.run({} as any, { url: "https://ex.com/feed.xml" });
		expect(r.isError).toBe(true); // errors never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
