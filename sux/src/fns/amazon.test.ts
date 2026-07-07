import { afterEach, describe, expect, it, vi } from "vitest";

import { macRender } from "../mac-render";
import { amazon } from "./amazon";

vi.mock("../mac-render", () => ({ macRender: vi.fn() }));

const macRenderMock = vi.mocked(macRender);

// A rendered Amazon search page with two `s-search-result` tiles: each carries a
// `data-asin`, an <h2> title, an `a-offscreen` $-price, and an `s-image` thumb —
// what the mac render backend returns after passing Amazon's bot wall.
const SEARCH_HTML = `<!doctype html><html><body>
<div data-component-type="s-search-result" data-asin="B0ABC12345" data-index="1">
	<h2 class="a-size-mini"><a href="/dp/B0ABC12345"><span>Echo Dot (5th Gen) Smart Speaker &amp; Alarm Clock</span></a></h2>
	<span class="a-price"><span class="a-offscreen">$49.99</span><span aria-hidden="true">$49.99</span></span>
	<img class="s-image" src="https://m.media-amazon.com/images/echo.jpg" />
</div>
<div data-component-type="s-search-result" data-asin="B0XYZ98765" data-index="2">
	<h2><span>Fire TV Stick 4K</span></h2>
	<span class="a-price"><span class="a-offscreen">$39.99</span></span>
	<img class="s-image" src="https://m.media-amazon.com/images/firetv.jpg" />
</div>
<div data-component-type="s-search-result" data-asin="" data-index="3">
	<h2><span>Sponsored placeholder</span></h2>
</div>
</body></html>`;

afterEach(() => vi.restoreAllMocks());

describe("amazon", () => {
	it("extracts products from s-search-result tiles and normalizes them", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: SEARCH_HTML });
		const r = await amazon.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "echo dot" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		// The empty-data-asin tile is skipped, leaving two real products.
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({
			id: "B0ABC12345",
			title: "Echo Dot (5th Gen) Smart Speaker & Alarm Clock",
			price: 49.99,
			currency: "USD",
			image: "https://m.media-amazon.com/images/echo.jpg",
			url: "https://www.amazon.com/dp/B0ABC12345",
		});
		expect(j.products[1]).toMatchObject({ id: "B0XYZ98765", title: "Fire TV Stick 4K", price: 39.99 });
	});

	it("honors the limit", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: SEARCH_HTML });
		const r = await amazon.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "echo dot", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	// Regression: Amazon's REAL markup puts `data-asin` BEFORE `data-component-type`
	// on the same tile div. A naive split on the `data-component-type` marker shifts
	// each tile's content onto the NEXT tile's asin (and drops the last product), so
	// the parser must anchor on the tile's opening tag, not the bare marker.
	it("pairs each asin with its own tile when data-asin precedes data-component-type", async () => {
		const REAL_ORDER = `<!doctype html><html><body>
			<div data-asin="B0ABC12345" data-index="1" data-component-type="s-search-result" class="s-result">
				<h2><span>Echo Dot 5th Gen</span></h2>
				<span class="a-price"><span class="a-offscreen">$49.99</span></span>
				<img class="s-image" src="https://m.media-amazon.com/echo.jpg" />
			</div>
			<div data-asin="B0XYZ98765" data-index="2" data-component-type="s-search-result" class="s-result">
				<h2><span>Fire TV Stick 4K</span></h2>
				<span class="a-price"><span class="a-offscreen">$39.99</span></span>
				<img class="s-image" src="https://m.media-amazon.com/firetv.jpg" />
			</div>
		</body></html>`;
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: REAL_ORDER });
		const r = await amazon.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "echo" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		// Each product carries ITS OWN asin/title/price/image and a matching /dp/ url.
		expect(j.products[0]).toMatchObject({ id: "B0ABC12345", title: "Echo Dot 5th Gen", price: 49.99, image: "https://m.media-amazon.com/echo.jpg", url: "https://www.amazon.com/dp/B0ABC12345" });
		expect(j.products[1]).toMatchObject({ id: "B0XYZ98765", title: "Fire TV Stick 4K", price: 39.99, image: "https://m.media-amazon.com/firetv.jpg", url: "https://www.amazon.com/dp/B0XYZ98765" });
	});

	it("fails with no backend configured (macRender ok:false)", async () => {
		// No MAC_RENDER_URL on the env → macRender resolves ok:false, so run returns
		// an isError ToolResult without a render ever happening.
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "Mac render backend not configured." });
		const r = await amazon.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("reports an Amazon challenge distinctly", async () => {
		macRenderMock.mockResolvedValueOnce({
			ok: true,
			contentType: "text/html",
			body: "<html><body>Robot Check — Enter the characters you see below</body></html>",
		});
		const r = await amazon.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/challenged the request/);
	});

	it("fails with a layout-change message when the page parses clean but empty", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>nothing here</body></html>" });
		const r = await amazon.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted/);
	});

	it("requires a valid asin for action=product", async () => {
		const r = await amazon.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "product", asin: "bad" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/valid 10-char `asin`/);
	});
});
