// Shared client for the Cloudflare Browser Run backend (`render`'s default `cf`
// engine): a headless Chromium (`@cloudflare/puppeteer`) that executes JS and —
// with `residential` routing + `stealth` masking — egresses from a home IP past
// datacenter-IP bot detection. The `render` fn drives it for arbitrary pages; the
// retailer fns reach it (via retail-render) as the PRIMARY leg, escalating to the
// paid unlocker only when cf can't clear a hard wall. Extracted from render.ts so
// both callers share ONE puppeteer driver instead of duplicating the
// launch/stealth/interception/goto dance.
//
// Cloudflare renamed this product "Browser Rendering" -> "Browser Run" (Apr 2026).
// The rename is additive only — same `@cloudflare/puppeteer` package, same `browser`
// wrangler binding, same `puppeteer.launch(env.BROWSER)` call shape — so nothing
// here needed to change for the rename itself. The new capabilities it shipped
// alongside (CDP endpoint, WebMCP, higher 30->120 concurrency) don't apply to this
// server-side Puppeteer path; `debug_recording` below opts into the one that does
// (session recordings), for post-mortem debugging of bot-wall failures.
//
// Never-throw envelope: a launch/nav failure or a missing BROWSER binding resolves
// to `{ ok:false, error }`. HTML/text return a string `body`; screenshot/pdf return
// raw `bytes` (the caller delivers them).

import puppeteer from "@cloudflare/puppeteer";
import { isBlockedTarget, smartFetch } from "./proxy";
import type { RtEnv } from "./registry";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

// Chrome's stable channel ships a new MAJOR roughly monthly, so a UA pinned to a
// fixed old major is itself a bot signal: the UA string, the TLS ClientHello, and
// the JS-runtime fingerprint have to stay COHERENT, and a request advertising an
// ancient Chrome/124 in 2026 reads as spoofed to a bot manager that knows the real
// current major. Track the current stable major here and BUMP it as Chrome ships;
// `STEALTH_CHROME_MAJOR` env overrides it so we can follow the channel without a
// redeploy. Keep this UA moving with the viewport/accept-language as one identity.
const DEFAULT_STEALTH_CHROME_MAJOR = 138;

function stealthUa(chromeMajor: number | string): string {
	return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

const STEALTH_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 } as const;
const STEALTH_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

type PageForStealth = {
	setUserAgent?(ua: string): void | Promise<void>;
	setViewport?(v: { width: number; height: number; deviceScaleFactor?: number }): void | Promise<void>;
	setExtraHTTPHeaders?(headers: Record<string, string>): void | Promise<void>;
	evaluateOnNewDocument?(fn: (...args: unknown[]) => unknown): void | Promise<void>;
};

async function applyStealth(page: PageForStealth, ua: string): Promise<void> {

	try {
		if (typeof page.setUserAgent === "function") await page.setUserAgent(ua);
	} catch {
		// setUserAgent unsupported on this build — skip; the (headless) UA remains.
	}

	try {
		if (typeof page.setViewport === "function") await page.setViewport({ ...STEALTH_VIEWPORT });
	} catch {
		// setViewport unsupported — skip; the default viewport remains.
	}

	try {
		if (typeof page.setExtraHTTPHeaders === "function") await page.setExtraHTTPHeaders({ "accept-language": STEALTH_ACCEPT_LANGUAGE });
	} catch {
		// setExtraHTTPHeaders unsupported — skip; Chromium's own accept-language stands.
	}

	try {
		if (typeof page.evaluateOnNewDocument === "function") {
			await page.evaluateOnNewDocument(() => {
				Object.defineProperty(navigator, "webdriver", { get: () => undefined });
			});
		}
	} catch {
		// evaluateOnNewDocument unsupported — skip; navigator.webdriver stays as-is.
	}
}

