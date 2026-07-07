import puppeteer from "@cloudflare/puppeteer";
import { hmacHex, smartFetch } from "../proxy";
import { type Fn, type RtEnv, type ToolResult, fail, ok } from "../registry";
import { clamp, deliverBytes, fromB64, inlineB64, isHttpUrl } from "./_util";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

const PDF_FORMATS = ["A4", "Letter", "Legal", "A3"] as const;

const MAX_OUTPUT_BYTES = 2_000_000;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

const STEALTH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const STEALTH_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 } as const;
const STEALTH_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

type PageForStealth = {
	setUserAgent?(ua: string): void | Promise<void>;
	setViewport?(v: { width: number; height: number; deviceScaleFactor?: number }): void | Promise<void>;
	setExtraHTTPHeaders?(headers: Record<string, string>): void | Promise<void>;
	evaluateOnNewDocument?(fn: (...args: unknown[]) => unknown): void | Promise<void>;
};

async function applyStealth(page: PageForStealth): Promise<void> {

	try {
		if (typeof page.setUserAgent === "function") await page.setUserAgent(STEALTH_UA);
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

const MAC_TIMEOUT_MARGIN_MS = 10_000;
const MAC_TIMEOUT_CAP_MS = 70_000;

type MacRenderPayload = {
	url: string;
	as: string;
	wait_until: string;
	wait_ms: number;
	block_resources: boolean;
	full_page: boolean;
	timeout_ms: number;
	solve?: boolean;
};

type MacRenderResponse = {
	status?: number;
	content_type?: string;
	body?: string;
	bodyEncoding?: "base64";
	error?: string;
};

async function renderViaMac(env: RtEnv, payload: MacRenderPayload, delivery: string | undefined): Promise<ToolResult> {
	if (!env.MAC_RENDER_URL || !env.MAC_RENDER_SECRET) {
		return fail("Mac render backend not configured (MAC_RENDER_URL/MAC_RENDER_SECRET).");
	}
	const body = JSON.stringify(payload);
	const ts = String(Date.now());
	const sig = await hmacHex(env.MAC_RENDER_SECRET, `${ts}\n${body}`);

	const endpoint = new URL("/render", env.MAC_RENDER_URL).href;
	const signedEndpoint = `${endpoint}?ts=${ts}&sig=${sig}`;
	const timeout = Math.min(payload.timeout_ms + MAC_TIMEOUT_MARGIN_MS, MAC_TIMEOUT_CAP_MS);
	let resp: Response;
	try {
		resp = await fetch(signedEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
			body,
			signal: AbortSignal.timeout(timeout),
		});
	} catch (e) {
		return fail(`mac render failed: ${String((e as Error).message ?? e)}`);
	}
	let data: MacRenderResponse;
	try {
		data = (await resp.json()) as MacRenderResponse;
	} catch {
		return fail(`mac render failed: unreadable response (HTTP ${resp.status}).`);
	}
	if (!resp.ok || data.error) {
		return fail(`mac render failed: ${data.error ?? `HTTP ${resp.status}`}`);
	}
	const text = typeof data.body === "string" ? data.body : "";
	if (payload.as === "screenshot" || payload.as === "pdf") {

		const bytes = fromB64(text);
		const contentType = data.content_type ?? (payload.as === "pdf" ? "application/pdf" : "image/png");
		return deliverBytes(env, bytes, contentType, delivery ?? "url", () => inlineB64(bytes, contentType));
	}

	return ok(clamp(text, MAX_OUTPUT_BYTES));
}

export const render: Fn = {
	name: "render",
	cost: 5,
	description:
		"Scrape a JavaScript-rendered page via headless Chromium (Cloudflare Browser Rendering). Executes JS, unlike `scrape` (which fetches raw HTML through the residential proxy). " +
		"Give `url` (absolute http(s)); options: wait_until (load|domcontentloaded|networkidle0|networkidle2, default networkidle0), wait_ms (extra delay after load, ≤10000), as (html|text|screenshot|pdf, default html), timeout_ms (nav timeout, default 30000, ≤60000). " +
		"as:screenshot captures a PNG (full_page to shoot the whole scroll height) and returns it as a content-addressed /s/<uuid> URL by default (delivery:base64 to inline). block_resources aborts image/font/stylesheet/media fetches before navigation to speed up html/text extraction (ignored for screenshots to keep them visually correct). " +
		"as:pdf renders the page to a PDF, delivered the same way as a screenshot (content-addressed /s/<uuid> URL by default, delivery:base64 to inline); options format (A4|Letter|Legal|A3, default A4), landscape (default false), print_background (default true so CSS backgrounds render). " +
		"residential (default true) routes the browser's requests through the Tailscale residential proxy so they egress from a home IP instead of the Cloudflare datacenter — the point of this fn, since datacenter IPs are blocked by bot managers like Akamai. Trade-off: slower, because every subresource is proxied one by one; set residential:false to fetch directly from the datacenter (faster, but blockable). With residential and block_resources both on, heavy assets are still aborted and everything else is residential-routed; with residential on and block_resources off, images are proxied too (fully residential, heavier). " +
		"stealth (default true) applies a realistic desktop UA/viewport/accept-language and masks navigator.webdriver to reduce headless-browser fingerprinting so bot managers are less likely to flag the render; pairs with residential routing (which fixes the IP signal). Best-effort — CF Browser Rendering limits deeper stealth, and each step degrades silently if unsupported. Set false to keep the default headless signals. " +
		"backend (cf|mac, default cf) selects the render engine: cf = Cloudflare Browser Rendering (fast, default); mac = a residential patched-browser (patchright) service that egresses from a home IP and SOLVES active JS bot challenges (Akamai sensor) cf can't — slower, use it only for sites that block cf (e.g. Home Depot, Walmart). The mac backend takes url/as/wait_until/wait_ms/block_resources/full_page/timeout_ms; residential/stealth are inherent to it (no separate CF interception), and screenshot/pdf are delivered via the same /s/<uuid> vs base64 `delivery` path.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to render." },
			wait_until: { type: "string", enum: [...WAIT_UNTIL], default: "networkidle0", description: "Navigation completion condition." },
			wait_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Extra delay (ms) after load, e.g. for late JS." },
			as: { type: "string", enum: ["html", "text", "screenshot", "pdf"], default: "html", description: "Return rendered HTML (default), visible innerText, a PNG screenshot, or a PDF." },
			format: { type: "string", enum: [...PDF_FORMATS], default: "A4", description: "PDF only: paper size." },
			landscape: { type: "boolean", default: false, description: "PDF only: use landscape orientation." },
			print_background: { type: "boolean", default: true, description: "PDF only: render CSS backgrounds (default true)." },
			full_page: { type: "boolean", default: false, description: "Screenshot only: capture the full scroll height, not just the viewport." },
			block_resources: { type: "boolean", default: false, description: "Abort image/font/stylesheet/media requests before navigation to speed up html/text extraction. Ignored for as:screenshot." },
			residential: {
				type: "boolean",
				default: true,
				description:
					"Route the browser's requests through the Tailscale residential proxy so they egress from a home IP, bypassing datacenter-IP bot detection (Akamai etc.). Default true — this is render's main purpose. Slower (every subresource is proxied); set false to fetch directly from the datacenter.",
			},
			stealth: {
				type: "boolean",
				default: true,
				description:
					"Apply a realistic desktop UA/viewport/accept-language and mask navigator.webdriver to reduce headless-browser fingerprinting (bot managers like Akamai flag the default HeadlessChrome signals). Default true — pairs with residential routing. Best-effort (CF Browser Rendering limits deeper stealth); set false to keep default headless signals.",
			},
			delivery: { type: "string", enum: ["base64", "url"], default: "url", description: "Screenshot only: content-addressed /s/<uuid> URL (default, ~100 tokens) or inline base64." },
			solve: {
				type: "boolean",
				default: false,
				description:
					"backend:mac only. Force the CapSolver-equipped headed browser tier that auto-solves captchas (DataDome/reCAPTCHA/hCaptcha/Turnstile in-page). The mac backend already auto-escalates to this tier when a page looks blocked; set true to force it (slower). No-op if the Mac has no CapSolver key configured.",
			},
			backend: {
				type: "string",
				enum: ["cf", "mac"],
				default: "cf",
				description:
					"Render engine: cf = Cloudflare Browser Rendering (fast, default); mac = residential patched-browser service that solves active JS bot challenges (Akamai) — slower, use for sites that block cf (e.g. Home Depot, Walmart).",
			},
			timeout_ms: { type: "integer", minimum: 1, maximum: 60000, default: 30000, description: "Navigation timeout in ms." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return fail("Provide an absolute http(s) url.");

		const waitUntil = (WAIT_UNTIL as readonly string[]).includes(args?.wait_until) ? args.wait_until : "networkidle0";
		const timeout = Math.min(Math.max(Number(args?.timeout_ms) || 30000, 1), 60000);
		const waitMs = typeof args?.wait_ms === "number" ? Math.min(Math.max(args.wait_ms, 0), 10000) : 0;
		const as = args?.as === "text" ? "text" : args?.as === "screenshot" ? "screenshot" : args?.as === "pdf" ? "pdf" : "html";
		const fullPage = args?.full_page === true;
		const format = (PDF_FORMATS as readonly string[]).includes(args?.format) ? args.format : "A4";
		const landscape = args?.landscape === true;

		const printBackground = args?.print_background !== false;

		const blockResources = args?.block_resources === true && as !== "screenshot" && as !== "pdf";

		const residential = args?.residential !== false;

		const stealth = args?.stealth !== false;

		const backend = args?.backend === "mac" ? "mac" : "cf";
		if (backend === "mac") {
			return renderViaMac(
				env,
				{ url, as, wait_until: waitUntil, wait_ms: waitMs, block_resources: blockResources, full_page: fullPage, timeout_ms: timeout, solve: args?.solve === true },
				args?.delivery,
			);
		}

		if (!env.BROWSER) return fail("Browser Rendering is not configured (BROWSER binding).");

		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		try {
			browser = await puppeteer.launch(env.BROWSER);
			const page = await browser.newPage();

			if (stealth) await applyStealth(page as unknown as PageForStealth);

			if (residential || blockResources) {
				await page.setRequestInterception(true);
				page.on("request", (req: RequestForInterception) => {
					void handleRequest(env, req, { residential, blockResources });
				});
			}
			await page.goto(url, { waitUntil, timeout });
			if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
			if (as === "screenshot") {
				const shot = await page.screenshot({ fullPage });
				const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot as ArrayBuffer);

				return deliverBytes(env, bytes, "image/png", args?.delivery ?? "url", () => inlineB64(bytes, "image/png"));
			}
			if (as === "pdf") {
				const doc = await page.pdf({ format, landscape, printBackground });
				const bytes = doc instanceof Uint8Array ? doc : new Uint8Array(doc as ArrayBuffer);

				return deliverBytes(env, bytes, "application/pdf", args?.delivery ?? "url", () => inlineB64(bytes, "application/pdf"));
			}

			const content =
				as === "text"
					? await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText)
					: await page.content();
			return ok(clamp(content, MAX_OUTPUT_BYTES));
		} catch (e) {
			return fail(`render failed: ${String((e as Error).message ?? e)}`);
		} finally {
			if (browser) await browser.close();
		}
	},
};
