import { afterEach, describe, expect, it, vi } from "vitest";

// Golden-file snapshot tests for the core extractors. Each feeds a small but
// REALISTIC fixture (a real-shaped article page, pricing table, blog head, RSS
// feed, and a rendered Home Depot search grid) through the fn's public `run` and
// asserts the ENTIRE parsed structure with a deep-equal golden. The point: a
// silent regex/layout regression inside any extractor changes the shape and
// fails CI here, even when the fn still "returns something".
//
// The extractors take `html`/`xml` inline, so no fetch happens — but their
// modules import ../proxy transitively, and homedepot drives ../mac-render, so
// both are mocked (matching the sibling *.test.ts).

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));
vi.mock("../mac-render", () => ({ macRender: vi.fn() }));

import { macRender } from "../mac-render";
import { feed } from "./feed";
import { homedepot } from "./homedepot";
import { metadata } from "./metadata";
import { readability } from "./readability";
import { tables } from "./tables";

const macRenderMock = vi.mocked(macRender);

/** Parse a fn's single text result as JSON. */
function parsed(r: { content: Array<{ text: string }> }): any {
	return JSON.parse(r.content[0].text);
}

afterEach(() => vi.restoreAllMocks());

describe("golden: readability", () => {
	// A real-shaped article: <title>, an author meta, nav/header/footer boilerplate
	// around an <article> the extractor must isolate and flatten to clean text.
	const ARTICLE = `<!doctype html>
<html lang="en">
<head>
	<title>The Case for Boring Infrastructure</title>
	<meta name="author" content="Dana Whitfield">
</head>
<body>
	<nav>Home About Contact</nav>
	<header>Example Engineering Blog</header>
	<article>
		<h1>The Case for Boring Infrastructure</h1>
		<p>Boring infrastructure is a feature, not a bug.</p>
		<p>Every clever moving part is a pager alert waiting to happen.</p>
	</article>
	<footer>Copyright 2026 Example Inc.</footer>
</body>
</html>`;

	it("extracts title, byline, and boilerplate-free article text", async () => {
		const r = await readability.run({} as any, { html: ARTICLE });
		expect(parsed(r)).toEqual({
			title: "The Case for Boring Infrastructure",
			byline: "Dana Whitfield",
			text: "The Case for Boring Infrastructure Boring infrastructure is a feature, not a bug. Every clever moving part is a pager alert waiting to happen.",
		});
	});
});

describe("golden: tables", () => {
	// A realistic pricing table with thead/tbody and $-prices — rows become objects
	// keyed by the header row.
	const PRICING = `<table>
	<thead>
		<tr><th>Plan</th><th>Price</th><th>Seats</th></tr>
	</thead>
	<tbody>
		<tr><td>Starter</td><td>$0</td><td>3</td></tr>
		<tr><td>Team</td><td>$49</td><td>25</td></tr>
		<tr><td>Enterprise</td><td>Contact us</td><td>Unlimited</td></tr>
	</tbody>
</table>`;

	it("parses rows into header-keyed objects", async () => {
		const r = await tables.run({} as any, { html: PRICING, index: 0 });
		expect(parsed(r)).toEqual([
			{ Plan: "Starter", Price: "$0", Seats: "3" },
			{ Plan: "Team", Price: "$49", Seats: "25" },
			{ Plan: "Enterprise", Price: "Contact us", Seats: "Unlimited" },
		]);
	});

	it("emits the same table as csv", async () => {
		const r = await tables.run({} as any, { html: PRICING, index: 0, format: "csv" });
		expect(r.content[0].text).toBe(
			"Plan,Price,Seats\nStarter,$0,3\nTeam,$49,25\nEnterprise,Contact us,Unlimited",
		);
	});
});

describe("golden: metadata", () => {
	// A realistic blog-post <head>: standard meta, a set of og:/twitter: tags, and
	// relative canonical/favicon links that must resolve against the page url.
	const HEAD = `<!doctype html>
<html lang="en">
<head>
	<title>How We Cut Our Cloud Bill in Half</title>
	<meta charset="utf-8">
	<meta name="description" content="A field report on right-sizing workloads and killing idle capacity.">
	<meta name="keywords" content="cloud, cost, finops">
	<meta name="author" content="Dana Whitfield">
	<meta property="og:title" content="How We Cut Our Cloud Bill in Half">
	<meta property="og:type" content="article">
	<meta property="og:image" content="https://blog.example.com/img/cover.png">
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@exampleeng">
	<link rel="canonical" href="/posts/cloud-bill">
	<link rel="icon" href="/favicon.ico">
</head>
<body><p>…</p></body>
</html>`;

	it("flattens head metadata and resolves relative canonical/favicon", async () => {
		const r = await metadata.run({} as any, { html: HEAD, url: "https://blog.example.com/posts/cloud-bill" });
		expect(parsed(r)).toEqual({
			title: "How We Cut Our Cloud Bill in Half",
			description: "A field report on right-sizing workloads and killing idle capacity.",
			keywords: "cloud, cost, finops",
			author: "Dana Whitfield",
			"og:title": "How We Cut Our Cloud Bill in Half",
			"og:type": "article",
			"og:image": "https://blog.example.com/img/cover.png",
			"twitter:card": "summary_large_image",
			"twitter:site": "@exampleeng",
			canonical: "https://blog.example.com/posts/cloud-bill",
			favicon: "https://blog.example.com/favicon.ico",
		});
	});
});

