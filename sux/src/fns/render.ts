import { cfRender } from "../cf-render";
import { isBlockedTarget } from "../proxy";
import { looksBlocked } from "../retail-render";
import { type Fn, type RtEnv, failWith, ok } from "../registry";
import { clampBytes, deliverBytes, inlineB64, isHttpUrl } from "./_util";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

const PDF_FORMATS = ["A4", "Letter", "Legal", "A3"] as const;

const MAX_OUTPUT_BYTES = 2_000_000;

export const render: Fn = {
	name: "render",
	cost: 5,
	description:
		"Scrape a JavaScript-rendered page via headless Chromium (Cloudflare Browser Run, formerly Browser Rendering). Executes JS, unlike `scrape` (which fetches raw HTML through the residential proxy). " +
		"Give `url` (absolute http(s)); options: wait_until (load|domcontentloaded|networkidle0|networkidle2, default networkidle0), wait_ms (extra delay after load, ≤10000), as (html|text|screenshot|pdf, default html), timeout_ms (nav timeout, default 30000, ≤60000). " +
		"as:screenshot captures a PNG (full_page to shoot the whole scroll height) and returns it as a content-addressed /s/<uuid> URL by default (delivery:base64 to inline). block_resources aborts image/font/stylesheet/media fetches before navigation to speed up html/text extraction (ignored for screenshots to keep them visually correct). " +
		"as:pdf renders the page to a PDF, delivered the same way as a screenshot (content-addressed /s/<uuid> URL by default, delivery:base64 to inline); options format (A4|Letter|Legal|A3, default A4), landscape (default false), print_background (default true so CSS backgrounds render). " +
		"residential (default true) routes the browser's requests through the Tailscale residential proxy so they egress from a home IP instead of the Cloudflare datacenter — the point of this fn, since datacenter IPs are blocked by bot managers like Akamai. Trade-off: slower, because every subresource is proxied one by one; set residential:false to fetch directly from the datacenter (faster, but blockable). With residential and block_resources both on, heavy assets are still aborted and everything else is residential-routed; with residential on and block_resources off, images are proxied too (fully residential, heavier). " +
		"stealth (default true) applies a realistic desktop UA/viewport/accept-language and masks navigator.webdriver to reduce headless-browser fingerprinting so bot managers are less likely to flag the render; pairs with residential routing (which fixes the IP signal). Best-effort — CF Browser Run limits deeper stealth, and each step degrades silently if unsupported. Set false to keep the default headless signals. " +
		"debug_recording (default false) opts the session into Browser Run's session-recording feature — replayable in the Cloudflare dashboard (Browser Run > Runs) after the session closes — for diagnosing a render that came back blocked or wrong. Off by default (recording adds overhead). " +
		"webmcp_tool (as:html|text only) — EXPERIMENTAL (added 2026-07, Chrome 149 WebMCP origin trial only; adoption is still ~nil). If given, checks the rendered page for navigator.modelContext/document.modelContext and — if the page declares that tool — calls it directly with webmcp_args instead of scraping the DOM, returning its structured result as JSON. Genuinely optional fast path: falls straight back to normal html/text extraction if the page doesn't support WebMCP, doesn't have that tool, or the call fails. Omit to get today's unchanged behavior.",
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
					"Apply a realistic desktop UA/viewport/accept-language and mask navigator.webdriver to reduce headless-browser fingerprinting (bot managers like Akamai flag the default HeadlessChrome signals). Default true — pairs with residential routing. Best-effort (CF Browser Run limits deeper stealth); set false to keep default headless signals.",
			},
			delivery: { type: "string", enum: ["base64", "url"], default: "url", description: "Screenshot only: content-addressed /s/<uuid> URL (default, ~100 tokens) or inline base64." },
			timeout_ms: { type: "integer", minimum: 1, maximum: 60000, default: 30000, description: "Navigation timeout in ms." },
			debug_recording: {
				type: "boolean",
				default: false,
				description:
					"Opt this session into a Browser Run session recording, replayable in the Cloudflare dashboard (Browser Run > Runs), for diagnosing a blocked/wrong render. Default false (adds overhead).",
			},
			webmcp_tool: {
				type: "string",
				description:
					"EXPERIMENTAL, as:html|text only (Chrome 149 WebMCP origin trial, negligible adoption as of 2026). Name of a navigator.modelContext-declared tool to call instead of scraping the DOM. No-op fallback to normal extraction if the page doesn't support WebMCP or the call fails.",
			},
			webmcp_args: { type: "object", description: "Arguments to pass to webmcp_tool, if given.", additionalProperties: true },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return failWith("bad_input", "Provide an absolute http(s) url.");
		// SSRF guard: refuse private/loopback/link-local/CGNAT/metadata targets before
		// they reach the renderer. Residential routing egresses from inside the home LAN
		// (router admin UI, other devices), so an internal URL would otherwise be
		// reachable — the same exposure smartFetch/fetchViaTailscale already block. render
		// only ever wants public pages, so no renderer can be pointed at an internal address.
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

		const webmcpTool = typeof args?.webmcp_tool === "string" && args.webmcp_tool.trim() ? args.webmcp_tool.trim() : undefined;
		const webmcpArgs = webmcpTool && args?.webmcp_args && typeof args.webmcp_args === "object" ? (args.webmcp_args as Record<string, unknown>) : undefined;

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
			debug_recording: args?.debug_recording === true,
			webmcpTool,
			webmcpArgs,
		});
		if (!result.ok) return failWith("upstream_error", result.error);
		// Screenshot/pdf come back as raw bytes to deliver; html/text as a string.
		if ("bytes" in result) {
			return deliverBytes(env, result.bytes, result.contentType, args?.delivery ?? "url", () => inlineB64(result.bytes, result.contentType));
		}
		// A bot wall/challenge interstitial IS valid HTML — cfRender can't tell it apart
		// from real content, so it comes back `ok`. Mirror retail-render's cf leg so a
		// detected wall surfaces as an error envelope instead of a 200 that extract fns
		// then parse and cache (#635).
		if (looksBlocked(result.body)) return failWith("upstream_error", "cf render blocked (bot wall)");
		return ok(clampBytes(result.body, MAX_OUTPUT_BYTES));
	},
};
