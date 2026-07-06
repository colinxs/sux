// Worker-side client for the Tailscale residential fetch-proxy (tailscale-proxy/).
//
// Cloudflare Workers egress from datacenter IPs that Akamai-protected retailers
// (Home Depot, Lowe's, Costco) block. This delegates a fetch to a node in your
// tailnet — exposed via Tailscale Funnel — so the request originates from a
// residential IP. Use it as a fetch-ladder rung for those hosts only; normal
// fetch is fine everywhere else.

export type TailscaleEnv = {
	// Public Funnel URL of the proxy node, e.g. https://box.tailnet-name.ts.net
	TAILSCALE_PROXY_URL?: string;
	// Shared secret matching the proxy's PROXY_SECRET.
	TAILSCALE_PROXY_SECRET?: string;
	// Escape hatch: set to "0" to force direct fetches even when the proxy is
	// configured. Default (unset) = proxy everything when configured.
	TAILSCALE_PROXY_ALL?: string;
};

export type ProxiedResponse = {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	bytes: number;
	truncated: boolean;
	body: string;
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
 * tailnet box is offline. Bodies are strings (all the proxy transports).
 */
export async function smartFetch(
	env: TailscaleEnv,
	url: string,
	init: { method?: string; headers?: Headers | Record<string, string>; body?: string } = {},
	route: Route = "auto",
): Promise<Response> {
	if (willProxy(env, url, route)) {
		try {
			const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
			return await fetchPageViaTailscale(env, url, { method: init.method, headers, body: init.body });
		} catch (e) {
			console.warn(`smartFetch: proxy failed, falling back to direct — ${String((e as Error).message ?? e)}`);
		}
	}
	return fetch(url, { method: init.method, headers: init.headers, body: init.body });
}

/**
 * Fetch a URL through the tailnet proxy (residential IP). Returns the proxied
 * response payload. Throws if the proxy is unconfigured or unreachable.
 */
export async function fetchViaTailscale(
	env: TailscaleEnv,
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<ProxiedResponse> {
	if (!isTailscaleConfigured(env)) {
		throw new Error("Tailscale proxy not configured (TAILSCALE_PROXY_URL / TAILSCALE_PROXY_SECRET).");
	}

	const endpoint = new URL("/fetch", env.TAILSCALE_PROXY_URL).href;
	const payload = JSON.stringify({ url, method: init?.method, headers: init?.headers, body: init?.body });
	// HMAC-sign (timestamp + payload) so the secret never crosses the wire and
	// requests can't be replayed outside a short window.
	const ts = String(Date.now());
	const signature = await hmacHex(env.TAILSCALE_PROXY_SECRET!, `${ts}\n${payload}`);

	const resp = await fetch(endpoint, {
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
	const p = await fetchViaTailscale(env, url, init);
	const headers = new Headers(p.headers);
	// The runtime already decoded the body; drop stale framing headers.
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(p.body, { status: p.status, statusText: p.statusText, headers });
}
