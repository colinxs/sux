// Worker-side client for the Tailscale residential fetch-proxy (tailscale-proxy/).
//
// Cloudflare Workers egress from datacenter IPs that Akamai-protected retailers
// (Home Depot, Lowe's, Costco) block. This delegates a fetch to a node in your
// tailnet — exposed via Tailscale Funnel — so the request originates from a
// residential IP. Use it as a fetch-ladder rung for those hosts only; normal
// fetch is fine everywhere else.

import { githubAuthHeaders } from "./github-auth";

export type TailscaleEnv = {
	// Public Funnel URL of the proxy node, e.g. https://box.tailnet-name.ts.net
	TAILSCALE_PROXY_URL?: string;
	// Shared secret matching the proxy's PROXY_SECRET.
	TAILSCALE_PROXY_SECRET?: string;
	// Escape hatch: set to "0" to force direct fetches even when the proxy is
	// configured. Default (unset) = proxy everything when configured.
	TAILSCALE_PROXY_ALL?: string;
	// Optional GitHub PAT — attached to GitHub-host fetches to lift the 60/hr
	// anonymous rate limit to 5000/hr. Never sent to non-GitHub hosts.
	GITHUB_TOKEN?: string;
};

export type ProxiedResponse = {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	bytes: number;
	truncated: boolean;
	body: string;
	// "base64": `body` is base64 of the raw response bytes (binary-safe).
	// Absent/"utf8": `body` is plain text — legacy transport, lossy for binary
	// (bytes that aren't valid UTF-8 became U+FFFD on the proxy node).
	bodyEncoding?: "base64" | "utf8";
};

export function isTailscaleConfigured(env: TailscaleEnv): boolean {
	return Boolean(env.TAILSCALE_PROXY_URL && env.TAILSCALE_PROXY_SECRET);
}

/** HMAC-SHA256 hex of `msg` under `secret` (Web Crypto). */
export async function hmacHex(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Proxy is on when configured and not explicitly disabled. */
export function proxyEnabled(env: TailscaleEnv): boolean {
	return isTailscaleConfigured(env) && env.TAILSCALE_PROXY_ALL !== "0";
}

// Smart routing: hosts that gain nothing from residential egress (authenticated
// APIs, DoH resolvers, RDAP/CT/IP-geo lookups) go DIRECT even when the proxy is
// on — direct is a hop faster and these never block datacenter IPs. Web pages
// (the reason the residential exit exists) still proxy.
// Note: RDAP (rdap.org) and CT logs (crt.sh) are intentionally NOT here — they
// often 403/blocks datacenter IPs, so they benefit from the residential exit.
const DIRECT_HOST_RE = /(^|\.)(?:kagi\.com|cloudflare-dns\.com|dns\.google|ipwho\.is|ip-api\.com)$/i;

export function isDirectHost(url: string): boolean {
	try {
		return DIRECT_HOST_RE.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

export type Route = "auto" | "proxy" | "direct";

// Transient/rate-limit statuses worth another shot with backoff: gateway/
// unavailable/timeout (502/503/504), request-timeout (408), and rate-limited
// (429 — the one exponential backoff exists for). A 4xx (other than 408/429) or
// a plain 500 is a settled answer — retrying just wastes the budget.
const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504]);

/** True when a resolved response is a retryable transient/rate-limit failure. */
function isTransientStatus(status: number): boolean {
	return TRANSIENT_STATUS.has(status);
}

const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 8_000;

/**
 * Backoff before the retry after `attempt` (0-based) failed attempts. Honors a
 * server `Retry-After` (seconds, capped) when present — the polite thing on a
 * 429/503 — else exponential base·2^attempt with full jitter (spreads a
 * thundering herd instead of syncing every client to the same retry instant).
 */
export function backoffDelay(attempt: number, retryAfter?: string | null): number {
	const ra = retryAfter != null ? Number(retryAfter) : Number.NaN;
	if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, MAX_DELAY_MS);
	const ceil = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
	return Math.round(ceil / 2 + Math.random() * (ceil / 2)); // jitter in [ceil/2, ceil]
}

