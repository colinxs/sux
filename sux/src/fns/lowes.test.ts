import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { macRender } from "../mac-render";
import { lowes } from "./lowes";

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
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
});

// A rendered Lowe's search page with two product tiles (the client-side grid), each
// an anchor to /pd/<slug>/<productId> with an img alt, a $-price, and a lowes image —
// what the mac render backend returns after rendering the React catalog.
const ANCHORS_HTML = `<!doctype html><html><body>
<div class="tile">
	<a href="/pd/Kobalt-24-in-Tool-Box/1000123456">
		<img alt="Kobalt 24-in Steel Tool Box" src="https://mobileimages.lowes.com/kobalt.jpg" />
	</a>
	<span>$<span>79</span><span>.00</span></span>
</div>
<div class="tile">
	<a href="/pd/DeWalt-20V-Drill/5000987654?cId=PDIO1">
		<img alt="DeWalt 20V MAX Cordless Drill" src="https://images.lowes.com/dewalt.jpg" />
	</a>
	<span>$149.97</span>
</div>
</body></html>`;

afterEach(() => vi.restoreAllMocks());

describe("lowes", () => {
	it("extracts products from /pd/ anchors and normalizes them", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: ANCHORS_HTML });
		const r = await lowes.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "tool box" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.retailer).toBe("lowes");
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({
			id: "1000123456",
			title: "Kobalt 24-in Steel Tool Box",
			price: 79.0,
			currency: "USD",
			image: "https://mobileimages.lowes.com/kobalt.jpg",
			url: "https://www.lowes.com/pd/Kobalt-24-in-Tool-Box/1000123456",
		});
		expect(j.products[1]).toMatchObject({
			id: "5000987654",
			title: "DeWalt 20V MAX Cordless Drill",
			price: 149.97,
			url: "https://www.lowes.com/pd/DeWalt-20V-Drill/5000987654?cId=PDIO1",
		});
	});

	it("binds the price to a real price key, not a sibling rating 'value'", async () => {
		// A state blob where a rating object (with its own "value") sits between the
		// productId and the real sellingPrice, all inside the ±700-char window. The old
		// regex accepted a bare "value" key and, scanning left-to-right, would capture the
		// rating (4) instead of the price (79.00). The price must come from sellingPrice.
		const STATE_HTML = `<!doctype html><html><body><script>window.__DATA__={"products":[{"productId":"1000123456","description":"Kobalt 24-in Steel Tool Box","brand":"Kobalt","rating":{"value":"4","count":"128"},"sellingPrice":"79.00","image":"https://mobileimages.lowes.com/kobalt.jpg"}]};</script></body></html>`;
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: STATE_HTML });
		const r = await lowes.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "tool box" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.products[0]).toMatchObject({
			id: "1000123456",
			title: "Kobalt 24-in Steel Tool Box",
			price: 79.0,
		});
		expect(j.products[0].price).not.toBe(4);
	});

	it("honors the limit", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: ANCHORS_HTML });
		const r = await lowes.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "tool box", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("returns an error when the render backend is not configured", async () => {
		// The real macRender resolves { ok:false } when MAC_RENDER_URL is absent; the
		// mock mirrors that so we exercise lowes' no-backend / failed-render branch.
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "Mac render backend not configured." });
		const r = await lowes.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("fails with a blocked hint when the page looks like a bot wall", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		const r = await lowes.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked/i); // detected as a wall (either the ladder's block-escalation or the empty-page hint)
	});

	it("fails with a layout-change hint when a full page yields no products", async () => {
		// A long, benign page (> 1000 bytes) with no /pd/ anchors — not blocked, just
		// unparseable, so we expect the layout-change message.
		const filler = `<div>${"x".repeat(1500)}</div>`;
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: `<html><body>${filler}</body></html>` });
		const r = await lowes.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted \(layout change\)/);
	});
	it("falls back to cf-residential when the mac node is down and runs the same extractor", async () => {
		// Mac fails (e.g. node 502) → retailRender retries via cf; the identical rendered
		// HTML from cf flows through the SAME extractor and yields the same results.
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "mac render failed: HTTP 502" });
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: ANCHORS_HTML });
		const r = await lowes.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "tool box" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		// cf fired once, forcing residential + stealth (its only shot at the wall).
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

});