// --- WebMCP fast-path (experimental, added 2026-07-13) ---------------------
//
// WebMCP (navigator.modelContext) lets a cooperating site declare callable
// tools for an agent instead of forcing DOM scraping. As of this writing it's
// a Chrome 149 origin trial only (public since ~June 2026; explainer at
// github.com/webmachinelearning/webmcp) — adoption is effectively zero today,
// and the explainer itself marks the tool-listing/-calling methods
// (getTools/listTools, callTool/executeTool) as "TODO: spec and describe", and
// is inconsistent about whether the surface hangs off `navigator` (per Chrome
// for Developers docs) or `document` (per the explainer's own example). So
// this checks BOTH objects and tries every plausible method name defensively,
// wrapped so any shape mismatch — expected, since the spec is still moving —
// degrades to "not detected" rather than breaking the render.
//
// This is a genuinely optional fast path: it only activates when the caller
// names a specific tool (`webmcpTool`) to call, and only short-circuits the
// existing scrape/extract logic if that call actually succeeds. Every other
// render — i.e. the vast majority of sites, which don't support WebMCP at
// all — is completely unaffected; this code path never even runs for them.
const WEBMCP_TIMEOUT_MS = 3000;

export type WebMcpDetection = { detected: boolean; tools: string[] };

type EvaluatablePage = { evaluate: (fn: (...a: any[]) => unknown, ...args: any[]) => Promise<unknown> };

/** Best-effort check for a WebMCP-capable page. Never throws; times out fast
 * so a hung/unsupported page.evaluate can't stall the render. */
async function detectWebMcp(page: EvaluatablePage): Promise<WebMcpDetection> {
	try {
		return (await Promise.race([
			page.evaluate(() => {
				try {
					const nav = (globalThis as any).navigator;
					const doc = (globalThis as any).document;
					const mc = nav?.modelContext ?? doc?.modelContext;
					if (!mc) return { detected: false, tools: [] };
					let tools: string[] = [];
					try {
						const list = typeof mc.getTools === "function" ? mc.getTools() : typeof mc.listTools === "function" ? mc.listTools() : mc.tools;
						if (Array.isArray(list)) tools = list.map((t: any) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
					} catch {
						// Listing isn't spec'd yet — detection alone still stands.
					}
					return { detected: true, tools };
				} catch {
					return { detected: false, tools: [] };
				}
			}),
			new Promise<WebMcpDetection>((resolve) => setTimeout(() => resolve({ detected: false, tools: [] }), WEBMCP_TIMEOUT_MS)),
		])) as WebMcpDetection;
	} catch {
		return { detected: false, tools: [] };
	}
}

/** Best-effort call of a named WebMCP tool with `args`. Never throws — any
 * absence/shape-mismatch/exception resolves to `{ ok:false }` so the caller
 * always has a clean fallback to the existing scrape/extract logic. */
async function callWebMcpTool(page: EvaluatablePage, name: string, args: Record<string, unknown> | undefined): Promise<{ ok: true; result: unknown } | { ok: false }> {
	try {
		return (await Promise.race([
			page.evaluate(
				async (toolName: string, toolArgs: unknown) => {
					try {
						const nav = (globalThis as any).navigator;
						const doc = (globalThis as any).document;
						const mc = nav?.modelContext ?? doc?.modelContext;
						if (!mc) return { ok: false };
						if (typeof mc.callTool === "function") return { ok: true, result: await mc.callTool(toolName, toolArgs) };
						if (typeof mc.executeTool === "function") return { ok: true, result: await mc.executeTool(toolName, toolArgs) };
						// Fall back to invoking a listed tool's own `execute` directly, in
						// case the page's registry is introspectable but has no call method.
						const list = typeof mc.getTools === "function" ? mc.getTools() : typeof mc.listTools === "function" ? mc.listTools() : mc.tools;
						const found = Array.isArray(list) ? list.find((t: any) => (typeof t === "string" ? t === toolName : t?.name === toolName)) : undefined;
						if (found && typeof found.execute === "function") return { ok: true, result: await found.execute(toolArgs) };
						return { ok: false };
					} catch {
						return { ok: false };
					}
				},
				name,
				args ?? {},
			),
			new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), WEBMCP_TIMEOUT_MS)),
		])) as { ok: true; result: unknown } | { ok: false };
	} catch {
		return { ok: false };
	}
}

const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

