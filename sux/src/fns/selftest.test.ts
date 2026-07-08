import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// selftest probes each fetch-ladder rung live. It must NEVER hang and NEVER throw:
// a wedged or failing rung has to surface as `ok:false`, not propagate. So we mock
// every egress path — the worker's global fetch (direct), smartFetch (residential
// scrape), macRender (Mac node) — and drive each into success, failure, and hang.

const smartFetchMock = vi.hoisted(() => vi.fn());
const isTailscaleConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const macRenderMock = vi.hoisted(() => vi.fn());

vi.mock("../proxy", () => ({
	smartFetch: smartFetchMock,
	isTailscaleConfigured: isTailscaleConfiguredMock,
}));
vi.mock("../mac-render", () => ({
	macRender: macRenderMock,
}));

import { selftest } from "./selftest";

// A fully-provisioned env so `configured` reads all-true and every rung is probed
// rather than skipped. Individual tests strip keys to exercise the skip paths.
const FULL_ENV = {
	TAILSCALE_PROXY_URL: "https://box.ts.net",
	TAILSCALE_PROXY_SECRET: "s",
	MAC_RENDER_URL: "https://mac.ts.net",
	MAC_RENDER_SECRET: "s",
	BROWSER: {},
	KAGI_API_KEY: "k",
	KROGER_CLIENT_ID: "a",
	KROGER_CLIENT_SECRET: "b",
	BRAVE_API_KEY: "k",
	EXA_API_KEY: "k",
	TAVILY_API_KEY: "k",
	GOOGLE_MAPS_KEY: "k",
	BESTBUY_API_KEY: "k",
	EBAY_CLIENT_ID: "a",
	EBAY_CLIENT_SECRET: "b",
	YOUTUBE_API_KEY: "k",
	FACEBOOK_TOKEN: "t",
	GRAFANA_LOKI_URL: "u",
	GRAFANA_LOKI_USER: "u",
	GRAFANA_LOKI_TOKEN: "t",
} as any;

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("selftest", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch") as any;
		fetchSpy.mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));
		smartFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
		macRenderMock.mockResolvedValue({ ok: true, contentType: "text/html", body: "<html>ok</html>" });
		isTailscaleConfiguredMock.mockReturnValue(true);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		vi.clearAllMocks();
	});

	it("returns the { rungs, configured } shape with all four rungs and never errors", async () => {
		const r = await selftest.run(FULL_ENV, {});
		expect(r.isError).toBeFalsy();
		const out = parse(r);
		expect(Object.keys(out)).toEqual(["rungs", "configured"]);
		expect(Object.keys(out.rungs)).toEqual(["direct", "scrape", "render_mac", "render_cf"]);
	});

	it("reports every rung up when each probe answers", async () => {
		const out = parse(await selftest.run(FULL_ENV, {}));
		expect(out.rungs.direct).toMatchObject({ ok: true, status: 200 });
		expect(out.rungs.scrape).toMatchObject({ ok: true, status: 200 });
		expect(out.rungs.render_mac).toMatchObject({ ok: true });
		expect(out.rungs.render_cf).toMatchObject({ ok: true });
	});

	it("reports configured credentials/bindings as booleans WITHOUT calling any upstream", async () => {
		const out = parse(await selftest.run(FULL_ENV, {}));
		expect(out.configured).toMatchObject({
			kagi: true,
			kroger: true,
			brave: true,
			exa: true,
			google_maps: true,
			grafana: true,
			proxy: true,
			mac_render: true,
			browser: true,
		});
	});

	it("does not call the API-keyed upstreams — configured is pure presence", async () => {
		await selftest.run(FULL_ENV, {});
		// Only the three ladder rungs may fetch; nothing keyed (kagi/brave/exa/etc.).
		expect(fetchSpy).toHaveBeenCalledTimes(1); // direct only
		expect(smartFetchMock).toHaveBeenCalledTimes(1); // scrape only
		expect(macRenderMock).toHaveBeenCalledTimes(1); // render_mac only
	});

	it("reports a THROWN probe as down, not thrown (direct fetch rejects)", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("network is unreachable"));
		const out = parse(await selftest.run(FULL_ENV, {}));
		expect(out.rungs.direct.ok).toBe(false);
		expect(out.rungs.direct.error).toMatch(/unreachable/);
		// The other rungs are unaffected.
		expect(out.rungs.scrape.ok).toBe(true);
	});

	it("reports a HANGING probe as down within the deadline, not a hung tool call", async () => {
		// smartFetch never resolves — the classic wedged-node failure. With a tight
		// timeout_ms the whole call must still return quickly with scrape down.
		smartFetchMock.mockImplementationOnce(() => new Promise(() => {}));
		const t0 = Date.now();
		const out = parse(await selftest.run(FULL_ENV, { timeout_ms: 30 }));
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(out.rungs.scrape.ok).toBe(false);
		expect(out.rungs.scrape.error).toMatch(/timed out/);
	});

	it("reports a failing mac render (its {ok:false} envelope) as down without throwing", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "mac render failed: HTTP 502" });
		const out = parse(await selftest.run(FULL_ENV, {}));
		expect(out.rungs.render_mac.ok).toBe(false);
		expect(out.rungs.render_mac.error).toMatch(/502/);
	});

	it("skips (does not fail) the scrape rung when the residential proxy is unconfigured", async () => {
		isTailscaleConfiguredMock.mockReturnValue(false);
		const out = parse(await selftest.run({ ...FULL_ENV, TAILSCALE_PROXY_URL: undefined, TAILSCALE_PROXY_SECRET: undefined }, {}));
		expect(out.rungs.scrape).toMatchObject({ ok: false, skipped: true });
		expect(smartFetchMock).not.toHaveBeenCalled();
		expect(out.configured.proxy).toBe(false);
	});

	it("skips the render_mac rung gracefully when MAC_RENDER_URL is unset", async () => {
		const out = parse(await selftest.run({ ...FULL_ENV, MAC_RENDER_URL: undefined }, {}));
		expect(out.rungs.render_mac).toMatchObject({ ok: false, skipped: true });
		expect(out.rungs.render_mac.reason).toMatch(/MAC_RENDER_URL/);
		expect(macRenderMock).not.toHaveBeenCalled();
	});

	it("reports render_cf down/skipped when the BROWSER binding is absent, up when present", async () => {
		const absent = parse(await selftest.run({ ...FULL_ENV, BROWSER: undefined }, {}));
		expect(absent.rungs.render_cf).toMatchObject({ ok: false, skipped: true });
		expect(absent.configured.browser).toBe(false);

		const present = parse(await selftest.run(FULL_ENV, {}));
		expect(present.rungs.render_cf).toMatchObject({ ok: true });
	});
});
