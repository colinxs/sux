import { extractRpcFromText } from "./mcp-util";
import { smartFetch, type TailscaleEnv } from "./proxy";

export type KagiEnv = { KAGI_API_KEY: string } & TailscaleEnv;
export type KagiResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;

const KAGI_MCP_URL = "https://mcp.kagi.com/mcp";

export async function kagiTool(env: KagiEnv, name: string, args: unknown): Promise<KagiResult> {
	const resp = await smartFetch(env, KAGI_MCP_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.KAGI_API_KEY}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const obj = extractRpcFromText(await resp.text(), resp.headers.get("content-type"));
	return (obj?.result as KagiResult) ?? null;
}