type RequestForInterception = {
	resourceType(): string;
	url(): string;
	method(): string;
	headers(): Record<string, string>;
	postData(): string | undefined;
	abort(): void | Promise<void>;
	continue(): void | Promise<void>;
	respond(r: { status: number; headers: Record<string, string>; contentType?: string; body: Uint8Array }): void | Promise<void>;
};

async function handleRequest(
	env: Parameters<typeof smartFetch>[0],
	req: RequestForInterception,
	opts: { residential: boolean; blockResources: boolean },
): Promise<void> {
	// SSRF guard: every request Chromium makes after the initial page.goto — a
	// redirect hop, a client-side window.location navigation, a subresource
	// fetch — must be re-validated here too, not just the original URL (which
	// render.ts checks once before navigation even starts). Runs regardless of
	// residential/blockResources so neither flag combination leaves a gap (#927).
	if (isBlockedTarget(req.url())) {
		try {
			await req.abort();
		} catch {
			// Even abort can race a closing page; swallow so nothing is left un-handled.
		}
		return;
	}
	if (opts.blockResources && BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
		try {
			await req.abort();
		} catch {
			// Even abort can race a closing page; swallow so nothing is left un-handled.
		}
		return;
	}
	if (!opts.residential) {

		try {
			await req.continue();
		} catch {
			/* request already resolved by a teardown race — nothing to do. */
		}
		return;
	}

	try {
		const r = await smartFetch(env, req.url(), { method: req.method(), headers: req.headers(), body: req.postData() });
		const bytes = new Uint8Array(await r.arrayBuffer());
		const headers: Record<string, string> = {};
		let contentType: string | undefined;
		r.headers.forEach((value, key) => {
			const lower = key.toLowerCase();
			if (lower === "content-type") contentType = value;
			if (STRIP_RESPONSE_HEADERS.has(lower)) return;
			headers[key] = value;
		});
		await req.respond({ status: r.status, headers, contentType, body: bytes });
	} catch {

		try {
			await req.continue();
		} catch {
			/* already resolved elsewhere — safe to ignore. */
		}
	}
}

// What a caller asks the cf backend to render. Only `url` is required; the rest
// mirror the render fn's knobs and default sensibly for HTML extraction.
export type CfRenderSpec = {
	url: string;
	as?: string;
	wait_until?: string;
	wait_ms?: number;
	block_resources?: boolean;
	residential?: boolean;
	stealth?: boolean;
	timeout_ms?: number;
	full_page?: boolean;
	format?: string;
	landscape?: boolean;
	print_background?: boolean;
	// Opt into a Browser Run session recording (viewable in the CF dashboard under
	// Browser Run > Runs after the session closes) — for debugging a render that
	// came back blocked/wrong without adding server-side screenshot noise. Off by
	// default: recordings cost a bit of overhead and aren't needed on the hot path.
	debug_recording?: boolean;
	// Experimental WebMCP fast-path (see the block above): when set AND the page
	// declares navigator.modelContext/document.modelContext, call this tool
	// instead of scraping the DOM. Ignored for as:screenshot/pdf. No-op (falls
	// through to normal extraction) if undetected, the tool is missing, or the
	// call throws.
	webmcpTool?: string;
	webmcpArgs?: Record<string, unknown>;
};

// For html/text the payload is the string `body`; for screenshot/pdf it is the raw
// `bytes` (the caller decides delivery). On any failure: `{ ok:false, error }`.
export type CfRenderResult =
	| { ok: true; contentType: string; body: string; webmcp?: WebMcpDetection }
	| { ok: true; contentType: string; bytes: Uint8Array }
	| { ok: false; error: string };

/**
 * Drive Cloudflare Browser Run for one page and return the result. Never throws:
 * a missing BROWSER binding or any launch/navigation error resolves to
 * `{ ok:false, error }`, and the browser is always closed. `residential` routes
 * every subresource through the Tailscale residential proxy (home-IP egress);
 * `stealth` masks the headless fingerprint; `block_resources` aborts heavy assets
 * (ignored for screenshot/pdf so they render correctly); `debug_recording` opts
 * the session into Browser Run's session-recording feature for post-mortem replay.
 */
