import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { isAllowedLogin } from "./utils";
import { cacheKey, CACHE_TTL_SECONDS, parseJsonRpc, sseResponse } from "./mcp-util";
import { findFn, type RtEnv, toolList } from "./registry";
import { FUNCTIONS } from "./fns";

type Props = { login: string; name: string; email: string; accessToken: string };

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
			const args = rpc?.params?.arguments;
			const fn = findFn(FUNCTIONS, name);
			if (!fn) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });

			const key = fn.cacheable ? await cacheKey(name, args) : null;
			if (key) {
				const cached = await env.OAUTH_KV.get(key);
				if (cached) return sseResponse({ jsonrpc: "2.0", id, result: JSON.parse(cached) });
			}
			let result;
			try {
				result = await fn.run(env, args);
			} catch (e) {
				result = { content: [{ type: "text" as const, text: `Tool '${name}' failed: ${String((e as Error).message ?? e)}` }], isError: true };
			}
			if (key && !result.isError) await env.OAUTH_KV.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
			return sseResponse({ jsonrpc: "2.0", id, result });
		}
		return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
	},
};

export default new OAuthProvider({
	apiHandler: rtServer as any,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
