import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { unlockerRender } from "../unlocker-render";
import { homedepot } from "./homedepot";

// Both rungs are mocked at the module boundary: the fn renders via retailRender's
// cf→unlocker ladder (cf is the PRIMARY leg, the paid unlocker the fallback). cf
// defaults to unavailable (no BROWSER binding); the unlocker defaults to unconfigured
// — the escalation tests override each.
vi.mock("../cf-render", () => ({ cfRender: vi.fn() }));
vi.mock("../unlocker-render", () => ({ unlockerRender: vi.fn() }));

const cfRenderMock = vi.mocked(cfRender);
const unlockerRenderMock = vi.mocked(unlockerRender);

beforeEach(() => {
	// vi.mock factory mocks aren't reset by restoreAllMocks, so clear call history each
	// test; default the cf leg to unavailable (no BROWSER binding) and the unlocker to
	// unconfigured (the fail-closed production default).
	cfRenderMock.mockReset();
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
	unlockerRenderMock.mockReset();
	unlockerRenderMock.mockResolvedValue({ ok: false, error: "unlocker not configured" });
});

// A rendered Home Depot search page with two product-pod tiles (the client-side
// grid), each an anchor to /p/<slug>/<itemId> with an img alt, a $-price, and a
// thd image — what the render backend returns after warming the Akamai sensor.
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run({ BROWSER: {} } as any, { action: "search", term: "drill", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("fails when cf fails and the unlocker is unconfigured", async () => {
		const r = await homedepot.run({} as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or render failed/);
	});

	it("renders via cf (the primary leg) and never touches the unlocker when cf succeeds", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).count).toBe(2);
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(unlockerRenderMock).not.toHaveBeenCalled();
	});

	it("escalates to the paid unlocker after cf fails", async () => {
		// cf unavailable (beforeEach default) → unlocker returns the SAME HTML, which flows
		// through the identical extractor and yields the products.
		unlockerRenderMock.mockReset();
		unlockerRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run(
			{ UNLOCKER_API_URL: "u", UNLOCKER_API_KEY: "k" } as any,
			{ action: "search", term: "drill" },
		);
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).count).toBe(2);
		expect(unlockerRenderMock).toHaveBeenCalledTimes(1);
		expect(unlockerRenderMock.mock.calls[0][1]).toMatchObject({ url: "https://www.homedepot.com/s/drill" });
	});

	it("fails as layout_change when a real page has no products (no block marker)", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body><main>Search results for drill</main></body></html>" });
		const r = await homedepot.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted/);
	});

	it("detects an Akamai block page (not a layout change) and escalates → blocked when the unlocker is unset", async () => {
		// A block page comes back as a "successful" fetch — the ladder must treat it as a wall,
		// escalate past cf, and (unlocker unset) fail as BLOCKED, not mis-report a layout change.
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		const r = await homedepot.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked/i);
	});

	it("cf forces residential + stealth as the primary leg", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		await homedepot.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

	it("does NOT reach the unlocker when the cf render succeeds", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: PODS_HTML });
		const r = await homedepot.run(
			{ BROWSER: {}, UNLOCKER_API_URL: "u", UNLOCKER_API_KEY: "k" } as any,
			{ action: "search", term: "drill" },
		);
		expect(r.isError).toBeFalsy();
		expect(unlockerRenderMock).not.toHaveBeenCalled();
	});
});