export async function cfRender(env: RtEnv, spec: CfRenderSpec): Promise<CfRenderResult> {
	if (!env.BROWSER) return { ok: false, error: "Browser Run is not configured (BROWSER binding)." };

	const as = spec.as === "text" ? "text" : spec.as === "screenshot" ? "screenshot" : spec.as === "pdf" ? "pdf" : "html";
	const waitUntil = spec.wait_until ?? "networkidle0";
	const timeout = spec.timeout_ms ?? 30000;
	const waitMs = spec.wait_ms ?? 0;
	const fullPage = spec.full_page === true;
	const format = spec.format ?? "A4";
	const landscape = spec.landscape === true;
	const printBackground = spec.print_background !== false;
	const blockResources = spec.block_resources === true && as !== "screenshot" && as !== "pdf";
	const residential = spec.residential !== false;
	const stealth = spec.stealth !== false;
	const debugRecording = spec.debug_recording === true;

	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	try {
		// `recording` is a Browser Run launch option (session recordings, replayable
		// in the CF dashboard); omit the key entirely when off rather than passing
		// `recording:false` so older `@cloudflare/puppeteer` builds that predate the
		// option see a plain launch call.
		browser = debugRecording ? await puppeteer.launch(env.BROWSER, { recording: true }) : await puppeteer.launch(env.BROWSER);
		const page = await browser.newPage();

		if (stealth) await applyStealth(page as unknown as PageForStealth, stealthUa(env.STEALTH_CHROME_MAJOR || DEFAULT_STEALTH_CHROME_MAJOR));

		// Installed unconditionally (not just when residential/blockResources ask for
		// proxying/asset-blocking) so the SSRF check inside handleRequest runs on every
		// request regardless of flags — a redirect or JS navigation away from the
		// initial (already-checked) URL must still be validated (#927).
		await page.setRequestInterception(true);
		page.on("request", (req: RequestForInterception) => {
			void handleRequest(env, req, { residential, blockResources });
		});
		// waitUntil/format are validated strings; cast to puppeteer's literal unions.
		await page.goto(spec.url, { waitUntil, timeout } as Parameters<typeof page.goto>[1]);
		if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

		// WebMCP fast-path — early in the render tier, before any DOM
		// scraping/extraction below. Only engages when the caller named a tool
		// AND the page actually declares navigator.modelContext/document.modelContext;
		// otherwise falls straight through to the html/text/screenshot/pdf paths
		// unchanged (see the detectWebMcp/callWebMcpTool comment above).
		if (spec.webmcpTool && (as === "html" || as === "text")) {
			const detection = await detectWebMcp(page as unknown as EvaluatablePage);
			if (detection.detected) {
				const called = await callWebMcpTool(page as unknown as EvaluatablePage, spec.webmcpTool, spec.webmcpArgs);
				if (called.ok) {
					return {
						ok: true,
						contentType: "application/json",
						body: JSON.stringify({ webmcp: true, tool: spec.webmcpTool, result: called.result }),
						webmcp: detection,
					};
				}
			}
		}

		if (as === "screenshot" || as === "pdf") {
			// Navigation is already done; drop CDP Fetch-domain interception before
			// the capture call so it can't race Page.printToPDF/Page.captureScreenshot.
			await page.setRequestInterception(false);
		}

		if (as === "screenshot") {
			const shot = await page.screenshot({ fullPage });
			const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot as ArrayBuffer);
			return { ok: true, contentType: "image/png", bytes };
		}
		if (as === "pdf") {
			// CDP's Fetch-domain interception (residential/blockResources above) races
			// Page.printToPDF — the print commits before the intercepted frame tree
			// settles, producing a structurally valid PDF whose content stream is
			// /Length 0. Navigation already completed by this point, so it's safe to
			// drop interception before printing.
			if (residential || blockResources) {
				try {
					await page.setRequestInterception(false);
				} catch {
					// already torn down by a teardown race — nothing to do.
				}
			}
			const doc = await page.pdf({ format, landscape, printBackground } as Parameters<typeof page.pdf>[0]);
			const bytes = doc instanceof Uint8Array ? doc : new Uint8Array(doc as ArrayBuffer);
			return { ok: true, contentType: "application/pdf", bytes };
		}
		const content =
			as === "text"
				? await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText)
				: await page.content();
		return { ok: true, contentType: as === "text" ? "text/plain" : "text/html", body: content };
	} catch (e) {
		return { ok: false, error: `render failed: ${String((e as Error).message ?? e)}` };
	} finally {
		if (browser) await browser.close();
	}
}

