import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "./cf-render";
import { macRender } from "./mac-render";
import { retailRender } from "./retail-render";

// Both backends mocked at the module boundary so we can assert the LADDER order
// (which leg fires first) independent of any real network.
vi.mock("./cf-render", () => ({ cfRender: vi.fn() }));
vi.mock("./mac-render", () => ({ macRender: vi.fn() }));

const cfRenderMock = vi.mocked(cfRender);
const macRenderMock = vi.mocked(macRender);

const CF_HTML = "<html><body>cf</body></html>";
const MAC_HTML = "<html><body>mac</body></html>";

beforeEach(() => {
	cfRenderMock.mockReset();
	macRenderMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const env = { BROWSER: {}, MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any;

describe("retailRender ladder order", () => {
	it("tries cf FIRST by default and never touches mac when cf succeeds", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: CF_HTML });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toMatchObject({ ok: true, body: CF_HTML });
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(macRenderMock).not.toHaveBeenCalled();
		// cf leg forces residential + stealth (its only shot at a wall).
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

	it("falls back to mac when cf fails (cf-first default)", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: false, error: "Browser Rendering is not configured (BROWSER binding)." });
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: MAC_HTML });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toMatchObject({ ok: true, body: MAC_HTML });
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(macRenderMock).toHaveBeenCalledTimes(1);
	});

	it("opts back into mac-FIRST when preferMac is set (cf as the fallback)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: MAC_HTML });
		const r = await retailRender(env, { url: "https://example.com/s" }, { preferMac: true });
		expect(r).toMatchObject({ ok: true, body: MAC_HTML });
		expect(macRenderMock).toHaveBeenCalledTimes(1);
		expect(cfRenderMock).not.toHaveBeenCalled();
	});

	it("passes solve through to the mac leg (cf has no solver tier)", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: false, error: "cf down" });
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: MAC_HTML });
		await retailRender(env, { url: "https://example.com/s", solve: true });
		expect(macRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", solve: true });
	});

	it("surfaces the primary (cf) error when BOTH legs fail", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: false, error: "cf primary error" });
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "mac fallback error" });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toEqual({ ok: false, error: "cf primary error" });
	});
});
