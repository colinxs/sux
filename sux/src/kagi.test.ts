import { afterEach, describe, expect, it, vi } from "vitest";

// The only network seam is proxy.smartFetch — mock it like namespace-fns.test.ts so
// the REAL kagiTool runs: envelope construction, headers, extractRpcFromText parsing.
const { smartFetch } = vi.hoisted(() => ({ smartFetch: vi.fn() }));
vi.mock("./proxy", () => ({ smartFetch }));

import { type KagiEnv, kagiTool } from "./kagi";

const env = { KAGI_API_KEY: "k-secret" } as KagiEnv;
const jsonResp = (obj: unknown) => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });

afterEach(() => vi.clearAllMocks());

describe("kagiTool", () => {
	it("posts a tools/call JSON-RPC envelope with the bearer + accept headers", async () => {
		smartFetch.mockResolvedValueOnce(jsonResp({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } }));
		await kagiTool(env, "kagi_search_fetch", { query: "cats" });

		expect(smartFetch).toHaveBeenCalledTimes(1);
		const [, url, init, route] = smartFetch.mock.calls[0];
		expect(url).toBe("https://mcp.kagi.com/mcp");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer k-secret");
		expect(init.headers.Accept).toBe("application/json, text/event-stream");
		expect(init.headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(init.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kagi_search_fetch", arguments: { query: "cats" } } });
		// default route is "auto"
		expect(route).toBe("auto");
	});

	it("passes an explicit route through to smartFetch", async () => {
		smartFetch.mockResolvedValueOnce(jsonResp({ jsonrpc: "2.0", id: 1, result: {} }));
		await kagiTool(env, "kagi_search_fetch", { query: "x" }, "proxy");
		expect(smartFetch.mock.calls[0][3]).toBe("proxy");
	});

	it("returns the RPC result on a normal reply", async () => {
		const result = { content: [{ type: "text", text: "a snippet" }], isError: false };
		smartFetch.mockResolvedValueOnce(jsonResp({ jsonrpc: "2.0", id: 1, result }));
		expect(await kagiTool(env, "kagi_search_fetch", {})).toEqual(result);
	});

	it("parses an SSE reply (content-type text/event-stream)", async () => {
		const result = { content: [{ type: "text", text: "sse snippet" }] };
		const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
		smartFetch.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
		expect(await kagiTool(env, "kagi_search_fetch", {})).toEqual(result);
	});

	it("returns null when the reply carries no result", async () => {
		smartFetch.mockResolvedValueOnce(jsonResp({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } }));
		expect(await kagiTool(env, "kagi_search_fetch", {})).toBeNull();
	});

	it("returns null when the body is unparseable", async () => {
		smartFetch.mockResolvedValueOnce(new Response("", { headers: { "content-type": "application/json" } }));
		expect(await kagiTool(env, "kagi_search_fetch", {})).toBeNull();
	});
});
