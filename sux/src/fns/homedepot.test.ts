import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { macRender } from "../mac-render";
import { homedepot } from "./homedepot";

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

// A rendered Home Depot search page with two product-pod tiles (the client-side
// grid), each an anchor to /p/<slug>/<itemId> with an img alt, a $-price, and a
// thd image — what the mac render backend returns after warming the Akamai sensor.
const PODS_HTML = `<!doctype html><html><body>
<div data-testid="product-pod">
	<a href="/p/RYOBI-ONE-18V-Drill/312345678?store=1710">
		<img alt="RYOBI ONE+ 18V Cordless Drill" src="https://images.thdstatic.com/ryobi.jpg" />
	</a>
	<span>$<span>79</span><span>.00</span></span>
</div>
<div data-testid="product-pod">
	<a href="/p/Milwaukee-M18-Impact/398765432">
		<img alt="Milwaukee M18 Impact Driver" src="https://images.thdstatic.com/milwaukee.jpg" />
	</a>
	<span>$149.97</span>
</div>
</body></html>`;

afterEach(() => vi.restoreAllMocks());

describe("homedepot", () => {
	it("extracts products from product-pod tiles and normalizes them", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({
			id: "312345678",
			title: "RYOBI ONE+ 18V Cordless Drill",
			price: 79.0,
			currency: "USD",
			image: "https://images.thdstatic.com/ryobi.jpg",
			url: "https://www.homedepot.com/p/RYOBI-ONE-18V-Drill/312345678?store=1710",
		});
		expect(j.products[1]).toMatchObject({ id: "398765432", title: "Milwaukee M18 Impact Driver", price: 149.97 });
	});

	it("honors the limit", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("fails when macRender fails", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "Mac render backend not configured." });
		const r = await homedepot.run({} as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("fails when no products can be extracted (challenge or layout change)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		const r = await homedepot.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted/);
	});
	it("falls back to cf-residential when the mac node is down and runs the same extractor", async () => {
		// Mac fails (e.g. node 502) → retailRender retries via cf; the identical rendered
		// HTML from cf flows through the SAME extractor and yields the same results.
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "mac render failed: HTTP 502" });
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		// cf fired once, forcing residential + stealth (its only shot at the wall).
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

});
