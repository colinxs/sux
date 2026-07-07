import type OAuthProvider from "@cloudflare/workers-oauth-provider";
import { isAllowedLogin } from "./utils";
import { cacheKey, deferCacheWrite, type JsonRpc, parseJsonRpc, sseResponse } from "./mcp-util";
import { unpackFromCache } from "./cache-codec";
import { findFn, type RtEnv, type ToolResult, toolList } from "./registry";
import { singleFlight } from "./single-flight";
import { weightedRateLimit } from "./rate-limit";
import { hasAI, llm } from "./ai";

// Below this length a result isn't worth an AI round-trip to summarize (the call
// would cost more than the tokens it saves, and may even grow the text).
const SUMMARIZE_MIN_CHARS = 400;
import { FUNCTIONS } from "./fns";
import { recordCall } from "./metrics";
import { shipToLoki } from "./grafana";
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

		// Universal token-saver: a truthy `summarize` runs the fn's text output
		// through Workers AI to compress it before returning (fewer tokens back to
		// the agent). Detected+stripped up front like `fresh`, but it CHANGES the
		// result, so it namespaces the cache key (summarized and raw cache apart).
		let summarize = false;
		if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && (rawArgs as Record<string, unknown>).summarize) {
			summarize = true;
			delete (rawArgs as Record<string, unknown>).summarize;
		}

		// Sane normalization on open: fold styled/fullwidth "font" unicode to ASCII
		// and strip BOM/zero-width/control chars from string inputs. Byte-exact fns
		// (hash/encode/compress/qr/kv/…) opt out via `raw` so their bytes are untouched.
		const args = fn.raw ? rawArgs : normalizeArgs(rawArgs);

		const started = Date.now();
		const key = fn.cacheable ? await cacheKey(summarize ? `${name}::summarize` : name, args) : null;
		if (key && !fresh) {
			// Read as bytes so compressed frames (cache-codec) round-trip; unpack
			// reverses packForCache (plain string, or zstd/brotli frame). Any unpack
			// failure (corrupt/unknown codec) is treated as a miss and recomputed.
			try {
				const raw = await env.OAUTH_KV.get(key, "arrayBuffer");
				if (raw) {
					const hitEvent = { tool: name, ms: Date.now() - started, cache: true };
					recordCall(env, ctx, hitEvent);
					shipToLoki(env, ctx, hitEvent);
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
		// Summarize-before-return: compress the (normalized) text output with Workers
		// AI when the caller asked and the result is worth it. Best-effort — on AI
		// failure or when unavailable, the raw result is returned unchanged. The
		// summarized result is what gets cached (under the ::summarize key namespace).
		if (summarize && !fn.raw && !result.isError && Array.isArray(result.content) && hasAI(env)) {
			const joined = result.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
			if (joined.length >= SUMMARIZE_MIN_CHARS) {
				try {
					const s = await llm(env, "Summarize this tool result as concisely as possible while preserving key facts, names, numbers, dates, and URLs. Output only the summary — no preamble.", joined.slice(0, 24_000), 512);
					if (s.trim()) result = { content: [{ type: "text", text: s.trim() }], ...(result.noCache ? { noCache: true } : {}) };
				} catch (e) {
					console.warn(`sux summarize failed for '${name}', returning raw: ${String((e as Error).message ?? e)}`);
				}
			}
		}
		// Record WHY a call failed: from the caught exception, or the isError
		// result's first text part for fns that return failures without throwing.
		if (!err && result.isError && Array.isArray(result.content)) {
			const first = result.content.find((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string");
			if (first) err = (first as { text: string }).text;
		}
		const callEvent = { tool: name, ms: Date.now() - started, error: Boolean(result.isError), err };
		recordCall(env, ctx, callEvent);
		shipToLoki(env, ctx, callEvent);
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
		// Weighted rate limit: expensive tools (render/Kagi/SerpAPI/Workers AI)
		// consume extra tokens beyond the base 1 charged above, so a burst of paid
		// calls drains the budget faster than free deterministic fns (see Fn.cost).
		const limited = await weightedRateLimit(env, login!, rpc);
		if (limited) return limited;
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

// Best-effort maintenance run for the daily Cron Trigger (wrangler.jsonc crons).
// Keeps the Kroger client-credentials OAuth token warm in KV so the first `shop`
// call of the day doesn't pay the mint latency. Entirely optional: does nothing
// unless KROGER_CLIENT_ID/SECRET are configured, and is wrapped so it can NEVER
// throw — a failed tick must not surface as a Worker error. Mirrors the token
// cache scheme in fns/kroger.ts (same key, same expires_in - 60 TTL clamped to
// KV's 60s floor) so the value it writes is a drop-in for the read path there.
const KROGER_TOKEN_KEY = "sux:kroger:token";

async function refreshKrogerToken(env: RtEnv): Promise<void> {
	if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) return;
	const basic = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
	const resp = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: "grant_type=client_credentials&scope=product.compact",
	});
	if (!resp.ok) throw new Error(`Kroger OAuth HTTP ${resp.status}`);
	const j: any = await resp.json();
	const token = String(j?.access_token ?? "");
	if (!token) throw new Error("Kroger OAuth response had no access_token.");
	const ttl = Math.max(60, (Number(j?.expires_in) || 1800) - 60);
	await env.OAUTH_KV.put(KROGER_TOKEN_KEY, token, { expirationTtl: ttl });
}

async function maintenanceTick(env: RtEnv): Promise<void> {
	try {
		await refreshKrogerToken(env);
	} catch (e) {
		console.warn(`sux scheduled maintenance: kroger token refresh skipped: ${String((e as Error)?.message ?? e)}`);
	}
}

// The OAuth library throws on malformed requests (e.g. an unregistered
// redirect_uri), which Cloudflare surfaces as a raw 1101 error page. Wrap it so
// those become clean JSON errors: 400 for client mistakes, 500 otherwise.
export default {
	// Cron Trigger entrypoint. Best-effort only: the whole tick is deferred via
	// ctx.waitUntil and self-contained in try/catch so it never throws.
	async scheduled(_event: ScheduledController, env: RtEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(maintenanceTick(env));
	},
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
