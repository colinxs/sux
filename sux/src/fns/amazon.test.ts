import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { unlockerRender } from "../unlocker-render";
import { amazon } from "./amazon";

// amazon renders through retailRender's cf→unlocker ladder, so both rungs are mocked
// at the module boundary. cf is the PRIMARY leg; the paid unlocker is the fallback
// (fail-closed default: unconfigured). Success cases drive the cf leg.
vi.mock("../cf-render", () => ({ cfRender: vi.fn() }));
vi.mock("../unlocker-render", () => ({ unlockerRender: vi.fn() }));

const cfRenderMock = vi.mocked(cfRender);
const unlockerRenderMock = vi.mocked(unlockerRender);

beforeEach(() => {
	// vi.mock factory mocks aren't reset by restoreAllMocks, so clear both rungs' call
	// history each test; default cf to unavailable (no BROWSER binding) and the unlocker
	// to unconfigured (the fail-closed production default).
	cfRenderMock.mockReset();
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
	unlockerRenderMock.mockReset();
	unlockerRenderMock.mockResolvedValue({ ok: false, error: "unlocker not configured" });
});

// A rendered Amazon search page with two `s-search-result` tiles: each carries a
// `data-asin`, an <h2> title, an `a-offscreen` $-price, and an `s-image` thumb —
// what the render backend returns after passing Amazon's bot wall.
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: SEARCH_HTML });
		const r = await amazon.run({} as any, { action: "search", term: "echo dot" });
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: SEARCH_HTML });
		const r = await amazon.run({} as any, { action: "search", term: "echo dot", limit: 1 });
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: REAL_ORDER });
		const r = await amazon.run({} as any, { action: "search", term: "echo" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		// Each product carries ITS OWN asin/title/price/image and a matching /dp/ url.
		expect(j.products[0]).toMatchObject({ id: "B0ABC12345", title: "Echo Dot 5th Gen", price: 49.99, image: "https://m.media-amazon.com/echo.jpg", url: "https://www.amazon.com/dp/B0ABC12345" });
		expect(j.products[1]).toMatchObject({ id: "B0XYZ98765", title: "Fire TV Stick 4K", price: 39.99, image: "https://m.media-amazon.com/firetv.jpg", url: "https://www.amazon.com/dp/B0XYZ98765" });
	});

	it("renders Amazon via cf-residential (the primary leg) and never touches the unlocker when cf succeeds", async () => {
		// cf is the primary leg for Amazon; its HTML flows through fromSearch and yields two products.
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: SEARCH_HTML });
		const r = await amazon.run({} as any, { action: "search", term: "echo dot" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({ id: "B0ABC12345", price: 49.99 });
		// The cf leg fired once, forcing residential + stealth (its only shot at the wall);
		// the unlocker is never reached on a cf win.
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
		expect(unlockerRenderMock).not.toHaveBeenCalled();
	});

	it("a cf result that is Amazon's Robot Check reports the challenge distinctly", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Robot Check — Enter the characters you see below</body></html>" });
		const r = await amazon.run({} as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/challenged the request/);
	});

	it("when BOTH rungs fail, surfaces the cf error (the first-choice signal)", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
		// unlocker stays at its unconfigured default → escalation no-ops → cf error surfaces.
		const r = await amazon.run({} as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
		expect(r.content[0].text).toMatch(/Browser Run is not configured/);
	});

	it("fails with no backend configured (cf unavailable, unlocker unconfigured)", async () => {
		// cf resolves ok:false (no BROWSER binding) and the unlocker is unconfigured, so
		// run returns an isError ToolResult without any successful render.
		const r = await amazon.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("fails with a layout-change message when the page parses clean but empty", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>nothing here</body></html>" });
		const r = await amazon.run({} as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted/);
	});

	it("requires a valid asin for action=product", async () => {
		const r = await amazon.run({} as any, { action: "product", asin: "bad" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/valid 10-char `asin`/);
	});
});
