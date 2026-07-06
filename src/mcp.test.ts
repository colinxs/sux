import { describe, expect, it } from "vitest";
import {
	cacheKey,
	curateToolsResult,
	extractRpcFromText,
	injectLensTool,
	isCacheableResult,
	LENS_TOOL,
	lensToSearchArgs,
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

describe("injectLensTool", () => {
	it("adds kagi_lens_search once (idempotent)", () => {
		const base = { tools: [{ name: "kagi_search_fetch" }] };
		const once = injectLensTool(base);
		expect(once.tools.map((t: any) => t.name)).toContain(LENS_TOOL.name);
		const twice = injectLensTool(once);
		expect(twice.tools.filter((t: any) => t.name === LENS_TOOL.name)).toHaveLength(1);
	});
	it("leaves non-tool results untouched", () => {
		expect(injectLensTool({ foo: 1 })).toEqual({ foo: 1 });
	});
});

describe("curateToolsResult", () => {
	it("passes tools through by default (empty config)", () => {
		const r = { tools: [{ name: "kagi_search_fetch" }, { name: "kagi_extract" }] };
		expect(curateToolsResult(r).tools.map((t: any) => t.name)).toEqual(["kagi_search_fetch", "kagi_extract"]);
	});
});

describe("lensToSearchArgs", () => {
	it("maps a preset to its lens_id", () => {
		const out = lensToSearchArgs({ query: "q", lens: "academic" });
		expect(out).toMatchObject({ query: "q", lens_id: "2" });
	});
	it("passes ad-hoc domain filters through", () => {
		const out = lensToSearchArgs({ query: "q", include_domains: ["docs.rs"] });
		expect(out).toMatchObject({ query: "q", include_domains: ["docs.rs"] });
		expect(out.lens_id).toBeUndefined();
	});
	it("drops preset lens_id when explicit filters are given (mutual exclusivity)", () => {
		const out = lensToSearchArgs({ query: "q", lens: "academic", include_domains: ["a.com"] });
		expect(out.lens_id).toBeUndefined();
		expect(out.include_domains).toEqual(["a.com"]);
	});
	it("ignores unknown preset names", () => {
		const out = lensToSearchArgs({ query: "q", lens: "does-not-exist" });
		expect(out.lens_id).toBeUndefined();
		expect(out.query).toBe("q");
	});
});