/**
 * Run `fn` with up to MAX_ATTEMPTS tries, retrying transient/rate-limit failures
 * — a thrown network/timeout error OR a 408/429/502/503/504 response — with
 * exponential backoff + jitter (and honoring Retry-After). Scraping proxies and
 * rate-limited APIs hit these constantly; bounded retries materially lift
 * reliability. Each attempt keeps its own 30s bound; the last retryable response
 * (or thrown error) is surfaced once the attempts are exhausted.
 */
async function withRetry(fn: () => Promise<Response>): Promise<Response> {
	let lastResp: Response | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, backoffDelay(attempt - 1, lastResp?.headers.get("retry-after"))));
		try {
			const resp = await fn();
			if (!isTransientStatus(resp.status)) return resp;
			lastResp = resp; // retryable status — loop (or surface it if attempts run out)
		} catch (e) {
			if (attempt === MAX_ATTEMPTS - 1) throw e; // out of retries on a thrown error
			lastResp = undefined;
		}
	}
	return lastResp ?? fn();
}

// Route accounting: smartFetch tallies which path each fetch actually took into
// a small per-isolate buffer that recordCall (metrics.ts) drains into the
// KV-backed metrics and the structured `sux` log line on every tool call — the
// buffer is transport between fetch and log, NOT the source of truth.
//   proxied         — served by the residential proxy
//   direct          — never tried the proxy (disabled, direct host, or forced)
//   proxy_fallback  — proxy errored, refetched direct
//   binary_refetch  — legacy proxy mangled a binary body, refetched direct
export type FetchRoute = "proxied" | "direct" | "proxy_fallback" | "binary_refetch";

let routeTally: Partial<Record<FetchRoute, number>> = {};

function tallyRoute(r: FetchRoute): void {
	routeTally[r] = (routeTally[r] ?? 0) + 1;
}

/** Drain (return and reset) the pending per-isolate route tally. */
export function drainRouteTally(): Partial<Record<FetchRoute, number>> {
	const t = routeTally;
	routeTally = {};
	return t;
}

// Content types the legacy string transport carries faithfully. Anything else
// (images, PDFs, archives, octet-stream…) needs bodyEncoding:"base64" or a
// direct fetch — a JSON string cannot round-trip arbitrary bytes.
const TEXTUAL_MIME = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/ecmascript",
	"application/x-www-form-urlencoded",
	"application/x-ndjson",
	"image/svg+xml",
]);

/** True when `ct` (a content-type header value) denotes text that survives the
 * string transport. No content-type at all is treated as text — that matches
 * the pre-binary-mode behavior and avoids refetching every headerless page. */
export function isTextualContentType(ct: string | null): boolean {
	const t = (ct ?? "").split(";")[0].trim().toLowerCase();
	if (!t) return true;
	return t.startsWith("text/") || t.endsWith("+json") || t.endsWith("+xml") || TEXTUAL_MIME.has(t);
}

/** Decode base64 to raw bytes (Workers/Node both provide atob). */
function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Reconstruct a standard `Response` from the proxied payload, decoding
 * base64-encoded bodies to raw bytes so binary survives byte-for-byte. */
function proxiedToResponse(p: ProxiedResponse): Response {
	const headers = new Headers(p.headers);
	// The proxy runtime already decoded the body; drop stale framing headers.
	headers.delete("content-encoding");
	headers.delete("content-length");
	const body = p.bodyEncoding === "base64" ? base64ToBytes(p.body) : p.body;
	// Null-body statuses reject any body (even "") in the Response constructor.
	return new Response([204, 205, 304].includes(p.status) ? null : body, { status: p.status, statusText: p.statusText, headers });
}

/** Decide whether a fetch should go through the residential proxy. `auto`
 * (default) proxies when enabled unless the host is a known direct host;
 * `proxy`/`direct` force it (e.g. egress forces `proxy` to probe the exit). */
export function willProxy(env: TailscaleEnv, url: string, route: Route = "auto"): boolean {
	if (route === "direct") return false;
	if (!proxyEnabled(env)) return false;
	if (route === "proxy") return true;
	return !isDirectHost(url);
}

/**
 * Drop-in `fetch` that routes through the Tailscale residential proxy per the
 * smart-routing policy (see willProxy), and falls back to a DIRECT fetch if the
 * proxy errors — so enabling the proxy can never take the Worker down if the
 * tailnet box is offline. Binary-safe: base64-encoded proxy bodies are decoded
 * to raw bytes, and if a legacy proxy returns a binary content type as a plain
 * string (already mangled — U+FFFD), the URL is refetched direct instead.
 */
