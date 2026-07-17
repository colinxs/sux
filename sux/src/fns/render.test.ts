import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A shared, resettable set of stubs the mocked puppeteer.launch() yields, so
// each test can assert what goto received and that close() ran. Declared via
// vi.hoisted so they exist when the (hoisted) vi.mock factory runs.
// WebMCP fast-path stubs: `evaluate` is the ONE puppeteer hook both the
// existing as:"text" innerText extraction and the new detectWebMcp/
// callWebMcpTool helpers call through, so the shared mock below routes by
// the passed function's source (it references "modelContext") rather than
// call order — same trick as capturedRequestHandler's arg-based matching.
const webmcp = vi.hoisted(() => ({
	detection: { detected: false, tools: [] as string[] },
	call: { ok: false } as { ok: false } | { ok: true; result: unknown },
}));

const stubs = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts: any) => {}),
	content: vi.fn(async () => "<html>rendered</html>"),
	evaluate: vi.fn(async (fn: any, ...args: any[]): Promise<string | typeof webmcp.detection | typeof webmcp.call> => {
		const src = fn.toString();
		if (src.includes("modelContext")) return args.length > 0 ? webmcp.call : webmcp.detection;
		return "rendered text";
	}),
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
	const browser = {
		newPage: stubs.newPage.mockResolvedValue(page as any),
		close: stubs.close,
	};
	return { default: { launch: stubs.launch.mockResolvedValue(browser as any) } };
});

// smartFetch is the residential path render now routes intercepted requests
// through. Mock it so tests can assert the handler calls it and forwards its
// status/body to request.respond, and can simulate a throw for graceful fallback.
const smartFetchMock = vi.hoisted(() => vi.fn());
// hmacHex is a proxy export; stub it deterministically so the ../proxy mock stays
// complete (render itself no longer signs any request now that it's cf-only).
const hmacHexMock = vi.hoisted(() => vi.fn(async (_secret: string, _msg: string) => "a".repeat(64)));
// isBlockedTarget is the SSRF guard render applies to `url`; use the REAL impl so
// the guard's actual private/loopback/metadata logic is exercised, not a stub.
vi.mock("../proxy", async (importActual) => {
	const actual = await importActual<typeof import("../proxy")>();
	return { smartFetch: smartFetchMock, hmacHex: hmacHexMock, isBlockedTarget: actual.isBlockedTarget };
});

import { render } from "./render";

