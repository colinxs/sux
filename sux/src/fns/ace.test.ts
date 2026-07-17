import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { unlockerRender } from "../unlocker-render";
import { ace } from "./ace";

// Both rungs are mocked at the module boundary: the fn renders via retailRender's
// cf→unlocker ladder. cf is the PRIMARY leg; the paid unlocker is the fallback. cf
// defaults to unavailable (no BROWSER binding); the unlocker to unconfigured.
vi.mock("../cf-render", () => ({ cfRender: vi.fn() }));
vi.mock("../unlocker-render", () => ({ unlockerRender: vi.fn() }));

const cfRenderMock = vi.mocked(cfRender);
const unlockerRenderMock = vi.mocked(unlockerRender);

beforeEach(() => {
	// vi.mock factory mocks aren't reset by restoreAllMocks, so clear call history each
	// test; default cf to unavailable (no BROWSER binding) and the unlocker to unconfigured.
	cfRenderMock.mockReset();
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
	unlockerRenderMock.mockReset();
	unlockerRenderMock.mockResolvedValue({ ok: false, error: "unlocker not configured" });
});

// A rendered Ace Hardware search page with two `mz-productlisting` tiles (the
// Kibo/Mozu client-side grid), each an anchor to /p/<slug>/<sku> with an img alt
// title and a $-price — what the render backend returns for a search. The wrapper
// padding keeps the pre-tile chunk large enough that a real body is not mistaken
// for a block.
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: TILES_HTML });
		const r = await ace.run({ BROWSER: {} } as any, { action: "search", term: "hammer" });
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: TILES_HTML });
		const r = await ace.run({ BROWSER: {} } as any, { action: "search", term: "hammer", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("fails when the render backend is not configured", async () => {
		// cf unavailable (default) and the unlocker unconfigured → retailRender fails → blocked.
		const r = await ace.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("reports a block on a tiny/denied body with no products", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		const r = await ace.run({ BROWSER: {} } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked/);
	});

	it("reports a layout change on a large body with no tiles", async () => {
		const bigNoTiles = `<html><body>${"y".repeat(1500)}</body></html>`;
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: bigNoTiles });
		const r = await ace.run({ BROWSER: {} } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted/);
	});

	it("escalates to the unlocker when cf is down and runs the same extractor", async () => {
		// cf fails (e.g. no BROWSER binding) → retailRender escalates to the paid unlocker;
		// the identical rendered HTML from the unlocker flows through the SAME extractor.
		unlockerRenderMock.mockReset();
		unlockerRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: TILES_HTML });
		const r = await ace.run({ UNLOCKER_API_URL: "u", UNLOCKER_API_KEY: "k" } as any, { action: "search", term: "hammer" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(unlockerRenderMock).toHaveBeenCalledTimes(1);
	});
});
