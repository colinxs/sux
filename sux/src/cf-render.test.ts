import { beforeEach, describe, expect, it, vi } from "vitest";

// cfRender is the Cloudflare Browser Rendering client extracted from the render
// fn — the `cf` half of the retailer fns' mac→cf fallback. render.test.ts exercises
// it through `render`; these pin its OWN never-throw envelope and the html/text vs
// screenshot(bytes) result shapes the retail fallback and render both rely on.

const stubs = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts: any) => {}),
	content: vi.fn(async () => "<html>rendered</html>"),
	evaluate: vi.fn(async (_fn: any) => "rendered text"),
	screenshot: vi.fn(async (_opts: any) => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
	pdf: vi.fn(async (_opts: any) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
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
		content: stubs.content,
		evaluate: stubs.evaluate,
		screenshot: stubs.screenshot,
		pdf: stubs.pdf,
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
vi.mock("./proxy", () => ({ smartFetch: smartFetchMock }));

import { cfRender } from "./cf-render";

const BROWSER_ENV = { BROWSER: { fetch: async () => new Response() } } as any;

// Grab the fire-and-forget request handler cfRender registered via page.on.
function capturedRequestHandler(): (req: any) => Promise<void> {
	const call = stubs.on.mock.calls.find((c) => c[0] === "request");
	if (!call) throw new Error("no request handler was registered");
	const raw = call[1] as (req: any) => void;
	return async (req: any) => {
		raw(req);
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
}

function fakeReq(over: Partial<Record<string, any>> = {}) {
	return {
		resourceType: () => over.resourceType ?? "document",
		url: () => over.url ?? "https://example.com/asset",
		method: () => over.method ?? "GET",
		headers: () => over.headers ?? { accept: "*/*" },
		postData: () => over.postData,
		abort: vi.fn(async (): Promise<void> => {}),
		continue: vi.fn(async (): Promise<void> => {}),
		respond: vi.fn(async (): Promise<void> => {}),
	};
}

describe("cfRender", () => {
	beforeEach(() => {
		stubs.goto.mockClear().mockResolvedValue(undefined as any);
		stubs.content.mockClear().mockResolvedValue("<html>rendered</html>");
		stubs.evaluate.mockClear().mockResolvedValue("rendered text");
		stubs.screenshot.mockClear().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		stubs.pdf.mockClear().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
		stubs.setRequestInterception.mockClear().mockResolvedValue(undefined as any);
		stubs.on.mockClear();
		stubs.close.mockClear().mockResolvedValue(undefined as any);
		stubs.launch.mockClear();
		smartFetchMock.mockClear().mockImplementation(async () => new Response("<html>from-proxy</html>", { status: 200, headers: { "content-type": "text/html" } }));
	});

	it("returns ok:false and never launches when the BROWSER binding is absent", async () => {
		const r = await cfRender({} as any, { url: "https://example.com" });
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/BROWSER binding/) });
		expect(stubs.launch).not.toHaveBeenCalled();
	});

	it("html: returns the rendered content string and closes the browser", async () => {
		const r = await cfRender(BROWSER_ENV, { url: "https://example.com" });
		expect(r).toEqual({ ok: true, contentType: "text/html", body: "<html>rendered</html>" });
		expect(stubs.content).toHaveBeenCalled();
		expect(stubs.close).toHaveBeenCalled();
	});

	it("stealth UA advertises a current Chrome major, not the stale pinned 124", async () => {
		stubs.setUserAgent.mockClear();
		await cfRender(BROWSER_ENV, { url: "https://example.com" });
		const ua = stubs.setUserAgent.mock.calls[0][0] as string;
		expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
		const major = Number(ua.match(/Chrome\/(\d+)\./)![1]);
		expect(major).toBeGreaterThan(124);
	});

	it("STEALTH_CHROME_MAJOR env overrides the UA's Chrome major (bump without redeploy)", async () => {
		stubs.setUserAgent.mockClear();
		await cfRender({ ...BROWSER_ENV, STEALTH_CHROME_MAJOR: "141" } as any, { url: "https://example.com" });
		expect(stubs.setUserAgent.mock.calls[0][0]).toMatch(/Chrome\/141\.0\.0\.0/);
	});

	it("text: returns the page innerText as text/plain", async () => {
		const r = await cfRender(BROWSER_ENV, { url: "https://example.com", as: "text" });
		expect(r).toEqual({ ok: true, contentType: "text/plain", body: "rendered text" });
		expect(stubs.evaluate).toHaveBeenCalled();
	});

	it("screenshot: returns raw PNG bytes (not a string body)", async () => {
		const r = await cfRender(BROWSER_ENV, { url: "https://example.com", as: "screenshot" });
		expect(r.ok).toBe(true);
		if (!r.ok || !("bytes" in r)) throw new Error("expected bytes result");
		expect(r.contentType).toBe("image/png");
		expect(Array.from(r.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(stubs.screenshot).toHaveBeenCalledWith({ fullPage: false });
	});

	it("returns ok:false (never throws) and still closes the browser when goto throws", async () => {
		stubs.goto.mockRejectedValueOnce(new Error("nav boom"));
		const r = await cfRender(BROWSER_ENV, { url: "https://example.com" });
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/nav boom/) });
		expect(stubs.close).toHaveBeenCalled();
	});

	it("residential (default) routes a document through smartFetch and responds with its bytes", async () => {
		smartFetchMock.mockResolvedValueOnce(new Response("<html>proxied</html>", { status: 201, headers: { "content-type": "text/html", "content-encoding": "gzip" } }));
		await cfRender(BROWSER_ENV, { url: "https://akamai.example" });
		expect(stubs.setRequestInterception).toHaveBeenCalledWith(true);
		const handler = capturedRequestHandler();
		const docReq = fakeReq({ resourceType: "document", url: "https://akamai.example", headers: { accept: "text/html" } });
		await handler(docReq);
		expect(smartFetchMock).toHaveBeenCalledWith(BROWSER_ENV, "https://akamai.example", { method: "GET", headers: { accept: "text/html" }, body: undefined });
		const respondArg = (docReq.respond as any).mock.calls[0][0];
		expect(respondArg.status).toBe(201);
		expect(new TextDecoder().decode(respondArg.body)).toBe("<html>proxied</html>");
		// Framing header dropped (smartFetch already decoded the body).
		expect(Object.keys(respondArg.headers).map((k) => k.toLowerCase())).not.toContain("content-encoding");
	});

	it("block_resources (residential off) aborts image requests, continues documents", async () => {
		await cfRender(BROWSER_ENV, { url: "https://example.com", block_resources: true, residential: false });
		const handler = capturedRequestHandler();
		const img = fakeReq({ resourceType: "image" });
		await handler(img);
		expect(img.abort).toHaveBeenCalled();
		const doc = fakeReq({ resourceType: "document" });
		await handler(doc);
		expect(doc.continue).toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalled();
	});
});
