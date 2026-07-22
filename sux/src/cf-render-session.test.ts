import { beforeEach, describe, expect, it, vi } from "vitest";

// cfRenderSession drives a stepped, credentialed browser session (the portal
// scraper's engine). These pin its step execution, the CAPTCHA solve→inject
// handshake, and its never-hang/never-throw failure envelope — all against a
// mocked @cloudflare/puppeteer so no real browser is needed.

// Mutable knobs the hoisted page mock reads, so each test can steer the sitekey,
// the extracted fields, whether a selector rejects, and capture the injected token.
const state = vi.hoisted(() => ({
	sitekey: "SITEKEY123",
	fields: {} as Record<string, string | null>,
	text: "logged in — your credit score",
	rejectSelector: null as string | null,
	injectedToken: null as string | null,
	url: "https://portal.example.com/dashboard",
}));

const stubs = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts: any) => {}),
	waitForSelector: vi.fn(async (sel: string, _opts: any) => {
		if (state.rejectSelector && sel.includes(state.rejectSelector)) throw new Error(`waiting for selector \`${sel}\` failed: timeout 30000ms exceeded`);
	}),
	type: vi.fn(async (_sel: string, _text: string) => {}),
	click: vi.fn(async (_sel: string) => {}),
	press: vi.fn(async (_key: string) => {}),
	content: vi.fn(async () => "<html><body>dashboard</body></html>"),
	evaluate: vi.fn(async (fn: any, ...args: any[]) => {
		const src = String(fn);
		if (src.includes("dispatchEvent")) {
			state.injectedToken = args[0];
			return undefined;
		}
		if (src.includes("getAttribute")) return state.sitekey;
		return { fields: state.fields, text: state.text };
	}),
	url: vi.fn(() => state.url),
	setRequestInterception: vi.fn(async (_on: boolean) => {}),
	on: vi.fn((_evt: string, _handler: any) => {}),
	setUserAgent: vi.fn(async (_ua: string) => {}),
	setViewport: vi.fn(async (_v: any) => {}),
	setExtraHTTPHeaders: vi.fn(async (_h: Record<string, string>) => {}),
	evaluateOnNewDocument: vi.fn(async (_fn: any) => {}),
	close: vi.fn(async () => {}),
	newPage: vi.fn(),
	launch: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => {
	const page = {
		goto: stubs.goto,
		waitForSelector: stubs.waitForSelector,
		type: stubs.type,
		click: stubs.click,
		keyboard: { press: stubs.press },
		content: stubs.content,
		evaluate: stubs.evaluate,
		url: stubs.url,
		setRequestInterception: stubs.setRequestInterception,
		on: stubs.on,
		setUserAgent: stubs.setUserAgent,
		setViewport: stubs.setViewport,
		setExtraHTTPHeaders: stubs.setExtraHTTPHeaders,
		evaluateOnNewDocument: stubs.evaluateOnNewDocument,
	};
	const browser = { newPage: stubs.newPage.mockResolvedValue(page as any), close: stubs.close };
	return { default: { launch: stubs.launch.mockResolvedValue(browser as any) } };
});

const smartFetchMock = vi.hoisted(() => vi.fn());
vi.mock("./proxy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./proxy")>();
	return { ...actual, smartFetch: smartFetchMock };
});

import { type SessionStep, cfRenderSession } from "./cf-render";

const BROWSER_ENV = { BROWSER: { fetch: async () => new Response() } } as any;

beforeEach(() => {
	vi.clearAllMocks();
	state.sitekey = "SITEKEY123";
	state.fields = {};
	state.text = "logged in — your credit score";
	state.rejectSelector = null;
	state.injectedToken = null;
	state.url = "https://portal.example.com/dashboard";
	stubs.newPage.mockResolvedValue({
		goto: stubs.goto,
		waitForSelector: stubs.waitForSelector,
		type: stubs.type,
		click: stubs.click,
		keyboard: { press: stubs.press },
		content: stubs.content,
		evaluate: stubs.evaluate,
		url: stubs.url,
		setRequestInterception: stubs.setRequestInterception,
		on: stubs.on,
		setUserAgent: stubs.setUserAgent,
		setViewport: stubs.setViewport,
		setExtraHTTPHeaders: stubs.setExtraHTTPHeaders,
		evaluateOnNewDocument: stubs.evaluateOnNewDocument,
	} as any);
	stubs.launch.mockResolvedValue({ newPage: stubs.newPage, close: stubs.close } as any);
});

describe("cfRenderSession", () => {
	it("returns not-configured envelope when BROWSER is unbound", async () => {
		const r = await cfRenderSession({} as any, { start_url: "https://portal.example.com/login", steps: [] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/Browser Run is not configured/);
	});

	it("refuses a private/SSRF start_url", async () => {
		const r = await cfRenderSession(BROWSER_ENV, { start_url: "http://169.254.169.254/latest/meta-data", steps: [] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/private|loopback|metadata/i);
	});

	it("runs login steps in order and extracts fields", async () => {
		state.fields = { score: "742", bureau: "TransUnion" };
		const steps: SessionStep[] = [
			{ action: "type", selector: "#user", value: "alice@example.com" },
			{ action: "type", selector: "#pass", value: "s3cret" },
			{ action: "click", selector: "#submit" },
			{ action: "wait_for", selector: "#dashboard" },
		];
		const r = await cfRenderSession(BROWSER_ENV, { start_url: "https://portal.example.com/login", steps, extract_selectors: { score: "#score" } });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.fields).toEqual({ score: "742", bureau: "TransUnion" });
			expect(r.stepsRun).toBe(4);
			expect(r.finalUrl).toBe("https://portal.example.com/dashboard");
		}
		expect(stubs.goto).toHaveBeenCalledWith("https://portal.example.com/login", expect.anything());
		expect(stubs.type).toHaveBeenNthCalledWith(1, "#user", "alice@example.com");
		expect(stubs.type).toHaveBeenNthCalledWith(2, "#pass", "s3cret");
		expect(stubs.click).toHaveBeenCalledWith("#submit");
	});

	it("solves a CAPTCHA and injects the returned token into the page", async () => {
		const solveCaptcha = vi.fn(async () => "CAPTCHA_TOKEN");
		const steps: SessionStep[] = [{ action: "solve_captcha", provider: "recaptcha_v2" }];
		const r = await cfRenderSession(BROWSER_ENV, { start_url: "https://portal.example.com/login", steps, solveCaptcha });
		expect(r.ok).toBe(true);
		expect(solveCaptcha).toHaveBeenCalledWith({ provider: "recaptcha_v2", siteKey: "SITEKEY123", websiteUrl: "https://portal.example.com/dashboard" });
		// The token the solver returned was injected into the page via evaluate.
		expect(state.injectedToken).toBe("CAPTCHA_TOKEN");
	});

	it("fails honestly (no hang) when the solver returns null", async () => {
		const solveCaptcha = vi.fn(async () => null);
		const r = await cfRenderSession(BROWSER_ENV, { start_url: "https://portal.example.com/login", steps: [{ action: "solve_captcha", provider: "recaptcha_v2" }], solveCaptcha });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/captcha solve failed/);
	});

	it("fails (never throws) on a step timeout and returns a page snapshot", async () => {
		state.rejectSelector = "#never";
		state.text = "verify it's you — enter the code we sent";
		const r = await cfRenderSession(BROWSER_ENV, { start_url: "https://portal.example.com/login", steps: [{ action: "wait_for", selector: "#never" }] });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/session failed at step 1/);
			expect(r.text).toMatch(/verify it's you/); // snapshot captured for the caller to classify
		}
	});
});
