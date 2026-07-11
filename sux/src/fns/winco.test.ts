import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { macRender } from "../mac-render";
import { winco } from "./winco";

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

// A rendered WinCo /stores page with two store-locator cards — the client-side
// AngularJS list. Each `<li id="store-list-item-<locationID>">` carries the store
// name, street/city/state/zip (each in a span behind an sr-only label), a phone in
// the telephone block, and a status label — exactly what the mac render backend
// returns once the SPA has populated the DOM. (No lat/lng is present in the markup.)
function card(id: string, num: string, name: string, street: string, city: string, state: string, zip: string, phone: string): string {
	return `<li id="store-list-item-${id}" ng-repeat="store in $ctrl.stores" class="store-list__rail">
	<store-details-preview class="store-preview store-list__store ${id}">
		<span class="store-preview__name">
			<store-name><span class="store-name">
				<span class="name">${name}
					<span class="number"><span aria-hidden="true">&nbsp;#${num}</span><span class="sr-only">,&nbsp;Store Number ${num}</span></span>
				</span>
			</span></store-name>
		</span>
		<span class="store-preview__address">
			<store-address><span class="two-lines"><address><span class="address two-lines">
				<span class="address1"><span class="sr-only">Street</span>${street}</span>
				<span class="city"><span class="sr-only">City</span>${city}</span>
				<span class="sep">,</span>
				<span class="state"><span class="sr-only">State</span>${state}</span>
				<span class="zip"><span class="sr-only">Zip Code</span>${zip}</span>
			</span></address></span></store-address>
		</span>
		<span class="store-preview__telephone"><span class="sr-only">Telephone</span><span ng-if="$ctrl.isStoreList">${phone}</span></span>
		<div class="store-preview__store-info">
			<span class="store-preview__status store-preview__status--open">
				<span class="sr-only">Store Hours</span>
				<span ng-if="$ctrl.store.isOpen &amp;&amp; $ctrl.store.isOpenAllDay">Open 24 hours</span>
			</span>
		</div>
	</store-details-preview>
</li>`;
}

const STORES_HTML = `<!doctype html><html><body><ul class="store-selector__store-list">
${card("4696", "136", "WinCo Foods - Edmonds", "21900 Highway 99", "Edmonds", "WA", "98026", "(425) 697-1052")}
${card("162", "162", "WinCo Foods - Bend", "60 Ne Bend River Mall Dr", "Bend", "OR", "97701", "(541) 678-6509")}
</ul></body></html>`;

const goodEnv = { MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any;

afterEach(() => vi.restoreAllMocks());

describe("winco", () => {
	it("extracts stores from the rendered locator cards and normalizes them", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: STORES_HTML });
		const r = await winco.run(goodEnv, { action: "locations" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.retailer).toBe("winco");
		expect(j.count).toBe(2);
		expect(j.stores[0]).toMatchObject({
			id: "4696",
			name: "WinCo Foods - Edmonds",
			address: "21900 Highway 99, Edmonds, WA, 98026",
			city: "Edmonds",
			state: "WA",
			zip: "98026",
			phone: "(425) 697-1052",
			hours: "Open 24 hours",
		});
		expect(j.stores[1]).toMatchObject({ id: "162", name: "WinCo Foods - Bend", state: "OR", zip: "97701" });
	});

	it("honors the limit", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: STORES_HTML });
		const r = await winco.run(goodEnv, { action: "locations", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.stores[0].id).toBe("4696");
	});

	it("filters by state", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: STORES_HTML });
		const r = await winco.run(goodEnv, { action: "locations", state: "or" });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.stores[0]).toMatchObject({ name: "WinCo Foods - Bend", state: "OR" });
	});

	it("filters by zip (5-digit prefix)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: STORES_HTML });
		const r = await winco.run(goodEnv, { action: "locations", zip: "98026" });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.stores[0].zip).toBe("98026");
	});

	it("fails when macRender fails (no backend configured)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "Mac render backend not configured." });
		const r = await winco.run({} as any, { action: "locations" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("flags a walled/empty render", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		const r = await winco.run(goodEnv, { action: "locations" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or empty render/);
	});

	it("fails cleanly when the page renders but has no store cards", async () => {
		const big = `<html><body>${"x".repeat(2000)}</body></html>`;
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: big });
		const r = await winco.run(goodEnv, { action: "locations" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no stores extracted/);
	});
	it("falls back to cf-residential when the mac node is down and runs the same extractor", async () => {
		// Mac fails (e.g. node 502) → retailRender retries via cf; the identical rendered
		// HTML from cf flows through the SAME extractor and yields the same results.
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "mac render failed: HTTP 502" });
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: STORES_HTML });
		const r = await winco.run(goodEnv, { action: "locations" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		// cf fired once, forcing residential + stealth (its only shot at the wall).
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

});