describe("golden: feed", () => {
	// A realistic RSS 2.0 feed with a channel title and two items — one with an
	// escaped `&amp;` in its description, one with a CDATA/HTML description that must
	// be de-tagged and collapsed.
	const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
	<channel>
		<title>Example Engineering Blog</title>
		<link>https://blog.example.com/</link>
		<description>Notes on boring infrastructure.</description>
		<item>
			<title>Cutting the Cloud Bill</title>
			<link>https://blog.example.com/posts/cloud-bill</link>
			<pubDate>Mon, 06 Jul 2026 09:00:00 GMT</pubDate>
			<description>How we right-sized workloads &amp; killed idle capacity.</description>
		</item>
		<item>
			<title>The Case for Boring Infrastructure</title>
			<link>https://blog.example.com/posts/boring-infra</link>
			<pubDate>Tue, 30 Jun 2026 09:00:00 GMT</pubDate>
			<description><![CDATA[Every <b>clever</b> moving part is a pager alert.]]></description>
		</item>
	</channel>
</rss>`;

	it("normalizes RSS items and decodes entities/CDATA", async () => {
		const r = await feed.run({} as any, { xml: RSS });
		expect(parsed(r)).toEqual({
			kind: "rss",
			title: "Example Engineering Blog",
			count: 2,
			items: [
				{
					title: "Cutting the Cloud Bill",
					link: "https://blog.example.com/posts/cloud-bill",
					published: "Mon, 06 Jul 2026 09:00:00 GMT",
					summary: "How we right-sized workloads & killed idle capacity.",
				},
				{
					title: "The Case for Boring Infrastructure",
					link: "https://blog.example.com/posts/boring-infra",
					published: "Tue, 30 Jun 2026 09:00:00 GMT",
					summary: "Every clever moving part is a pager alert.",
				},
			],
		});
	});
});

describe("golden: homedepot (fromPods)", () => {
	// A rendered Home Depot search grid (what the mac render backend returns after
	// warming the Akamai sensor): two product-pod tiles, one with the dollars/cents
	// split across sibling spans — the exact layout fromPods must normalize.
	const PODS_HTML = `<!doctype html><html><body>
<div data-testid="product-pod">
	<a href="/p/Behr-Premium-Plus-1-gal-White/204534567?store=1710">
		<img alt="Behr Premium Plus 1 gal. White Flat Interior Paint" src="https://images.thdstatic.com/behr-white.jpg" />
	</a>
	<span>$<span>32</span><span>.98</span></span>
</div>
<div data-testid="product-pod">
	<a href="/p/Kilz-Original-1-gal-Primer/301122334">
		<img alt="KILZ Original 1 gal. White Oil-Based Primer" src="https://images.thdstatic.com/kilz.jpg" />
	</a>
	<span>$24.48</span>
</div>
</body></html>`;

	it("normalizes rendered product-pod tiles into the shared retail shape", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run(
			{ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any,
			{ action: "search", term: "white paint" },
		);
		expect(r.isError).toBeFalsy();
		expect(parsed(r)).toEqual({
			retailer: "homedepot",
			action: "search",
			count: 2,
			products: [
				{
					id: "204534567",
					title: "Behr Premium Plus 1 gal. White Flat Interior Paint",
					price: 32.98,
					currency: "USD",
					image: "https://images.thdstatic.com/behr-white.jpg",
					url: "https://www.homedepot.com/p/Behr-Premium-Plus-1-gal-White/204534567?store=1710",
				},
				{
					id: "301122334",
					title: "KILZ Original 1 gal. White Oil-Based Primer",
					price: 24.48,
					currency: "USD",
					image: "https://images.thdstatic.com/kilz.jpg",
					url: "https://www.homedepot.com/p/Kilz-Original-1-gal-Primer/301122334",
				},
			],
		});
	});
});
