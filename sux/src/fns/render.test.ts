import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A shared, resettable set of stubs the mocked puppeteer.launch() yields, so
// each test can assert what goto received and that close() ran. Declared via
// vi.hoisted so they exist when the (hoisted) vi.mock factory runs.
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
// hmacHex is used by the mac backend to sign the render request. Stub it to a
// deterministic 64-hex-char digest so the signed-endpoint assertion is stable.
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
		stubs.evaluate.mockClear().mockResolvedValue("rendered text");
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

	// --- backend:"mac" (residential patchright service) ---

	describe("backend:mac", () => {
		// The Mac service is reached via global fetch (not puppeteer/smartFetch), so
		// stub global fetch per test to a fake JSON envelope and inspect the request.
		const MAC_ENV = { ...CAS_ENV, MAC_RENDER_URL: "https://mac.example.ts.net", MAC_RENDER_SECRET: "s3cr3t" } as any;
		const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
		let fetchSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			fetchSpy = vi.spyOn(globalThis, "fetch") as any;
		});
		afterEach(() => {
			fetchSpy.mockRestore();
		});

		const macJson = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

		it("html: POSTs a signed payload to /render and returns the body", async () => {
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>from-mac</html>" }));
			const r = await render.run(MAC_ENV, { url: "https://homedepot.com/p/123", backend: "mac", as: "html", wait_ms: 500 });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("<html>from-mac</html>");
			// The puppeteer path was never touched — no navigation happened for this render.
			expect(stubs.goto).not.toHaveBeenCalled();
			// POSTed to the signed endpoint.
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(endpoint).toMatch(/^https:\/\/mac\.example\.ts\.net\/render\?ts=\d+&sig=[0-9a-f]{64}$/);
			expect(init.method).toBe("POST");
			// The payload is well-shaped pass-through of the render args.
			const payload = JSON.parse(init.body as string);
			expect(payload).toMatchObject({
				url: "https://homedepot.com/p/123",
				as: "html",
				wait_until: "networkidle0",
				wait_ms: 500,
				block_resources: false,
				full_page: false,
				timeout_ms: 30000,
			});
		});

		it("text: returns the body text", async () => {
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/plain", body: "visible mac text" }));
			const r = await render.run(MAC_ENV, { url: "https://walmart.com", backend: "mac", as: "text" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("visible mac text");
			const payload = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body);
			expect(payload.as).toBe("text");
		});

		it("screenshot: decodes the base64 body and delivers a /s/<uuid> CAS ref", async () => {
			const png = [0x89, 0x50, 0x4e, 0x47];
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "image/png", bodyEncoding: "base64", body: b64(png) }));
			const r = await render.run(MAC_ENV, { url: "https://homedepot.com", backend: "mac", as: "screenshot" });
			expect(r.isError).toBeFalsy();
			const ref = JSON.parse(r.content[0].text);
			expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
			expect(ref.content_type).toBe("image/png");
			expect(ref.size).toBe(4);
		});

		it("screenshot: inlines base64 with delivery:base64", async () => {
			const png = [0x89, 0x50, 0x4e, 0x47];
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "image/png", bodyEncoding: "base64", body: b64(png) }));
			const r = await render.run(MAC_ENV, { url: "https://homedepot.com", backend: "mac", as: "screenshot", delivery: "base64" });
			expect(r.isError).toBeFalsy();
			const out = JSON.parse(r.content[0].text);
			expect(out.mime).toBe("image/png");
			expect(out.size).toBe(4);
			expect(typeof out.base64).toBe("string");
		});

		it("SSRF: never forwards a private/LAN target to the residential mac node", async () => {
			// The mac node sits inside the home LAN and does no SSRF guarding of its own,
			// so the worker-side guard is the only defense — a LAN literal must be
			// refused before any signed /render request is POSTed to the node.
			for (const url of ["http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:10.0.0.1]/"]) {
				const r = await render.run(MAC_ENV, { url, backend: "mac" });
				expect(r.isError, url).toBe(true);
				expect(r.content[0].text, url).toMatch(/private\/loopback\/link-local\/metadata/);
			}
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("fails when MAC_RENDER_URL/MAC_RENDER_SECRET are absent (no fetch attempted)", async () => {
			const r = await render.run(CAS_ENV, { url: "https://example.com", backend: "mac" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/MAC_RENDER_URL\/MAC_RENDER_SECRET/);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("surfaces an {error} envelope from the service as a failure", async () => {
			fetchSpy.mockResolvedValueOnce(macJson({ error: "challenge unsolved" }));
			const r = await render.run(MAC_ENV, { url: "https://homedepot.com", backend: "mac" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/challenge unsolved/);
		});

		it("surfaces a non-200 response as a failure", async () => {
			fetchSpy.mockResolvedValueOnce(macJson({}, 502));
			const r = await render.run(MAC_ENV, { url: "https://homedepot.com", backend: "mac" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/HTTP 502/);
		});

		it("a bot-wall page returned as a 200 surfaces as an error, not as content (looksBlocked guard)", async () => {
			// The node answers a challenge/block page as valid HTML with status 200 — without
			// the guard render would hand the wall back as a successful body.
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html><body>Access Denied Reference #18.abc</body></html>" }));
			const r = await render.run(MAC_ENV, { url: "https://walmart.com", backend: "mac" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/bot wall/);
		});

		it("names a solver_error when the walled page also reports a CapSolver breakage", async () => {
			fetchSpy.mockResolvedValueOnce(
				macJson({ status: 200, content_type: "text/html", body: "<html><body>Pardon Our Interruption</body></html>", solver_error: "capsolver timeout" }),
			);
			const r = await render.run(MAC_ENV, { url: "https://walmart.com", backend: "mac" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/solver errored: capsolver timeout/);
		});

		it("a genuine (non-wall) page still returns as content even if a solver_error rode along", async () => {
			// solver_error without a wall means the solver tripped but the page loaded fine —
			// the happy path (return the content) must be unchanged.
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>real product page</html>", solver_error: "capsolver 429" }));
			const r = await render.run(MAC_ENV, { url: "https://homedepot.com/p/1", backend: "mac" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0].text).toBe("<html>real product page</html>");
		});
	});
});
