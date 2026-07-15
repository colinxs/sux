// Worker-side client for the Tailscale residential fetch-proxy (tailscale-proxy/).
//
// Cloudflare Workers egress from datacenter IPs that Akamai-protected retailers
// (Home Depot, Lowe's, Costco) block. This delegates a fetch to a node in your
// tailnet — exposed via Tailscale Funnel — so the request originates from a
// residential IP. Use it as a fetch-ladder rung for those hosts only; normal
// fetch is fine everywhere else.

import { githubAuthHeaders, isGithubHost } from "./github-auth";
import { type EgressEvent, shipEgress } from "./grafana";

// Per-tools/call egress-audit context. handleRpc (index.ts) hangs it off a
// PER-REQUEST env clone before the fn runs, so smartFetch — reached through ~20
// fns without threading a new positional arg — can ship one correlated Loki line
// per outbound fetch decision. Per-request (not parked on the shared isolate env)
// so concurrent tools/call requests don't clobber each other's reqId/ctx. Absent
// outside a tools/call (or when Grafana is unconfigured) → no-op.
export type EgressContext = { ctx: { waitUntil(p: Promise<unknown>): void }; reqId: string };

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
	// Loki push secrets (the real RtEnv carries these) — read by smartFetch's
	// egress audit; all-optional here so shipEgress no-ops when unconfigured.
	GRAFANA_LOKI_URL?: string;
	GRAFANA_LOKI_USER?: string;
	GRAFANA_LOKI_TOKEN?: string;
	// Set per tools/call by handleRpc on a per-request env clone; carries the
	// correlation id + ctx so the egress audit can tag and fire-and-forget each
	// outbound fetch decision without racing a concurrent request's context.
	_egress?: EgressContext;
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
const DIRECT_HOST_RE = /(^|\.)(?:mcp\.kagi\.com|cloudflare-dns\.com|dns\.google|ipwho\.is|ip-api\.com)$/i;

export function isDirectHost(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		// GitHub is a token-authed structured-JSON API (git store + raw blobs), not a
		// bot-walled retailer needing a residential IP — it works fine from datacenter
		// egress and MUST bypass the proxy. Laundering it through the residential node
		// let a home-node interstitial (a 200 HTML block page) reach ghJson as an
		// unparseable body, which every vault op then read as an EMPTY vault (list→0,
		// read→"", head→null). Direct-route exactly the hosts we trust with the token.
		if (isGithubHost(hostname)) return true;
		return DIRECT_HOST_RE.test(hostname);
	} catch {
		return false;
	}
}

/**
 * Decode the 32-bit IPv4 tail of an IPv4-mapped IPv6 literal (the part after
 * `::ffff:`) to dotted-decimal. Accepts the dotted form (`127.0.0.1`) and the
 * compressed two-group hex form the WHATWG URL parser emits (`7f00:1` = the high
 * and low 16-bit halves). Returns null when the tail isn't a recognizable v4
 * encoding, so the caller treats it as non-private (an ordinary hostname).
 */
