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
import {
	audit,
	cacheKey,
	CACHE_TTL_SECONDS,
	CACHEABLE_TOOLS,
	curateToolsResult,
	extractRpcFromText,
	isCacheableResult,
	parseJsonRpc,
	sseResponse,
} from "./mcp";

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
		const debug = env.DEBUG_MCP === "1";
		const ray = request.headers.get("cf-ray") ?? "-";

		// Preserve client headers (keeps Accept: application/json, text/event-stream
		// so streamable-HTTP / SSE works), swap in the Kagi key, drop Host.
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${env.KAGI_API_KEY}`);
		headers.delete("host");

		// We read the (tiny) JSON-RPC request body to route on its method. GET
		// stream opens have no body and always pass through.
		const isBodyless = request.method === "GET" || request.method === "HEAD";
		const bodyText = isBodyless ? undefined : await request.text();
		const rpc = parseJsonRpc(bodyText);
		const method = rpc?.method;

		if (debug) {
			console.log(
				`[${ray}] mcp -> ${request.method} method=${method ?? "?"} id=${JSON.stringify(rpc?.id)} login=${JSON.stringify(login)}`,
			);
		}

		const callKagi = (): Promise<Response> =>
			fetch(target, { method: request.method, headers, body: bodyText });

		// Hardened streaming passthrough — the default for anything we don't
		// compose. Strips content-encoding/content-length (Workers already decoded
		// the body) so the client never tries to gunzip plaintext.
		const passthrough = async (): Promise<Response> => {
			let upstream: Response;
			try {
				upstream = await callKagi();
			} catch (err) {
				console.error(`[${ray}] upstream: fetch to ${target} threw:`, err);
				return new Response(
					JSON.stringify({ error: "bad_gateway", detail: "Failed to reach the Kagi MCP upstream." }),
					{ status: 502, headers: { "content-type": "application/json" } },
				);
			}
			if (upstream.status >= 400) {
				console.error(`[${ray}] upstream: Kagi HTTP ${upstream.status} for ${method ?? request.method}`);
			}
			const respHeaders = new Headers(upstream.headers);
			respHeaders.delete("content-encoding");
			respHeaders.delete("content-length");
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: respHeaders,
			});
		};

		// Return upstream's raw bytes verbatim (used when an intercept branch read
		// the body but chose not to modify it).
		const rawResponse = (text: string, upstream: Response): Response => {
			const h = new Headers(upstream.headers);
			h.delete("content-encoding");
			h.delete("content-length");
			return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: h });
		};

		// --- tools/list: curate (hide / re-describe tools) -------------------
		if (method === "tools/list") {
			let upstream: Response;
			try {
				upstream = await callKagi();
			} catch (err) {
				console.error(`[${ray}] upstream: tools/list threw:`, err);
				return new Response(
					JSON.stringify({ error: "bad_gateway", detail: "Failed to reach the Kagi MCP upstream." }),
					{ status: 502, headers: { "content-type": "application/json" } },
				);
			}
			const text = await upstream.text();
			const obj = extractRpcFromText(text, upstream.headers.get("content-type"));
			if (!obj || !obj.result) return rawResponse(text, upstream); // unrecognized — pass through
			return sseResponse({ ...obj, result: curateToolsResult(obj.result) }, upstream.status);
		}

		// --- tools/call: cache read-only tools + audit -----------------------
		if (method === "tools/call") {
			const toolName = rpc?.params?.name ?? "";
			const args = rpc?.params?.arguments;
			const started = Date.now();
			const key = CACHEABLE_TOOLS.has(toolName) ? await cacheKey(toolName, args) : null;

			if (key) {
				const cached = await env.OAUTH_KV.get(key);
				if (cached) {
					audit({ login, tool: toolName, cache: "hit", ms: Date.now() - started, ray });
					return sseResponse({ jsonrpc: "2.0", id: rpc?.id, result: JSON.parse(cached) });
				}
			}

			let upstream: Response;
			try {
				upstream = await callKagi();
			} catch (err) {
				console.error(`[${ray}] upstream: tools/call threw:`, err);
				return new Response(
					JSON.stringify({ error: "bad_gateway", detail: "Failed to reach the Kagi MCP upstream." }),
					{ status: 502, headers: { "content-type": "application/json" } },
				);
			}
			const text = await upstream.text();
			const obj = extractRpcFromText(text, upstream.headers.get("content-type"));
			audit({
				login,
				tool: toolName,
				cache: key ? "miss" : "skip",
				ms: Date.now() - started,
				status: upstream.status,
				error: obj?.result?.isError === true || undefined,
				ray,
			});
			if (key && isCacheableResult(obj)) {
				await env.OAUTH_KV.put(key, JSON.stringify(obj!.result), { expirationTtl: CACHE_TTL_SECONDS });
			}
			return rawResponse(text, upstream);
		}

		// --- everything else: transparent passthrough ------------------------
		return passthrough();
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