// --- Stepped session driver (credentialed portals, #portal-scraper) ---------
//
// cfRender above is a one-shot navigate+extract. A login-gated portal needs an
// ordered SEQUENCE of interactions in ONE live browser session — type the
// username/password, solve a bot-wall CAPTCHA, click submit, wait for the
// post-login dashboard — then extract. cfRenderSession is that: it reuses the
// SAME launch/stealth/residential-interception dance as cfRender (so the home-IP
// egress + fingerprint masking that gets past Akamai apply identically), then
// walks a `steps` list against the live page.
//
// It stays deliberately GENERIC — it knows nothing about "credit scores" or any
// particular site. Source-specific policy (which selectors, which secrets, what a
// bot-wall/MFA page looks like) lives one layer up in fns/_portal_scrape.ts. The
// one non-DOM capability it needs — turning a CAPTCHA into a token — is injected
// as `solveCaptcha`, so the CapSolver wiring also stays out of this file.
//
// Never throws: a launch failure, a step timeout (waitForSelector has its own
// timeout, so a missing selector FAILS rather than hangs — the "honest failure,
// never hang" requirement), or a solver miss all resolve to `{ ok:false, error }`,
// with a best-effort snapshot of the page so the caller can classify why.

export type SessionStep =
	| { action: "goto"; url: string; wait_until?: string; wait_ms?: number; timeout_ms?: number }
	| { action: "type"; selector: string; value: string; timeout_ms?: number }
	| { action: "click"; selector: string; timeout_ms?: number }
	| { action: "wait_for"; selector: string; timeout_ms?: number }
	| { action: "wait_ms"; ms: number }
	| { action: "press"; key: string }
	| { action: "solve_captcha"; provider: string; site_key?: string; site_key_selector?: string; response_selector?: string };

export type CaptchaChallenge = { provider: string; siteKey: string; websiteUrl: string };

/** Turn a detected CAPTCHA into a solution token (or null if unsolvable). Injected
 *  by the caller so the CapSolver client stays in fns/_portal_scrape.ts and this
 *  driver stays provider-agnostic. */
export type CaptchaSolver = (challenge: CaptchaChallenge) => Promise<string | null>;

export type CfSessionSpec = {
	start_url: string;
	steps: SessionStep[];
	as?: "html" | "text";
	residential?: boolean;
	stealth?: boolean;
	timeout_ms?: number;
	// fieldName -> CSS selector; each selector's trimmed textContent is returned in `fields`.
	extract_selectors?: Record<string, string>;
	solveCaptcha?: CaptchaSolver;
	debug_recording?: boolean;
};

export type CfSessionResult =
	| { ok: true; contentType: string; body: string; text: string; fields: Record<string, string | null>; finalUrl: string; stepsRun: number }
	| { ok: false; error: string; stepsRun: number; body?: string; text?: string; finalUrl?: string };

// A duck-typed slice of puppeteer's Page — only the members the session driver
// touches, mirroring PageForStealth's approach so the same cast works and tests
// can supply a minimal mock.
type SessionPage = {
	goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
	waitForSelector(selector: string, opts?: { timeout?: number; visible?: boolean }): Promise<unknown>;
	type(selector: string, text: string, opts?: { delay?: number }): Promise<unknown>;
	click(selector: string, opts?: { timeout?: number }): Promise<unknown>;
	evaluate(fn: (...a: any[]) => unknown, ...args: any[]): Promise<unknown>;
	content(): Promise<string>;
	url(): string;
	keyboard?: { press(key: string): Promise<unknown> };
};