function mappedV4ToDotted(tail: string): string | null {
	if (tail.includes(".")) return tail; // already dotted-decimal (e.g. ::ffff:127.0.0.1)
	const groups = tail.split(":");
	if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	const [hi, lo] = groups.map((g) => Number.parseInt(g, 16));
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * SSRF guard: reject loopback / private / link-local / CGNAT / ULA / metadata
 * address literals — the destinations the residential node must never be tricked
 * into fetching, since it sits *inside* the home LAN (router admin UI, uhttpd,
 * every other device). Mirrors node/server.mjs isPrivateIp. `host` is an IP
 * literal (v4 dotted-decimal or v6); anything that isn't a recognizable private
 * literal returns false so ordinary hostnames pass through.
 */
export function isPrivateIp(host: string): boolean {
	if (host.includes(":")) {
		// IPv6: unspecified (::), loopback (::1), unique-local (fc00::/7), link-local (fe80::/10), v4-mapped.
		// `::` is the v6 twin of 0.0.0.0 (blocked below): connect() to it reaches loopback on Linux,
		// so it's an SSRF path to a local service exactly as 0.0.0.0 is — block both for parity.
		if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
		// IPv4-mapped IPv6 (::ffff:0:0/96) carries an embedded IPv4 address: evaluate
		// it as that IPv4 so a mapped private/loopback/metadata literal is caught.
		// The WHATWG URL parser (isBlockedTarget runs targets through `new URL`)
		// rewrites the dotted tail to compressed HEX — ::ffff:127.0.0.1 becomes
		// ::ffff:7f00:1 — so decode BOTH the dotted and hex tail forms back to
		// dotted-decimal; the raw hex form matched none of the IPv4 ranges and let a
		// v4-mapped loopback slip past this guard.
		if (host.startsWith("::ffff:")) {
			const dotted = mappedV4ToDotted(host.slice(7));
			return dotted != null && isPrivateIp(dotted);
		}
		// IPv4-compatible IPv6 (deprecated ::a.b.c.d / ::hi:lo form, first 96 bits
		// zero): same embedded-IPv4 trick as the v4-mapped case above, just without
		// the `ffff` marker group — decode the tail and re-run it as IPv4.
		if (host.startsWith("::") && host !== "::" && host !== "::1") {
			const dotted = mappedV4ToDotted(host.slice(2));
			return dotted != null && isPrivateIp(dotted);
		}
		return false;
	}
	const parts = host.split(".");
	if (parts.length !== 4) return false; // not a dotted-decimal IPv4 literal
	const oct = parts.map((n) => Number(n));
	if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = oct;
	return (
		a === 0 || a === 10 || a === 127 || // this-network, private, loopback
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10 (Tailscale's own range)
		(a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) // private
	);
}

/**
 * SSRF guard: true when `url` must NOT be fetched — a non-http(s) scheme, an
 * unparseable URL, a localhost name, or an IP literal in a private/loopback/
 * link-local/CGNAT/ULA/metadata range. The Worker can't resolve DNS, so this
 * catches IP-literal + localhost targets before they reach the residential node;
 * node/server.mjs resolves the host and re-checks every A/AAAA (DNS-rebinding).
 */
export function isBlockedTarget(url: string): boolean {
	let host: string;
	try {
		const u = new URL(url);
		if (u.protocol !== "http:" && u.protocol !== "https:") return true;
		host = u.hostname.toLowerCase();
	} catch {
		return true; // unparseable — refuse rather than forward garbage
	}
	// URL keeps IPv6 literals bracketed ([::1]); strip for the IP check.
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	// A trailing dot is the root-anchored FQDN form: "localhost." resolves to
	// loopback exactly as "localhost" does, yet slips past both the exact-match
	// and ".localhost" suffix checks below. Strip trailing dot(s) so the
	// fully-qualified form can't smuggle a loopback/localhost name past the guard.
	host = host.replace(/\.+$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	return isPrivateIp(host);
}

/**
 * Header-injection guard: true when any header name or value carries a CR or LF.
 * The residential node builds a curl `--config` file from the forwarded headers
 * (node/openwrt/fetch.sh writes `header = "KEY: VALUE"` lines); an embedded
 * newline breaks out of the header line and injects arbitrary curl directives —
 * rewrite the `-o` output path over a node file, add extra request URLs, or
 * exfiltrate /etc/sux-proxy.secret. Workers' own `fetch` already rejects CRLF in
 * headers, so this hard-refuses before a header can reach the proxy transport;
 * no legitimate caller sends a bare CR/LF in a header. (fetch.sh also strips
 * these node-side — defense in depth.)
 */
export function hasUnsafeHeader(headers?: Headers | Record<string, string>): boolean {
	if (!headers) return false;
	const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
	for (const [key, value] of entries) {
		if (/[\r\n]/.test(key) || /[\r\n]/.test(String(value))) return true;
	}
	return false;
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
export async function withRetry(fn: () => Promise<Response>): Promise<Response> {
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
/** Hostname of `url`, or "invalid" when it won't parse — never the full URL, so a
 * query-string secret can't reach the egress audit log. */
function egressHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "invalid";
	}
}

/** Ship one egress-audit line for a completed fetch decision, when a per-request
 * egress context is present on env. No-op otherwise (and shipEgress itself no-ops
 * when Grafana is unconfigured and never throws), so this is inert on every path
 * that isn't a tools/call with Grafana wired up. */
function auditEgress(env: TailscaleEnv, url: string, rung: EgressEvent["rung"], residential: boolean, status?: number): void {
	const eg = env._egress;
	if (!eg) return;
	shipEgress(env, eg.ctx, { reqId: eg.reqId, host: egressHost(url), rung, residential, status });
}

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
	// SSRF guard: never fetch a private/loopback/link-local/metadata target —
	// direct OR via the residential node (which sits inside the home LAN). Hard
	// refusal, not a fallback: an internal target is never the caller's intent.
	if (isBlockedTarget(url)) {
		throw new Error(`smartFetch: refusing blocked target ${url} (private/loopback/link-local/metadata host)`);
	}
	// Header-injection guard: a CR/LF in a header name/value would break out of a
	// curl config line on the residential node. Hard refusal (like isBlockedTarget)
	// so a proxy→direct fallback can never smuggle the header through either path.
	if (hasUnsafeHeader(init.headers)) {
		throw new Error("smartFetch: refusing header with CR/LF in name or value (header injection)");
	}
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
				auditEgress(env, url, "proxied", true, p.status);
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
	const resp = await withRetry(() => fetch(url, { method: init.method, headers, body: init.body, redirect: init.redirect, signal: AbortSignal.timeout(30_000) }));
	auditEgress(env, url, directRoute, false, resp.status);
	return resp;
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
	// Header-injection guard for direct callers of this transport (smartFetch
	// already checks, but fetchPageViaTailscale and future callers reach here too).
	if (hasUnsafeHeader(init?.headers)) {
		throw new Error("fetchViaTailscale: refusing header with CR/LF in name or value (header injection)");
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
