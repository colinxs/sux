import type OAuthProvider from "@cloudflare/workers-oauth-provider";
import { isAllowedLogin } from "./utils";
import { cacheKey, deferCacheWrite, type JsonRpc, parseJsonRpc, sseResponse } from "./mcp-util";
import { unpackFromCache } from "./cache-codec";
import { findFn, type RtEnv, type ToolResult, toolList } from "./registry";
import { singleFlight } from "./single-flight";
import { FUNCTIONS } from "./fns";
import { recordCall } from "./metrics";
import { handleObservability } from "./observability";
import { normalizeArgs, normalizeText } from "./normalize";

type Props = { login: string; name: string; email: string; accessToken: string };

// Per-isolate in-flight map for single-flight coalescing (see single-flight.ts).
// Keyed by the content-addressed cache key; entries clear when a run settles.
const inflight = new Map<string, Promise<ToolResult>>();

// The real tools/call dispatch chain, split out from rtServer.fetch so it can be
// exercised end-to-end in tests without constructing the module-scope
// OAuthProvider or a full Request. rtServer.fetch calls this after the auth gate,
// so the production path and tests run the exact same code.
export async function handleRpc(env: RtEnv, ctx: ExecutionContext, rpc: JsonRpc | undefined): Promise<Response> {
	const method = rpc?.method;
	const id = rpc?.id ?? null;

	if (!method) return new Response(null, { status: 202 });
	if (method === "initialize") {
		return sseResponse({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "research-tools", version: "0.1.0" },
			},
		});
	}
	if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
	if (method === "tools/list") {
		return sseResponse({ jsonrpc: "2.0", id, result: { tools: toolList(FUNCTIONS) } });
	}
	if (method === "tools/call") {
		const name = rpc?.params?.name ?? "";
		const fn = findFn(FUNCTIONS, name);
		if (!fn) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });

		// Universal cache-bypass: a truthy `fresh` in the arguments forces a cache
		// miss (skip the READ so the fn runs on live data) while leaving the WRITE
		// path untouched (the fresh result repopulates the same entry). Detect and
		// strip it up front — before cacheKey/normalize/run — so the fn never sees
		// `fresh` (schemas are additionalProperties:false) and the key is computed
		// from the same args a normal call uses, so a fresh call overwrites rather
		// than diverging. Harmless no-op for non-cacheable fns.
		const rawArgs = rpc?.params?.arguments;
		let fresh = false;
		if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && (rawArgs as Record<string, unknown>).fresh) {
			fresh = true;
			delete (rawArgs as Record<string, unknown>).fresh;
		}

		// Sane normalization on open: fold styled/fullwidth "font" unicode to ASCII
		// and strip BOM/zero-width/control chars from string inputs. Byte-exact fns
		// (hash/encode/compress/qr/kv/…) opt out via `raw` so their bytes are untouched.
		const args = fn.raw ? rawArgs : normalizeArgs(rawArgs);

		const started = Date.now();
		const key = fn.cacheable ? await cacheKey(name, args) : null;
		if (key && !fresh) {
			// Read as bytes so compressed frames (cache-codec) round-trip; unpack
			// reverses packForCache (plain string, or zstd/brotli frame). Any unpack
			// failure (corrupt/unknown codec) is treated as a miss and recomputed.
			try {
				const raw = await env.OAUTH_KV.get(key, "arrayBuffer");
				if (raw) {
					recordCall(env, ctx, { tool: name, ms: Date.now() - started, cache: true });
					return sseResponse({ jsonrpc: "2.0", id, result: JSON.parse(unpackFromCache(raw)) });
				}
			} catch (e) {
				console.warn(`sux cache read failed for '${name}', recomputing: ${String((e as Error).message ?? e)}`);
			}
		}
		let result: ToolResult;
		let err: string | undefined;
		try {
			// Coalesce concurrent same-key runs (cacheable fns only, keyed by the
			// content-addressed cache key) so a burst of identical calls runs the
			// expensive fn.run once; non-cacheable fns (no key) always run directly.
			result = key ? await singleFlight(inflight, key, () => fn.run(env, args)) : await fn.run(env, args);
		} catch (e) {
			err = String((e as Error).message ?? e);
			console.error(`sux tool '${name}' threw: ${(e as Error)?.stack ?? err}`);
			result = { content: [{ type: "text" as const, text: `Tool '${name}' failed: ${err}` }], isError: true };
		}
		// Sane normalization on close: same folding/cleanup over text output.
		if (!fn.raw && !result.isError && Array.isArray(result.content)) {
			for (const part of result.content) {
				if (part?.type === "text" && typeof part.text === "string") part.text = normalizeText(part.text);
			}
		}
		// Record WHY a call failed: from the caught exception, or the isError
		// result's first text part for fns that return failures without throwing.
		if (!err && result.isError && Array.isArray(result.content)) {
			const first = result.content.find((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string");
			if (first) err = (first as { text: string }).text;
		}
		recordCall(env, ctx, { tool: name, ms: Date.now() - started, error: Boolean(result.isError), err });
		// noCache/isError results are returned but never cached; the noCache flag is
		// stripped and the KV write happens off the response path via ctx.waitUntil.
		// fn.ttl (when set) overrides the global cache lifetime for this fn.
		deferCacheWrite(env.OAUTH_KV, ctx, key, result, fn.ttl);
		return sseResponse({ jsonrpc: "2.0", id, result });
	}
	return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

const rtServer = {
	async fetch(request: Request, env: RtEnv, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
		const login = ctx.props?.login;
		if (!isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)) {
			console.warn(`gate: rejected login=${JSON.stringify(login ?? null)}`);
			return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
		}
		if (env.MCP_RATE_LIMITER) {
			const { success } = await env.MCP_RATE_LIMITER.limit({ key: login! });
			if (!success) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });
		}

		const isBodyless = request.method === "GET" || request.method === "HEAD";
		const rpc = parseJsonRpc(isBodyless ? undefined : await request.text());
		return handleRpc(env, ctx, rpc);
	},
};