export async function smartFetch(
	env: TailscaleEnv,
	url: string,
	init: { method?: string; headers?: Headers | Record<string, string>; body?: string; redirect?: "follow" | "manual" | "error" } = {},
	route: Route = "auto",
): Promise<Response> {
	// GitHub auth applies regardless of route; caller-supplied headers win.
	const ghAuth = githubAuthHeaders(env, url);
	let directRoute: FetchRoute = "direct";
	if (willProxy(env, url, route)) {
		try {
			const callerHeaders = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
			const headers = { ...ghAuth, ...callerHeaders };
			const p = await fetchViaTailscale(env, url, { method: init.method, headers, body: init.body, redirect: init.redirect });
			if (p.bodyEncoding === "base64" || isTextualContentType(new Headers(p.headers).get("content-type"))) {
				tallyRoute("proxied");
				return proxiedToResponse(p);
			}
			// Corrupt bytes are worse than a datacenter-IP fetch: fall through.
			directRoute = "binary_refetch";
			console.warn(`smartFetch: proxy returned a stringly binary body for ${url} — refetching direct for byte fidelity`);
		} catch (e) {
			directRoute = "proxy_fallback";
			console.warn(`smartFetch: proxy failed, falling back to direct — ${String((e as Error).message ?? e)}`);
		}
	}
	tallyRoute(directRoute);
	const callerHeaders = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
	const headers = { ...ghAuth, ...callerHeaders };
	// Same 30s bound as the proxy path — a hung origin must not hang the Worker.
	// One bounded retry on transient failure (network/timeout throw or 502/503/504):
	// a flaky site or a momentary hiccup shouldn't fail the whole tool call. Each
	// attempt gets a fresh 30s signal; the retry is an ADDITIONAL layer over the
	// proxy→direct fallback above, not a replacement for it.
	return withRetry(() => fetch(url, { method: init.method, headers, body: init.body, redirect: init.redirect, signal: AbortSignal.timeout(30_000) }));
}

/**
 * Fetch a URL through the tailnet proxy (residential IP). Returns the proxied
 * response payload. Throws if the proxy is unconfigured or unreachable.
 */
export async function fetchViaTailscale(
	env: TailscaleEnv,
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; redirect?: "follow" | "manual" | "error" },
): Promise<ProxiedResponse> {
	if (!isTailscaleConfigured(env)) {
		throw new Error("Tailscale proxy not configured (TAILSCALE_PROXY_URL / TAILSCALE_PROXY_SECRET).");
	}

	const endpoint = new URL("/fetch", env.TAILSCALE_PROXY_URL).href;
	// acceptBodyEncoding tells an upgraded proxy it may base64-encode the
	// response body (signaled back via bodyEncoding:"base64") so binary survives
	// the JSON transport; legacy proxies ignore it and return plain strings.
	// redirect:"manual" lets a caller (redirects) trace the hop chain instead of
	// the node silently following; the node defaults to "follow" when it's absent.
	const payload = JSON.stringify({ url, method: init?.method, headers: init?.headers, body: init?.body, redirect: init?.redirect, acceptBodyEncoding: "base64" });
	// HMAC-sign (timestamp + payload) so the secret never crosses the wire and
	// requests can't be replayed outside a short window.
	const ts = String(Date.now());
	const signature = await hmacHex(env.TAILSCALE_PROXY_SECRET!, `${ts}\n${payload}`);

	// ts+sig also ride the query string: some CGI hosts (uhttpd) drop custom
	// request headers on POST, but QUERY_STRING is always delivered.
	const signedEndpoint = `${endpoint}?ts=${ts}&sig=${signature}`;
	const resp = await fetch(signedEndpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-timestamp": ts,
			"x-signature": signature,
		},
		body: payload,
		signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000),
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`Tailscale proxy error: HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
	}
	return (await resp.json()) as ProxiedResponse;
}

/**
 * Convenience: reconstruct a standard `Response` from the proxied payload, so
 * callers can treat it like a normal fetch result (`.text()`, `.status`, …).
 */
export async function fetchPageViaTailscale(env: TailscaleEnv, url: string, init?: Parameters<typeof fetchViaTailscale>[2]): Promise<Response> {
	return proxiedToResponse(await fetchViaTailscale(env, url, init));
}