// Response fields the major CAPTCHA vendors read on submit. We set ALL of them to
// the solved token (plus any caller-named `response_selector`) rather than branch
// per provider — a page only reads the one that matches its widget, and a stray
// set on an absent field is harmless. Kept in the browser-evaluated function below.
const CAPTCHA_RESPONSE_SELECTORS = ["#g-recaptcha-response", 'textarea[name="g-recaptcha-response"]', '[name="h-captcha-response"]', "#h-captcha-response", '[name="cf-turnstile-response"]', "#cf-turnstile-response"];

// Best-effort in-page sitekey detection when the caller didn't pass one — the
// common data-sitekey containers for reCAPTCHA / hCaptcha / Turnstile, plus the
// reCAPTCHA iframe's `k=` param as a last resort. Runs in the page via evaluate.
function detectSiteKeyInPage(selector?: string): string {
	const doc = (globalThis as any).document;
	const attrs = ["data-sitekey", "data-site-key"];
	const els: any[] = [];
	if (selector) {
		const one = doc.querySelector(selector);
		if (one) els.push(one);
	}
	for (const s of [".g-recaptcha", ".h-captcha", ".cf-turnstile", "[data-sitekey]", "[data-site-key]"]) {
		for (const el of Array.from(doc.querySelectorAll(s))) els.push(el);
	}
	for (const el of els) {
		for (const a of attrs) {
			const v = el?.getAttribute?.(a);
			if (v) return String(v);
		}
	}
	const iframe = doc.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]');
	const src = iframe?.getAttribute?.("src") || "";
	const m = /[?&]k=([^&]+)/.exec(src) || /[?&]sitekey=([^&]+)/.exec(src);
	return m ? decodeURIComponent(m[1]) : "";
}

function injectCaptchaTokenInPage(token: string, extraSelector: string, knownSelectors: string[]): void {
	const doc = (globalThis as any).document;
	const sels = extraSelector ? [extraSelector, ...knownSelectors] : knownSelectors;
	for (const sel of sels) {
		for (const el of Array.from(doc.querySelectorAll(sel)) as any[]) {
			try {
				el.value = token;
				el.dispatchEvent(new (globalThis as any).Event("input", { bubbles: true }));
				el.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true }));
			} catch {
				// A read-only/absent field can't be set — skip; another selector may match.
			}
		}
	}
}

async function execSessionStep(env: RtEnv, page: SessionPage, step: SessionStep, defaultTimeout: number, solveCaptcha?: CaptchaSolver): Promise<void> {
	switch (step.action) {
		case "goto": {
			if (isBlockedTarget(step.url)) throw new Error(`refusing to navigate to a private/loopback/metadata address`);
			await page.goto(step.url, { waitUntil: step.wait_until ?? "networkidle0", timeout: step.timeout_ms ?? defaultTimeout } as any);
			if (step.wait_ms && step.wait_ms > 0) await new Promise((r) => setTimeout(r, Math.min(step.wait_ms!, 10000)));
			return;
		}
		case "type": {
			await page.waitForSelector(step.selector, { timeout: step.timeout_ms ?? defaultTimeout });
			await page.type(step.selector, step.value);
			return;
		}
		case "click": {
			await page.waitForSelector(step.selector, { timeout: step.timeout_ms ?? defaultTimeout });
			await page.click(step.selector);
			return;
		}
		case "wait_for": {
			await page.waitForSelector(step.selector, { timeout: step.timeout_ms ?? defaultTimeout });
			return;
		}
		case "wait_ms": {
			await new Promise((r) => setTimeout(r, Math.min(Math.max(step.ms, 0), 30000)));
			return;
		}
		case "press": {
			if (page.keyboard?.press) await page.keyboard.press(step.key);
			return;
		}
		case "solve_captcha": {
			if (!solveCaptcha) throw new Error("captcha encountered but no solver configured (CAPSOLVER_API_KEY)");
			const siteKey = step.site_key || (String(await page.evaluate(detectSiteKeyInPage, step.site_key_selector)) || "");
			if (!siteKey) throw new Error("captcha sitekey not found on page");
			const token = await solveCaptcha({ provider: step.provider, siteKey, websiteUrl: page.url() });
			if (!token) throw new Error(`captcha solve failed (${step.provider})`);
			await page.evaluate(injectCaptchaTokenInPage, token, step.response_selector ?? "", CAPTCHA_RESPONSE_SELECTORS);
			return;
		}
	}
}

