import { describe, expect, it } from "vitest";
import {
	cacheKey,
	curateToolsResult,
	extractRpcFromText,
	isCacheableResult,
	parseJsonRpc,
} from "./mcp";

describe("extractRpcFromText", () => {
	it("parses an SSE message frame", () => {
		const sse = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n`;
		expect(extractRpcFromText(sse, "text/event-stream")?.result).toEqual({ ok: true });
	});
	it("parses plain JSON", () => {
		expect(extractRpcFromText('{"id":2,"result":1}', "application/json")?.id).toBe(2);
	});
	it("returns null on garbage", () => {
		expect(extractRpcFromText("not json", "application/json")).toBeNull();
		expect(extractRpcFromText("", "text/event-stream")).toBeNull();
	});
});

describe("parseJsonRpc", () => {
	it("parses valid, tolerates invalid", () => {
		expect(parseJsonRpc('{"method":"x"}')?.method).toBe("x");
		expect(parseJsonRpc("nope")).toBeUndefined();
		expect(parseJsonRpc(undefined)).toBeUndefined();
	});
});

describe("isCacheableResult", () => {
	it("caches successful results only", () => {
		expect(isCacheableResult({ result: { content: [] } })).toBe(true);
		expect(isCacheableResult({ result: { content: [], isError: true } })).toBe(false);
		expect(isCacheableResult({ error: { code: -1 } })).toBe(false);
		expect(isCacheableResult(null)).toBe(false);
	});
});

describe("cacheKey", () => {
	it("is deterministic and args-sensitive", async () => {
		const a = await cacheKey("kagi_search_fetch", { query: "x" });
		const b = await cacheKey("kagi_search_fetch", { query: "x" });
		const c = await cacheKey("kagi_search_fetch", { query: "y" });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.startsWith("cache:")).toBe(true);
	});
});

describe("curateToolsResult", () => {
	it("keeps tool names and applies the description override", () => {
		const r = { tools: [{ name: "kagi_search_fetch", description: "orig" }, { name: "kagi_extract", description: "orig" }] };
		const out = curateToolsResult(r);
		expect(out.tools.map((t: any) => t.name)).toEqual(["kagi_search_fetch", "kagi_extract"]);
		// kagi_search_fetch gets the enriched lens/scoping description...
		expect(out.tools[0].description).toContain("lens_id");
		expect(out.tools[0].description).not.toBe("orig");
		// ...while un-overridden tools are left untouched.
		expect(out.tools[1].description).toBe("orig");
	});
});
