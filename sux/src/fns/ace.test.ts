import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { macRender } from "../mac-render";
import { ace } from "./ace";

// Both render backends are mocked at the module boundary: the fn now renders via
// retailRender's mac→cf fallback. cf defaults to unavailable (no BROWSER binding);
// the fallback test overrides it to prove mac→cf hands the SAME HTML to the extractor.
vi.mock("../mac-render", () => ({ macRender: vi.fn() }));
vi.mock("../cf-render", () => ({ cfRender: vi.fn() }));

const macRenderMock = vi.mocked(macRender);
const cfRenderMock = vi.mocked(cfRender);

beforeEach(() => {
	// vi.mock factory mocks aren't reset by restoreAllMocks, so clear cf's call
	// history each test; default the cf leg to unavailable (no BROWSER binding).
	cfRenderMock.mockReset();
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Rendering is not configured (BROWSER binding)." });
});

// A rendered Ace Hardware search page with two `mz-productlisting` tiles (the
// Kibo/Mozu client-side grid), each an anchor to /p/<slug>/<sku> with an img alt
// title and a $-price — what the mac render backend returns for a search. The
// wrapper padding keeps the pre-tile chunk large enough that a real body is not
// mistaken for a block.
const TILES_HTML = `<!doctype html><html><body>
<div class="filler">${"x".repeat(1200)}</div>
<div class="mz-productlisting">
	<a href="/p/craftsman-16-oz-hammer/2001234">
		<img alt="Craftsman 16 oz. Fiberglass Hammer" src="https://images.acehardware.com/hammer.jpg" />
	</a>
	<span class="mz-price">$24.97</span>
</div>
<div class="mz-productlisting">
	<a href="/p/scotts-turf-builder-lawn-food/8005678">
		<img alt="Scotts Turf Builder Lawn Food" src="https://images.acehardware.com/scotts.jpg" />
	</a>
	<span class="mz-price">$30.00</span>
</div>
</body></html>`;

afterEach(() => vi.restoreAllMocks());

describe("ace", () => {
	it("extracts products from mz-productlisting tiles and normalizes them", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: TILES_HTML });
		const r = await ace.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.retailer).toBe("ace");
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({
			id: "2001234",
			title: "Craftsman 16 oz. Fiberglass Hammer",
			price: 24.97,
			currency: "USD",
			image: "https://images.acehardware.com/hammer.jpg",
			url: "https://www.acehardware.com/p/craftsman-16-oz-hammer/2001234",
		});
		expect(j.products[1]).toMatchObject({ id: "8005678", title: "Scotts Turf Builder Lawn Food", price: 30.0 });
	});

	it("honors the limit", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: TILES_HTML });
		const r = await ace.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "hammer", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("fails when macRender fails (no backend configured)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "Mac render backend not configured." });
		const r = await ace.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("reports a block on a tiny/denied body with no products", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		const r = await ace.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked/);
	});

	it("reports a layout change on a large body with no tiles", async () => {
		const bigNoTiles = `<html><body>${"y".repeat(1500)}</body></html>`;
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: bigNoTiles });
		const r = await ace.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted/);
	});
	it("falls back to cf-residential when the mac node is down and runs the same extractor", async () => {
		// Mac fails (e.g. node 502) → retailRender retries via cf; the identical rendered
		// HTML from cf flows through the SAME extractor and yields the same results.
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "mac render failed: HTTP 502" });
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: TILES_HTML });
		const r = await ace.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		// cf fired once, forcing residential + stealth (its only shot at the wall).
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

});