// Built lazily on first request so that importing this module (e.g. from
// index.test.ts to exercise handleRpc) does not eval @cloudflare/workers-oauth-
// provider / github-handler, which pull in runtime-only `cloudflare:` modules.
// Runtime behavior is unchanged: the provider is a per-isolate singleton.
let oauthProvider: OAuthProvider | undefined;
async function getOAuthProvider(): Promise<OAuthProvider> {
	if (!oauthProvider) {
		const [{ default: OAuthProviderCtor }, { GitHubHandler }] = await Promise.all([
			import("@cloudflare/workers-oauth-provider"),
			import("./github-handler"),
		]);
		oauthProvider = new OAuthProviderCtor({
			apiHandler: rtServer as any,
			apiRoute: "/mcp",
			authorizeEndpoint: "/authorize",
			clientRegistrationEndpoint: "/register",
			defaultHandler: GitHubHandler as any,
			tokenEndpoint: "/token",
		});
	}
	return oauthProvider;
}

// The OAuth library throws on malformed requests (e.g. an unregistered
// redirect_uri), which Cloudflare surfaces as a raw 1101 error page. Wrap it so
// those become clean JSON errors: 400 for client mistakes, 500 otherwise.
export default {
	async fetch(request: Request, env: RtEnv, ctx: ExecutionContext): Promise<Response> {
		// Public, unauthenticated observability routes (health/metrics/dashboard)
		// are served before the OAuth provider claims every path.
		const obs = await handleObservability(new URL(request.url), request, env);
		if (obs) return obs;
		try {
			return await (await getOAuthProvider()).fetch(request, env as any, ctx);
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			const clientError = /redirect|client|invalid|unauthoriz|unregister|missing|csrf|state/i.test(msg);
			console.error(`oauth wrapper caught: ${msg}`);
			return new Response(JSON.stringify({ error: clientError ? "invalid_request" : "server_error", error_description: msg }), {
				status: clientError ? 400 : 500,
				headers: { "content-type": "application/json" },
			});
		}
	},
};
