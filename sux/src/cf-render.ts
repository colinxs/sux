// Shared client for the Cloudflare Browser Run backend (`render`'s default `cf`
// engine): a headless Chromium (`@cloudflare/puppeteer`) that executes JS and —
// with `residential` routing + `stealth` masking — egresses from a home IP past
// datacenter-IP bot detection. The `render` fn drives it for arbitrary pages; the
// retailer fns reach it (via retail-render's mac→cf fallback) only when the mac
// backend is down. Extracted from render.ts so both callers share ONE puppeteer
// driver instead of duplicating the launch/stealth/interception/goto dance.
//
// Cloudflare renamed this product "Browser Rendering" -> "Browser Run" (Apr 2026).
// The rename is additive only — same `@cloudflare/puppeteer` package, same `browser`
// wrangler binding, same `puppeteer.launch(env.BROWSER)` call shape — so nothing
// here needed to change for the rename itself. The new capabilities it shipped
// alongside (CDP endpoint, WebMCP, higher 30->120 concurrency) don't apply to this
// server-side Puppeteer path; `debug_recording` below opts into the one that does
// (session recordings), for post-mortem debugging of bot-wall failures.
//
// Mirrors macRender's never-throw envelope: a launch/nav failure or a missing
// BROWSER binding resolves to `{ ok:false, error }`. HTML/text return a string
// `body`; screenshot/pdf return raw `bytes` (the caller delivers them).

import puppeteer from "@cloudflare/puppeteer";
import { smartFetch } from "./proxy";
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
};

// For html/text the payload is the string `body`; for screenshot/pdf it is the raw
// `bytes` (the caller decides delivery). On any failure: `{ ok:false, error }`.
export type CfRenderResult =
	| { ok: true; contentType: string; body: string }
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

		if (residential || blockResources) {
			await page.setRequestInterception(true);
			page.on("request", (req: RequestForInterception) => {
				void handleRequest(env, req, { residential, blockResources });
			});
		}
		// waitUntil/format are validated strings; cast to puppeteer's literal unions.
		await page.goto(spec.url, { waitUntil, timeout } as Parameters<typeof page.goto>[1]);
		if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
		if (as === "screenshot") {
			const shot = await page.screenshot({ fullPage });
			const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot as ArrayBuffer);
			return { ok: true, contentType: "image/png", bytes };
		}
		if (as === "pdf") {
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
