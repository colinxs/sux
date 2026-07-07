import { extractRpcFromText } from "./mcp-util";
import { type Route, smartFetch, type TailscaleEnv } from "./proxy";

export type KagiEnv = { KAGI_API_KEY: string } & TailscaleEnv;
export type KagiResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;

const KAGI_MCP_URL = "https://mcp.kagi.com/mcp";

// `route` overrides smart routing for this call: mcp.kagi.com is a direct-host
// (see DIRECT_HOST_RE), so it egresses direct under "auto". Callers that want the
// query to originate from a residential IP pass "proxy" — smartFetch still falls
// back to a direct fetch when the tailnet node is down.
export async function kagiTool(env: KagiEnv, name: string, args: unknown, route: Route = "auto"): Promise<KagiResult> {
	const resp = await smartFetch(
		env,
		KAGI_MCP_URL,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.KAGI_API_KEY}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		},
		route,
	);
	const obj = extractRpcFromText(await resp.text(), resp.headers.get("content-type"));
	return (obj?.result as KagiResult) ?? null;
}
