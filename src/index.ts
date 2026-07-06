// OAuth→Bearer reverse proxy for Kagi's hosted MCP server.
//
// claude.ai web + iOS custom connectors speak OAuth only and have no field for a
// static bearer token. Kagi's hosted MCP (https://mcp.kagi.com/mcp) currently
// authenticates with `Authorization: Bearer <API key>` and does NOT support OAuth
// yet. This Worker bridges the gap: workers-oauth-provider terminates Claude's
// OAuth (GitHub login), we gate to a single GitHub account, then transparently
// proxy the MCP JSON-RPC / SSE stream to Kagi with the API key injected
// server-side. Tools (kagi_search_fetch, kagi_extract, and whatever Kagi adds
// later) are entirely Kagi's — this file defines none.
//
// When Kagi ships OAuth, delete this Worker and point Claude at mcp.kagi.com/mcp.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { isAllowedLogin } from "./utils";

// Cloudflare Rate Limiting binding (configured under `unsafe` in wrangler.jsonc).
type RateLimiter = { limit: (opts: { key: string }) => Promise<{ success: boolean }> };

// KAGI_API_KEY and ALLOWED_GITHUB_LOGIN are set via `wrangler secret put` and are
// not yet in the generated Env type; intersect them in here.
type KagiEnv = Env & {
	KAGI_API_KEY: string;
	// Comma-separated list of allowed GitHub usernames (case-insensitive).
	ALLOWED_GITHUB_LOGIN: string;
	// "1" enables verbose per-request proxy logging (see wrangler.jsonc vars).
	DEBUG_MCP?: string;
	// Present only if the ratelimit binding is configured; guarded before use.
	MCP_RATE_LIMITER?: RateLimiter;
};

// Props stamped onto the token by github-handler.ts (see completeAuthorization).
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

const KAGI_MCP_URL = "https://mcp.kagi.com/mcp";

const kagiProxy = {
	async fetch(
		request: Request,
		env: KagiEnv,
		ctx: ExecutionContext & { props?: Props },
	): Promise<Response> {
		// --- Single-user gate ------------------------------------------------
		// workers-oauth-provider has already validated the OAuth token and put the
		// GitHub identity on ctx.props. Fail closed if it isn't the owner.
		const login = ctx.props?.login;
		if (!isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)) {
			// Log the rejection so a misconfigured ALLOWED_GITHUB_LOGIN (or an
			// unexpected visitor) is diagnosable from logs. An empty allowlist fails
			// closed here — every request 403s.
			console.warn(`gate: rejected login=${JSON.stringify(login ?? null)}`);
			return new Response(
				JSON.stringify({
					error: "forbidden",
					detail: `GitHub user "${login ?? "unknown"}" is not authorized for this connector.`,
				}),
				{ status: 403, headers: { "content-type": "application/json" } },
			);
		}

		// --- Per-user rate limit (abuse guard if a token ever leaks) ---------
		// Keyed by GitHub login so one user can't exhaust another's budget.
		if (env.MCP_RATE_LIMITER) {
			const { success } = await env.MCP_RATE_LIMITER.limit({ key: login! });
			if (!success) {
				console.warn(`ratelimit: throttled login=${JSON.stringify(login)}`);
				return new Response(
					JSON.stringify({ error: "rate_limited", detail: "Too many requests. Slow down and retry." }),
					{ status: 429, headers: { "content-type": "application/json", "retry-after": "10" } },
				);
			}
		}

		// --- Reverse proxy to Kagi's hosted MCP ------------------------------
		const incoming = new URL(request.url);
		const target = KAGI_MCP_URL + incoming.search;

		// Preserve client headers (keeps Accept: application/json, text/event-stream
		// so streamable-HTTP / SSE works), swap in the Kagi key, drop Host.
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${env.KAGI_API_KEY}`);
		headers.delete("host");

		// Diagnostics are opt-in via DEBUG_MCP. When off, the request body is
		// streamed straight through (no buffering); when on, we read the tiny
		// JSON-RPC body to log its method/id, correlated by cf-ray.
		const debug = env.DEBUG_MCP === "1";
		const ray = request.headers.get("cf-ray") ?? "-";
		const isBodyless = request.method === "GET" || request.method === "HEAD";

		let init: RequestInit;
		if (isBodyless) {
			init = { method: request.method, headers };
		} else if (debug) {
			const bodyText = await request.text();
			try {
				const j = JSON.parse(bodyText);
				console.log(
					`[${ray}] mcp -> ${request.method} method=${j.method ?? "?"} id=${JSON.stringify(j.id)} login=${JSON.stringify(ctx.props?.login)} sid=${request.headers.get("mcp-session-id") ?? "-"}`,
				);
			} catch {
				console.log(`[${ray}] mcp -> ${request.method} (non-JSON body, ${bodyText.length}b)`);
			}
			init = { method: request.method, headers, body: bodyText };
		} else {
			init = {
				method: request.method,
				headers,
				body: request.body,
				// @ts-expect-error - `duplex` is required for streaming request bodies on Workers
				duplex: "half",
			};
		}

		let upstream: Response;
		try {
			upstream = await fetch(target, init);
		} catch (err) {
			// Network-level failure reaching Kagi (DNS, TLS, timeout). The tool
			// error path in Kagi returns 200 with an in-band JSON-RPC error, so
			// reaching here means the request never completed at all.
			console.error(`[${ray}] upstream: fetch to ${target} threw:`, err);
			return new Response(
				JSON.stringify({
					error: "bad_gateway",
					detail: "Failed to reach the Kagi MCP upstream.",
				}),
				{ status: 502, headers: { "content-type": "application/json" } },
			);
		}

		if (debug) {
			console.log(
				`[${ray}] mcp <- ${upstream.status} ct=${upstream.headers.get("content-type")} sid=${upstream.headers.get("mcp-session-id") ?? "-"} enc=${upstream.headers.get("content-encoding") ?? "-"}`,
			);
		}
		if (upstream.status >= 400) {
			console.error(`[${ray}] upstream: Kagi returned HTTP ${upstream.status} for ${request.method} ${incoming.pathname}`);
		}

		// Stream Kagi's response (JSON or text/event-stream) straight back.
		//
		// Copy the headers but drop content-encoding / content-length: the Workers
		// runtime already decoded the body when it read `upstream.body`, so leaving
		// a stale `content-encoding: gzip` would make the client try to gunzip
		// plaintext, and a stale content-length would truncate/desync the stream.
		const respHeaders = new Headers(upstream.headers);
		respHeaders.delete("content-encoding");
		respHeaders.delete("content-length");

		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: respHeaders,
		});
	},
};

export default new OAuthProvider({
	apiHandler: kagiProxy as any,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
