// Shared client for the Mac patchright render service (backend:"mac"): a
// residential, patched-Chromium node exposed via Tailscale Funnel that solves the
// active JS bot challenges (Akamai `_abck`, PerimeterX press-and-hold) whose
// solver tiers — the real mouse-hold gesture and the CapSolver captcha pass — live
// only here and have no CF Browser Run equivalent. The `render` fn drives it
// for arbitrary pages; the retailer fns drive it (mostly via retail-render's
// mac→cf fallback) for their search pages and extract structured products from the
// rendered HTML. cf-residential is a viable fallback for some walls (e.g. Amazon's
// AWS WAF), but not for the gesture/captcha walls above — hence mac stays primary.
//
// Signed with the SAME HMAC scheme as fetchViaTailscale/renderViaMac: hmacHex over
// `${ts}\n${payload}`, with ts+sig on the query string (so uhttpd-style CGI hosts
// that drop custom POST headers still verify) and mirrored in x-timestamp/
// x-signature headers.

import { hmacHex } from "./proxy";
import type { RtEnv } from "./registry";

// What a caller asks the Mac service to render. Only `url` is required; the rest
// mirror the render fn's knobs and default sensibly for HTML extraction.
export type MacRenderSpec = {
	url: string;
	as?: string;
	wait_until?: string;
	wait_ms?: number;
	block_resources?: boolean;
	timeout_ms?: number;
	// Force the CapSolver-equipped headed solver tier (captchas/press-and-hold).
	// The service auto-escalates when a page looks blocked; set for always-walled
	// sites (e.g. Walmart PerimeterX) to skip the wasted headless pass.
	solve?: boolean;
};

// The Mac service response envelope. For as html/text, `body` is the text; for
// as screenshot/pdf, bodyEncoding is "base64" and `body` is base64 of the bytes.
// On error the node returns `{ error }`.
type MacRenderResponse = {
	status?: number;
	content_type?: string;
	body?: string;
	bodyEncoding?: "base64";
	error?: string;
	// The headed CapSolver tier threw while solving a challenge: the node fell back
	// to the (still-likely-blocked) unsolved page rather than erroring the request.
	// Propagated so a CapSolver breakage surfaces instead of vanishing behind a wall.
	solver_error?: string;
};

export type MacRenderResult =
	| { ok: true; contentType: string; body: string; bodyEncoding?: "base64"; solverError?: string }
	| { ok: false; error: string };

// The Mac service is Playwright/patchright, whose page.goto(wait_until) accepts
// load|domcontentloaded|networkidle|commit — NOT Puppeteer's networkidle0/2 (which
// the cf backend + callers use). Passing those threw "expected one of …" → 502 on
// every mac render carrying the default. Normalize to Playwright's vocabulary before
// any mac payload is serialized — the single boundary that owns this translation.
export function normalizeMacWaitUntil(waitUntil: string): string {
	return waitUntil.replace(/^networkidle[02]$/, "networkidle");
}

// Cap on the AbortSignal for the Mac render call. The service egresses
// residentially and solves active JS challenges, so it is legitimately slower
// than a plain fetch — give it the caller's nav budget plus a margin, but keep the
// Worker bounded so a hung node can never hang the tool call indefinitely.
const MAC_TIMEOUT_MARGIN_MS = 15_000;
const MAC_TIMEOUT_CAP_MS = 80_000;

// Circuit breaker for a down/hung Mac node. Each call that never gets a Response
// (transport error OR AbortSignal.timeout — the calls that burn the FULL timeout
// budget) trips the breaker. After MAC_BREAKER_THRESHOLD such consecutive
// failures the circuit OPENS for MAC_BREAKER_COOLDOWN_MS: subsequent calls
// short-circuit instantly with `circuit-open` instead of each waiting out the
// timeout again. Once the cooldown elapses the breaker is half-open — the next
// call probes the node for real; a Response (node is alive, even a node-side
// `{error}`) closes it, another timeout re-opens it for a fresh cooldown. Any
// Response resets the failure count, so isolated blips never accumulate to a trip.
const MAC_BREAKER_THRESHOLD = 5;
const MAC_BREAKER_COOLDOWN_MS = 30_000;
const macBreaker = { failures: 0, openUntil: 0 };

function macBreakerOnResponse(): void {
	macBreaker.failures = 0;
	macBreaker.openUntil = 0;
}

function macBreakerOnFailure(): void {
	macBreaker.failures += 1;
	if (macBreaker.failures >= MAC_BREAKER_THRESHOLD) {
		macBreaker.openUntil = Date.now() + MAC_BREAKER_COOLDOWN_MS;
	}
}

/** Test-only: clear the module-level circuit-breaker state between cases. */
export function __resetMacRenderBreaker(): void {
	macBreaker.failures = 0;
	macBreaker.openUntil = 0;
}

/**
 * POST a render spec to the Mac service and return the rendered result. Never
 * throws: unconfigured backend, transport error, non-200, unreadable body, or a
 * node-side `{ error }` all resolve to `{ ok:false, error }`. A tripped circuit
 * (see macBreaker) fast-fails with `circuit-open` without touching the network.
 */
export async function macRender(env: RtEnv, spec: MacRenderSpec): Promise<MacRenderResult> {
	if (!env.MAC_RENDER_URL || !env.MAC_RENDER_SECRET) {
		return { ok: false, error: "Mac render backend not configured." };
	}
	if (macBreaker.openUntil > Date.now()) {
		return { ok: false, error: "mac render backend circuit-open" };
	}
	const macSpec = { ...spec, ...(typeof spec.wait_until === "string" ? { wait_until: normalizeMacWaitUntil(spec.wait_until) } : {}) };
	const payload = JSON.stringify({ as: "html", ...macSpec });
	const ts = String(Date.now());
	const sig = await hmacHex(env.MAC_RENDER_SECRET, `${ts}\n${payload}`);
	// ts+sig ride the query string (same rationale as fetchViaTailscale: some CGI
	// hosts drop custom POST headers, but QUERY_STRING is always delivered).
	const endpoint = new URL("/render", env.MAC_RENDER_URL).href;
	const signedEndpoint = `${endpoint}?ts=${ts}&sig=${sig}`;
	const timeout = Math.min((spec.timeout_ms ?? 45_000) + MAC_TIMEOUT_MARGIN_MS, MAC_TIMEOUT_CAP_MS);
	let resp: Response;
	try {
		resp = await fetch(signedEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
			body: payload,
			signal: AbortSignal.timeout(timeout),
		});
	} catch (e) {
		macBreakerOnFailure();
		return { ok: false, error: `mac render failed: ${String((e as Error).message ?? e)}` };
	}
	// The node answered (even a non-2xx or `{error}` body), so it is alive — clear
	// the breaker regardless of how the response body ultimately maps.
	macBreakerOnResponse();
	let data: MacRenderResponse;
	try {
		data = (await resp.json()) as MacRenderResponse;
	} catch {
		return { ok: false, error: `mac render failed: unreadable response (HTTP ${resp.status}).` };
	}
	if (!resp.ok || data.error) {
		return { ok: false, error: `mac render failed: ${data.error ?? `HTTP ${resp.status}`}` };
	}
	return {
		ok: true,
		contentType: data.content_type ?? "text/html",
		body: typeof data.body === "string" ? data.body : "",
		bodyEncoding: data.bodyEncoding,
		...(data.solver_error ? { solverError: data.solver_error } : {}),
	};
}
