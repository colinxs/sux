import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "./cf-render";
import { looksBlocked, retailRender } from "./retail-render";
import { unlockerRender } from "./unlocker-render";

// Both rungs mocked at the module boundary so we can assert the LADDER order (which
// leg fires first) independent of any real network. cf is the PRIMARY leg; the paid
// unlocker is the FALLBACK for a wall cf couldn't clear.
vi.mock("./cf-render", () => ({ cfRender: vi.fn() }));
vi.mock("./unlocker-render", () => ({ unlockerRender: vi.fn() }));

const cfRenderMock = vi.mocked(cfRender);
const unlockerRenderMock = vi.mocked(unlockerRender);

const CF_HTML = "<html><body>cf</body></html>";
const UNLOCKER_HTML = "<html><body>unlocker</body></html>";

beforeEach(() => {
	cfRenderMock.mockReset();
	unlockerRenderMock.mockReset();
	// The unlocker's production default is fail-closed (UNLOCKER_API_* unset).
	unlockerRenderMock.mockResolvedValue({ ok: false, error: "unlocker not configured" });
});
afterEach(() => vi.restoreAllMocks());

const env = { BROWSER: {}, UNLOCKER_API_URL: "u", UNLOCKER_API_KEY: "k" } as any;

describe("retailRender ladder order", () => {
	it("tries cf FIRST and never touches the unlocker when cf succeeds", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: CF_HTML });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toMatchObject({ ok: true, body: CF_HTML });
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(unlockerRenderMock).not.toHaveBeenCalled();
		// cf leg forces residential + stealth (its only shot at a wall).
		expect(cfRenderMock.mock.calls[0][1]).toMatchObject({ as: "html", residential: true, stealth: true });
	});

	it("escalates to the unlocker when cf fails", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
		unlockerRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: UNLOCKER_HTML });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toMatchObject({ ok: true, body: UNLOCKER_HTML });
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(unlockerRenderMock).toHaveBeenCalledTimes(1);
	});

	it("escalates to the unlocker when cf returns a bot wall (a 'successful' block page)", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Access Denied</body></html>" });
		unlockerRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: UNLOCKER_HTML });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toMatchObject({ ok: true, body: UNLOCKER_HTML });
		expect(unlockerRenderMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces the primary (cf) error when BOTH legs fail", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: false, error: "cf primary error" });
		unlockerRenderMock.mockResolvedValueOnce({ ok: false, error: "unlocker not configured" });
		const r = await retailRender(env, { url: "https://example.com/s" });
		expect(r).toEqual({ ok: false, error: "cf primary error" });
	});
});

// looksBlocked is THE canonical bot-wall check the retail scrapers (ace/lowes/costco)
// now route their own zero-products block-vs-layout-change disambiguation through,
// replacing three regexes that had each drifted from this one (and from each other).
describe("looksBlocked (canonical marker + opt-in byte-length check)", () => {
	it("flags any of the known bot-wall markers regardless of length", () => {
		expect(looksBlocked("Access Denied")).toBe(true);
		expect(looksBlocked("<html>sec-cpt challenge</html>")).toBe(true);
		expect(looksBlocked("Pardon Our Interruption")).toBe(true);
		expect(looksBlocked("please verify you are a human")).toBe(true); // substring match
		expect(looksBlocked("px-captcha")).toBe(true);
		expect(looksBlocked("Just a moment...")).toBe(true);
	});

	it("does not flag a short, benign body by default (minBytes omitted)", () => {
		// This is the ladder's own internal escalation check (runLeg) — it must stay
		// marker-only so a genuinely terse real page is never mistaken for a wall.
		expect(looksBlocked("<html><body>ok</body></html>")).toBe(false);
	});

	it("flags a short body as blocked only when the caller opts in with minBytes", () => {
		// A caller that already found zero products from an ostensibly-successful
		// render (ace/lowes/costco's post-parse check) has a stronger signal — a tiny
		// body at that point reads as an empty/challenge shell, not real content.
		const tiny = "<html><body>ok</body></html>";
		expect(looksBlocked(tiny, 1000)).toBe(true);
		expect(looksBlocked(tiny.padEnd(1000, " "), 1000)).toBe(false);
	});

	it("returns false for undefined/empty input", () => {
		expect(looksBlocked(undefined)).toBe(false);
		expect(looksBlocked("", 1000)).toBe(true); // empty IS short, but only when opted in
		expect(looksBlocked("")).toBe(false);
	});
});
