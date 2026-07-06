// Generic-function registry (Julia-style). Every capability is a `Fn` in its own
// file under fns/. The registry projects them into the MCP tools/list and
// dispatches tools/call to the right one. Adding a capability = add one file.

import type { TailscaleEnv } from "./proxy";

export type RtEnv = Env &
	TailscaleEnv & {
		KAGI_API_KEY: string;
		ALLOWED_GITHUB_LOGIN: string;
		DEBUG_MCP?: string;
		MCP_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
	};

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** One capability. Name = MCP tool name (a generic verb, dispatching internally). */
export type Fn = {
	name: string;
	description: string;
	inputSchema: unknown;
	/** Cache the result in KV (read-only, deterministic-ish). */
	cacheable?: boolean;
	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};

/** Build the MCP tools/list payload from a set of functions. */
export function toolList(fns: Fn[]): Array<{ name: string; description: string; inputSchema: unknown }> {
	return fns.map((f) => ({ name: f.name, description: f.description, inputSchema: f.inputSchema }));
}

export function findFn(fns: Fn[], name: string): Fn | undefined {
	return fns.find((f) => f.name === name);
}
