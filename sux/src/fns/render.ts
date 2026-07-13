import { cfRender } from "../cf-render";
import { hmacHex, isBlockedTarget } from "../proxy";
import { looksBlocked } from "../retail-render";
import { type Fn, type RtEnv, type ToolResult, failWith, ok } from "../registry";
import { clamp, deliverBytes, fromB64, inlineB64, isHttpUrl } from "./_util";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

const PDF_FORMATS = ["A4", "Letter", "Legal", "A3"] as const;

const MAX_OUTPUT_BYTES = 2_000_000;

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
	// The headed CapSolver tier threw while solving a challenge — the node returned
	// the unsolved (likely still-blocked) page instead of erroring. Surfaced below so
	// a CapSolver breakage isn't swallowed and mistaken for a plain wall.
	solver_error?: string;
};

async function renderViaMac(env: RtEnv, payload: MacRenderPayload, delivery: string | undefined): Promise<ToolResult> {
	if (!env.MAC_RENDER_URL || !env.MAC_RENDER_SECRET) {
		return failWith("not_configured", "Mac render backend not configured (MAC_RENDER_URL/MAC_RENDER_SECRET).");
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
		return failWith("upstream_error", `mac render failed: ${String((e as Error).message ?? e)}`);
	}
	let data: MacRenderResponse;
	try {
		data = (await resp.json()) as MacRenderResponse;
	} catch {
		return failWith("upstream_error", `mac render failed: unreadable response (HTTP ${resp.status}).`);
	}
	if (!resp.ok || data.error) {
		return failWith("upstream_error", `mac render failed: ${data.error ?? `HTTP ${resp.status}`}`);
	}
	const text = typeof data.body === "string" ? data.body : "";
	if (payload.as === "screenshot" || payload.as === "pdf") {

		const bytes = fromB64(text);
		const contentType = data.content_type ?? (payload.as === "pdf" ? "application/pdf" : "image/png");
		return deliverBytes(env, bytes, contentType, delivery ?? "url", () => inlineB64(bytes, contentType));
	}

	// The mac node can answer a bot wall as a 200 (a block/challenge page IS valid
	// HTML) — mirror retail-render's guard so a detected wall surfaces as an error
	// envelope instead of being returned as content. If the CapSolver tier also
	// errored, name it: an invisible solver breakage is exactly what this must expose.
	if (looksBlocked(text)) {
		return failWith("upstream_error", data.solver_error ? `mac render blocked (bot wall); solver errored: ${data.solver_error}` : "mac render blocked (bot wall)");
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
		if (!isHttpUrl(url)) return failWith("bad_input", "Provide an absolute http(s) url.");
		// SSRF guard: refuse private/loopback/link-local/CGNAT/metadata targets before
		// they reach a renderer. The mac backend forwards `url` to a residential node
		// that sits INSIDE the home LAN (router admin UI, other devices) and does no
		// guarding of its own — the same exposure smartFetch/fetchViaTailscale already
		// block. Applied to the cf backend too (defense in depth; render only ever
		// wants public pages), so no renderer can be pointed at an internal address.
		if (isBlockedTarget(url)) return failWith("bad_input", "Refusing to render a private/loopback/link-local/metadata address.");

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

		const result = await cfRender(env, {
			url,
			as,
			wait_until: waitUntil,
			wait_ms: waitMs,
			block_resources: blockResources,
			residential,
			stealth,
			timeout_ms: timeout,
			full_page: fullPage,
			format,
			landscape,
			print_background: printBackground,
		});
		if (!result.ok) return failWith("upstream_error", result.error);
		// Screenshot/pdf come back as raw bytes to deliver; html/text as a string.
		if ("bytes" in result) {
			return deliverBytes(env, result.bytes, result.contentType, args?.delivery ?? "url", () => inlineB64(result.bytes, result.contentType));
		}
		return ok(clamp(result.body, MAX_OUTPUT_BYTES));
	},
};