// Grab the request-interception handler render registered via page.on("request").
// The registered handler is fire-and-forget (`void handleRequest(...)`), so tests
// invoke it via `drive` which also flushes the pending microtask chain (smartFetch
// → arrayBuffer → respond) before assertions run.
function capturedRequestHandler(): (req: any) => Promise<void> {
	const call = stubs.on.mock.calls.find((c) => c[0] === "request");
	if (!call) throw new Error("no request handler was registered");
	const raw = call[1] as (req: any) => void;
	return async (req: any) => {
		raw(req);
		// A handful of macrotask turns drains the async handler's await points
		// (mocked smartFetch resolve, arrayBuffer, respond/continue) deterministically.
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
}

// A fake intercepted request whose spies (respond/continue/abort) tests inspect.
function fakeReq(over: Partial<Record<string, any>> = {}) {
	return {
		resourceType: () => over.resourceType ?? "document",
		url: () => over.url ?? "https://example.com/asset",
		method: () => over.method ?? "GET",
		headers: () => over.headers ?? { accept: "*/*" },
		postData: () => over.postData,
		abort: vi.fn(async (): Promise<void> => {}),
		continue: vi.fn(async (): Promise<void> => {}),
		respond: vi.fn(async (_r: { status: number; headers: Record<string, string>; contentType?: string; body: Uint8Array }): Promise<void> => {}),
	};
}

const BROWSER_ENV = { BROWSER: { fetch: async () => new Response() } } as any;
// Screenshot as:"url" delivery goes through deliverBytes → putBlob, which needs
// the R2 + KV bindings; the stubs just have to accept the writes.
const CAS_ENV = { ...BROWSER_ENV, R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;

describe("render", () => {
	beforeEach(() => {
		stubs.goto.mockClear().mockResolvedValue(undefined as any);
		stubs.content.mockClear().mockResolvedValue("<html>rendered</html>");
		stubs.evaluate.mockClear().mockImplementation(async (fn: any, ...args: any[]) => {
			const src = fn.toString();
			if (src.includes("modelContext")) return args.length > 0 ? webmcp.call : webmcp.detection;
			return "rendered text";
		});
		webmcp.detection = { detected: false, tools: [] };
		webmcp.call = { ok: false };
		stubs.screenshot.mockClear().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		stubs.pdf.mockClear().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
		stubs.setRequestInterception.mockClear().mockResolvedValue(undefined as any);
		stubs.on.mockClear();
		stubs.setUserAgent.mockClear().mockResolvedValue(undefined as any);
		stubs.setViewport.mockClear().mockResolvedValue(undefined as any);
		stubs.setExtraHTTPHeaders.mockClear().mockResolvedValue(undefined as any);
		stubs.evaluateOnNewDocument.mockClear().mockResolvedValue(undefined as any);
		stubs.close.mockClear().mockResolvedValue(undefined as any);
		// Return a FRESH Response per call — a Response body can only be read once,
		// so a shared instance would throw on the second intercepted request.
		smartFetchMock.mockClear().mockImplementation(async () => new Response("<html>from-proxy</html>", { status: 200, headers: { "content-type": "text/html" } }));
	});

	it("html mode returns the rendered content", async () => {
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("<html>rendered</html>");
		expect(stubs.content).toHaveBeenCalled();
		expect(stubs.close).toHaveBeenCalled();
	});

	it("text mode returns the page innerText", async () => {
		const r = await render.run(BROWSER_ENV, { url: "https://example.com", as: "text" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("rendered text");
		expect(stubs.evaluate).toHaveBeenCalled();
		expect(stubs.close).toHaveBeenCalled();
	});

	it("a bot-wall page returned as a 200 surfaces as an error, not as content (backend:cf looksBlocked guard)", async () => {
		stubs.content.mockResolvedValueOnce("<html><body>Access Denied Reference #18.abc</body></html>");
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/cf render blocked/i);
	});

	it("passes wait_until and timeout through to goto", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", wait_until: "domcontentloaded", timeout_ms: 5000 });
		expect(stubs.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "domcontentloaded", timeout: 5000 });
	});

	it("debug_recording:true forwards { recording: true } to puppeteer.launch (Browser Run session recording)", async () => {
		stubs.launch.mockClear();
		await render.run(BROWSER_ENV, { url: "https://example.com", debug_recording: true });
		expect(stubs.launch).toHaveBeenCalledWith(BROWSER_ENV.BROWSER, { recording: true });
	});

	it("debug_recording defaults to false (no recording option passed)", async () => {
		stubs.launch.mockClear();
		await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(stubs.launch).toHaveBeenCalledWith(BROWSER_ENV.BROWSER);
	});

	it("fails when the BROWSER binding is absent", async () => {
		const r = await render.run({} as any, { url: "https://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/BROWSER binding/);
		expect(stubs.launch).not.toHaveBeenCalledWith(undefined);
	});

	it("rejects a non-http url", async () => {
		const r = await render.run(BROWSER_ENV, { url: "ftp://example.com/x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("SSRF: refuses private/loopback/link-local/metadata targets before rendering (never navigates)", async () => {
		// http(s)-scheme private/internal literals pass isHttpUrl but must be blocked
		// by the SSRF guard — the cf browser never navigates and no browser launches.
		stubs.launch.mockClear(); // launch isn't cleared in beforeEach — reset before asserting on it
		for (const url of [
			"http://127.0.0.1/",
			"http://192.168.1.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://100.64.0.1/",
			"http://localhost/admin",
			"http://[::1]/",
			"http://[::ffff:127.0.0.1]/",
		]) {
			const r = await render.run(BROWSER_ENV, { url });
			expect(r.isError, url).toBe(true);
			expect(r.content[0].text, url).toMatch(/private\/loopback\/link-local\/metadata/);
		}
		expect(stubs.launch).not.toHaveBeenCalled();
		expect(stubs.goto).not.toHaveBeenCalled();
	});

	it("closes the browser even when goto throws", async () => {
		stubs.goto.mockRejectedValueOnce(new Error("nav boom"));
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/nav boom/);
		expect(stubs.close).toHaveBeenCalled();
	});

	it("caps a huge rendered HTML page instead of returning it wholesale", async () => {
		const huge = "x".repeat(3_000_000);
		stubs.content.mockResolvedValueOnce(huge);
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		// Clamped to the 2MB output cap (+ a short truncation marker), not 3MB.
		expect(r.content[0].text.length).toBeLessThan(2_000_100);
		expect(r.content[0].text).toContain("truncated at 2000000 bytes");
	});

	it("caps huge rendered text (as:text) too", async () => {
		const huge = "y".repeat(3_000_000);
		stubs.evaluate.mockResolvedValueOnce(huge);
		const r = await render.run(BROWSER_ENV, { url: "https://example.com", as: "text" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text.length).toBeLessThan(2_000_100);
		expect(r.content[0].text).toContain("truncated at 2000000 bytes");
	});

	it("screenshot mode delivers a /s/<uuid> CAS ref by default", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot" });
		expect(r.isError).toBeFalsy();
		expect(stubs.screenshot).toHaveBeenCalledWith({ fullPage: false });
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("image/png");
		expect(ref.size).toBe(4); // the mocked PNG-magic bytes
		expect(stubs.close).toHaveBeenCalled();
	});

	it("screenshot mode inlines base64 with delivery:base64", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", delivery: "base64" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.mime).toBe("image/png");
		expect(out.size).toBe(4);
		expect(typeof out.base64).toBe("string");
	});

	it("full_page is passed through to page.screenshot", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", full_page: true });
		expect(stubs.screenshot).toHaveBeenCalledWith({ fullPage: true });
	});

	it("pdf mode delivers a /s/<uuid> CAS ref by default", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "pdf" });
		expect(r.isError).toBeFalsy();
		// Defaults: A4, portrait, backgrounds on.
		expect(stubs.pdf).toHaveBeenCalledWith({ format: "A4", landscape: false, printBackground: true });
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("application/pdf");
		expect(ref.size).toBe(5); // the mocked %PDF- header bytes
		expect(stubs.close).toHaveBeenCalled();
	});

	it("pdf mode inlines base64 with delivery:base64", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "pdf", delivery: "base64" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.mime).toBe("application/pdf");
		expect(out.size).toBe(5);
		expect(typeof out.base64).toBe("string");
	});

	it("format/landscape/print_background are passed through to page.pdf", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "pdf", format: "Legal", landscape: true, print_background: false });
		expect(stubs.pdf).toHaveBeenCalledWith({ format: "Legal", landscape: true, printBackground: false });
	});

	it("block_resources (residential off) installs interception and aborts image requests", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", as: "text", block_resources: true, residential: false });
		expect(stubs.setRequestInterception).toHaveBeenCalledWith(true);
		expect(stubs.on).toHaveBeenCalledWith("request", expect.any(Function));
		// Drive the registered handler: an image request aborts, a document continues.
		const handler = capturedRequestHandler();
		const imgReq = fakeReq({ resourceType: "image" });
		await handler(imgReq);
		expect(imgReq.abort).toHaveBeenCalled();
		expect(imgReq.continue).not.toHaveBeenCalled();
		const docReq = fakeReq({ resourceType: "document" });
		await handler(docReq);
		// residential off → the browser fetches the document directly (continue), not smartFetch.
		expect(docReq.continue).toHaveBeenCalled();
		expect(docReq.abort).not.toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalled();
	});

	it("block_resources is ignored for screenshots when residential is off", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", block_resources: true, residential: false });
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
		expect(stubs.screenshot).toHaveBeenCalled();
	});

	it("does not install request interception when residential is off and block_resources is off", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", residential: false });
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
	});

	// --- residential routing (default true) ---

	it("residential:true routes a document request through smartFetch and responds with its bytes", async () => {
		smartFetchMock.mockResolvedValueOnce(
			new Response("<html>proxied-doc</html>", { status: 201, headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" } }),
		);
		await render.run(BROWSER_ENV, { url: "https://akamai-protected.example" });
		expect(stubs.setRequestInterception).toHaveBeenCalledWith(true);
		const handler = capturedRequestHandler();
		const docReq = fakeReq({ resourceType: "document", url: "https://akamai-protected.example", method: "GET", headers: { accept: "text/html" } });
		await handler(docReq);
		// Fetched residentially with the intercepted request's method/headers/url.
		expect(smartFetchMock).toHaveBeenCalledWith(BROWSER_ENV, "https://akamai-protected.example", {
			method: "GET",
			headers: { accept: "text/html" },
			body: undefined,
		});
		// Fulfilled the browser request with the residential status + bytes.
		expect(docReq.respond).toHaveBeenCalledTimes(1);
		const respondArg = docReq.respond.mock.calls[0][0];
		expect(respondArg.status).toBe(201);
		expect(respondArg.contentType).toBe("text/html; charset=utf-8");
		expect(new TextDecoder().decode(respondArg.body)).toBe("<html>proxied-doc</html>");
		// Framing headers dropped (smartFetch already decoded the body).
		expect(Object.keys(respondArg.headers).map((k) => k.toLowerCase())).not.toContain("content-encoding");
		expect(docReq.continue).not.toHaveBeenCalled();
		expect(docReq.abort).not.toHaveBeenCalled();
	});

	it("residential: a smartFetch throw degrades to request.continue() (never fails the render)", async () => {
		smartFetchMock.mockRejectedValueOnce(new Error("proxy down"));
		await render.run(BROWSER_ENV, { url: "https://example.com" });
		const handler = capturedRequestHandler();
		const req = fakeReq({ resourceType: "script", url: "https://example.com/app.js" });
		await handler(req);
		expect(smartFetchMock).toHaveBeenCalled();
		expect(req.continue).toHaveBeenCalledTimes(1);
		expect(req.respond).not.toHaveBeenCalled();
		expect(req.abort).not.toHaveBeenCalled();
	});

	it("residential on + block_resources on: heavy assets still abort, the rest route residentially", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", as: "text", block_resources: true });
		const handler = capturedRequestHandler();
		// An image is a heavy asset → aborted, never proxied.
		const imgReq = fakeReq({ resourceType: "image" });
		await handler(imgReq);
		expect(imgReq.abort).toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalledWith(expect.anything(), "https://example.com/asset", expect.anything());
		// A document is not heavy → residential-routed.
		const docReq = fakeReq({ resourceType: "document", url: "https://example.com/page" });
		await handler(docReq);
		expect(smartFetchMock).toHaveBeenCalledWith(BROWSER_ENV, "https://example.com/page", expect.anything());
		expect(docReq.respond).toHaveBeenCalled();
	});

	it("residential:false does NOT route through smartFetch (browser fetches directly)", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", residential: false });
		// No interception installed at all when neither residential nor block_resources is on.
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalled();
	});

	// --- stealth (default true) ---

	it("stealth (default) sets a realistic UA (no Headless), a desktop viewport, accept-language, and the webdriver mask", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com" });
		// Realistic desktop Chrome UA — crucially without the "HeadlessChrome" tell.
		expect(stubs.setUserAgent).toHaveBeenCalledTimes(1);
		const ua = stubs.setUserAgent.mock.calls[0][0];
		expect(ua).not.toMatch(/Headless/i);
		expect(ua).toMatch(/Chrome\//);
		// Real desktop viewport, not the headless default.
		expect(stubs.setViewport).toHaveBeenCalledWith({ width: 1280, height: 800, deviceScaleFactor: 1 });
		// Plausible accept-language.
		expect(stubs.setExtraHTTPHeaders).toHaveBeenCalledWith({ "accept-language": "en-US,en;q=0.9" });
		// navigator.webdriver mask installed before page scripts run.
		expect(stubs.evaluateOnNewDocument).toHaveBeenCalledTimes(1);
		expect(typeof stubs.evaluateOnNewDocument.mock.calls[0][0]).toBe("function");
	});

	it("stealth:false applies none of the fingerprint masking (today's headless behavior)", async () => {
		const r = await render.run(BROWSER_ENV, { url: "https://example.com", stealth: false });
		expect(r.isError).toBeFalsy();
		expect(stubs.setUserAgent).not.toHaveBeenCalled();
		expect(stubs.setViewport).not.toHaveBeenCalled();
		expect(stubs.setExtraHTTPHeaders).not.toHaveBeenCalled();
		expect(stubs.evaluateOnNewDocument).not.toHaveBeenCalled();
	});

	it("an unsupported/throwing stealth API degrades gracefully — the render still returns content", async () => {
		// Simulate a CF Browser Run build where setUserAgent isn't supported.
		stubs.setUserAgent.mockRejectedValueOnce(new Error("setUserAgent unsupported"));
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("<html>rendered</html>");
		// The remaining stealth steps still ran despite the earlier throw.
		expect(stubs.setViewport).toHaveBeenCalled();
		expect(stubs.setExtraHTTPHeaders).toHaveBeenCalled();
		expect(stubs.evaluateOnNewDocument).toHaveBeenCalled();
	});

	// --- WebMCP fast-path (experimental, backend:cf only) ---
	//
	// The detection/call step only runs at all when the caller names a
	// webmcp_tool — it must be a complete no-op (not even one extra
	// page.evaluate call) for every render that doesn't ask for it, which is
	// the vast majority of sux's traffic today.
	describe("webmcp fast-path", () => {
		it("is never attempted when webmcp_tool is not given (today's default behavior, unchanged)", async () => {
			const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("<html>rendered</html>");
			// content() (not evaluate()) served this — no modelContext probe ran at all.
			expect(stubs.evaluate).not.toHaveBeenCalled();
			expect(stubs.content).toHaveBeenCalled();
		});

		it("page doesn't support WebMCP (not detected) — falls back to normal html extraction", async () => {
			webmcp.detection = { detected: false, tools: [] };
			const r = await render.run(BROWSER_ENV, { url: "https://example.com", webmcp_tool: "get_price" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("<html>rendered</html>");
			expect(stubs.content).toHaveBeenCalled();
		});

		it("detected + declared tool call succeeds — returns the tool's result as JSON, skipping DOM extraction", async () => {
			webmcp.detection = { detected: true, tools: ["get_price"] };
			webmcp.call = { ok: true, result: { price: 9.99, currency: "USD" } };
			const r = await render.run(BROWSER_ENV, { url: "https://shop.example.com", webmcp_tool: "get_price", webmcp_args: { sku: "abc" } });
			expect(r.isError).toBeFalsy();
			expect(JSON.parse(r.content[0].text)).toEqual({ webmcp: true, tool: "get_price", result: { price: 9.99, currency: "USD" } });
			// The fast path short-circuited before the normal content() scrape ran.
			expect(stubs.content).not.toHaveBeenCalled();
			expect(stubs.close).toHaveBeenCalled();
		});

		it("detected but the tool call fails — falls back to normal html extraction, never surfaces an error", async () => {
			webmcp.detection = { detected: true, tools: ["get_price"] };
			webmcp.call = { ok: false };
			const r = await render.run(BROWSER_ENV, { url: "https://shop.example.com", webmcp_tool: "get_price" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("<html>rendered</html>");
			expect(stubs.content).toHaveBeenCalled();
		});

		it("detected but the requested tool call throws — degrades to normal extraction (page.evaluate rejects)", async () => {
			webmcp.detection = { detected: true, tools: ["get_price"] };
			stubs.evaluate.mockImplementation(async (fn: any, ...args: any[]) => {
				const src = fn.toString();
				if (src.includes("modelContext") && args.length > 0) throw new Error("tool threw");
				if (src.includes("modelContext")) return webmcp.detection;
				return "rendered text";
			});
			const r = await render.run(BROWSER_ENV, { url: "https://shop.example.com", webmcp_tool: "get_price" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("<html>rendered</html>");
		});

		it("works with as:text too — a successful tool call skips the innerText evaluate", async () => {
			webmcp.detection = { detected: true, tools: ["get_price"] };
			webmcp.call = { ok: true, result: "42" };
			const r = await render.run(BROWSER_ENV, { url: "https://shop.example.com", as: "text", webmcp_tool: "get_price" });
			expect(r.isError).toBeFalsy();
			expect(JSON.parse(r.content[0].text)).toEqual({ webmcp: true, tool: "get_price", result: "42" });
		});

		it("is skipped for screenshot/pdf (webmcp_tool ignored, DOM never probed)", async () => {
			webmcp.detection = { detected: true, tools: ["get_price"] };
			webmcp.call = { ok: true, result: "42" };
			const r = await render.run(CAS_ENV, { url: "https://shop.example.com", as: "screenshot", webmcp_tool: "get_price" });
			expect(r.isError).toBeFalsy();
			expect(stubs.screenshot).toHaveBeenCalled();
			expect(stubs.evaluate).not.toHaveBeenCalled();
		});
	});
});