// One page.evaluate that snapshots what the caller needs to interpret the result:
// the requested per-field selector text, plus the whole-page innerText for
// bot-wall/MFA marker scanning. Kept separate from page.content() (raw HTML) so
// the caller gets both a structured view and the source.
function extractInPage(selectors: Record<string, string>): { fields: Record<string, string | null>; text: string } {
	const doc = (globalThis as any).document;
	const out: Record<string, string | null> = {};
	for (const k of Object.keys(selectors)) {
		try {
			const el = doc.querySelector(selectors[k]);
			out[k] = el ? String(el.textContent || "").trim() : null;
		} catch {
			out[k] = null;
		}
	}
	return { fields: out, text: doc.body ? String(doc.body.innerText || "") : "" };
}

/**
 * Drive a live, credentialed browser session: navigate to `start_url`, run the
 * ordered `steps` (type/click/wait/press/solve_captcha), then snapshot the final
 * page (raw HTML + innerText + per-selector fields). Reuses cfRender's stealth +
 * residential-interception so it egresses from a home IP with a masked
 * fingerprint. Never throws; a step timeout/solver miss returns `{ ok:false }`
 * with a best-effort page snapshot for the caller to classify (MFA vs bot-wall vs
 * layout change).
 */
export async function cfRenderSession(env: RtEnv, spec: CfSessionSpec): Promise<CfSessionResult> {
	if (!env.BROWSER) return { ok: false, error: "Browser Run is not configured (BROWSER binding).", stepsRun: 0 };
	if (isBlockedTarget(spec.start_url)) return { ok: false, error: "Refusing to open a private/loopback/link-local/metadata address.", stepsRun: 0 };

	const residential = spec.residential !== false;
	const stealth = spec.stealth !== false;
	const timeout = Math.min(Math.max(spec.timeout_ms ?? 30000, 1), 120000);
	const debugRecording = spec.debug_recording === true;
	const selectors = spec.extract_selectors ?? {};

	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	let stepsRun = 0;
	let page: SessionPage | undefined;

	const snapshot = async (): Promise<{ body?: string; text?: string; finalUrl?: string }> => {
		if (!page) return {};
		try {
			const body = await page.content();
			const { text } = (await page.evaluate(extractInPage, {})) as { fields: Record<string, string | null>; text: string };
			return { body, text, finalUrl: page.url() };
		} catch {
			return {};
		}
	};

	try {
		browser = debugRecording ? await puppeteer.launch(env.BROWSER, { recording: true }) : await puppeteer.launch(env.BROWSER);
		page = (await browser.newPage()) as unknown as SessionPage;

		if (stealth) await applyStealth(page as unknown as PageForStealth, stealthUa(env.STEALTH_CHROME_MAJOR || DEFAULT_STEALTH_CHROME_MAJOR));

		await (page as unknown as { setRequestInterception(on: boolean): Promise<void> }).setRequestInterception(true);
		(page as unknown as { on(evt: string, h: (req: RequestForInterception) => void): void }).on("request", (req: RequestForInterception) => {
			void handleRequest(env, req, { residential, blockResources: false });
		});

		await page.goto(spec.start_url, { waitUntil: "networkidle0", timeout } as any);

		for (const step of spec.steps) {
			await execSessionStep(env, page, step, timeout, spec.solveCaptcha);
			stepsRun++;
		}

		const body = await page.content();
		const { fields, text } = (await page.evaluate(extractInPage, selectors)) as { fields: Record<string, string | null>; text: string };
		const as = spec.as === "text" ? "text" : "html";
		return { ok: true, contentType: as === "text" ? "text/plain" : "text/html", body, text, fields, finalUrl: page.url(), stepsRun };
	} catch (e) {
		const snap = await snapshot();
		return { ok: false, error: `session failed at step ${stepsRun + 1}: ${String((e as Error).message ?? e)}`, stepsRun, ...snap };
	} finally {
		if (browser) await browser.close();
	}
}
