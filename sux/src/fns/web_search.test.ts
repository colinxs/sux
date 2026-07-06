import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../kagi", () => ({
	kagiTool: vi.fn(async () => ({ content: [{ type: "text", text: "### [Kagi Result](https://example.com/a)\n**URL:** https://example.com/a\nA kagi snippet.\n\n### [Second Result](https://example.org/b)\n**URL:** https://example.org/b\nAnother snippet." }] })),
}));

import { webSearch } from "./web_search";

afterEach(() => vi.clearAllMocks());

describe("web_search", () => {
	it("requires a query", async () => {
		expect((await webSearch.run({} as any, {})).isError).toBe(true);
	});

	it("gates key-based engines with a clear message", async () => {
		const r = await webSearch.run({} as any, { query: "x", engine: "google" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/SERPAPI_KEY/);
	});

	it("rejects an unknown engine", async () => {
		expect((await webSearch.run({} as any, { query: "x", engine: "yahoo" })).isError).toBe(true);
	});

	it("searches Kagi via engine:kagi (with the key)", async () => {
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "x", engine: "kagi" });
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain("1. Kagi Result");
		expect(text).toContain("https://example.com/a");
		expect(text).toContain("2. Second Result");
	});

	it("calls Google (SerpAPI) when the key is present", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ organic_results: [{ title: "G", link: "https://g.com", snippet: "desc" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await webSearch.run({ SERPAPI_KEY: "k" } as any, { query: "x", engine: "google" });
		vi.unstubAllGlobals();
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. G");
		expect(fetchMock).toHaveBeenCalled();
	});

	it("engine 'all' fans out over available engines and merges by consensus", async () => {
		// kagi returns example.com/a + example.org/b; google (keyed) also returns example.com/a.
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ organic_results: [{ title: "Kagi Result", link: "https://example.com/a", snippet: "google desc" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await webSearch.run({ KAGI_API_KEY: "k", SERPAPI_KEY: "k" } as any, { query: "hello", engine: "all" });
		vi.unstubAllGlobals();
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toMatch(/Merged \d+ results from: kagi, google/);
		// example.com/a appeared in both engines -> ranked first by consensus.
		expect(text.indexOf("example.com/a")).toBeLessThan(text.indexOf("example.org/b"));
	});

	it("summarize falls back to the plain list when AI is absent", async () => {
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "hello", summarize: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/summary skipped/);
	});

	it("summarize uses Workers AI when available", async () => {
		const env = { KAGI_API_KEY: "k", AI: { run: vi.fn(async () => ({ response: "A concise briefing [1]." })) } } as any;
		const r = await webSearch.run(env, { query: "hello", summarize: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("concise briefing");
		expect(r.content[0].text).toContain("— Sources —");
	});
});
