import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => ({
		text: async () =>
			`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First <b>Result</b></a>
			 <a class="result__snippet" href="x">Snippet <b>one</b> here</a>
			 <a class="result__a" href="https://example.org/b">Second Result</a>
			 <a class="result__snippet" href="y">Snippet two</a>`,
	})),
}));

import { webSearch } from "./web_search";

afterEach(() => vi.clearAllMocks());

describe("web_search", () => {
	it("requires a query", async () => {
		expect((await webSearch.run({} as any, {})).isError).toBe(true);
	});

	it("scrapes DuckDuckGo (keyless) and decodes redirect URLs", async () => {
		const r = await webSearch.run({} as any, { query: "hello" });
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain("1. First Result");
		expect(text).toContain("https://example.com/a");
		expect(text).toContain("Snippet one here");
		expect(text).toContain("2. Second Result");
		expect(text).toContain("https://example.org/b");
	});

	it("gates key-based engines with a clear message", async () => {
		const r = await webSearch.run({} as any, { query: "x", engine: "brave" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/BRAVE_API_KEY/);
	});

	it("calls Brave when the key is present", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b.com", description: "desc" }] } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await webSearch.run({ BRAVE_API_KEY: "k" } as any, { query: "x", engine: "brave" });
		vi.unstubAllGlobals();
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. B");
		expect(fetchMock).toHaveBeenCalled();
	});

	it("rejects an unknown engine", async () => {
		expect((await webSearch.run({} as any, { query: "x", engine: "yahoo" })).isError).toBe(true);
	});

	it("engine 'all' fans out over available engines and merges by consensus", async () => {
		// ddg (mocked proxy) returns example.com/a + example.org/b; brave (keyed) also returns example.com/a.
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ web: { results: [{ title: "First Result", url: "https://example.com/a", description: "brave desc" }] } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await webSearch.run({ BRAVE_API_KEY: "k" } as any, { query: "hello", engine: "all" });
		vi.unstubAllGlobals();
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toMatch(/Merged \d+ results from: ddg, brave/);
		// example.com/a appeared in both engines -> ranked first by consensus.
		expect(text.indexOf("example.com/a")).toBeLessThan(text.indexOf("example.org/b"));
	});

	it("summarize falls back to the plain list when AI is absent", async () => {
		const r = await webSearch.run({} as any, { query: "hello", summarize: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/summary skipped/);
	});

	it("summarize uses Workers AI when available", async () => {
		const env = { AI: { run: vi.fn(async () => ({ response: "A concise briefing [1]." })) } } as any;
		const r = await webSearch.run(env, { query: "hello", summarize: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("concise briefing");
		expect(r.content[0].text).toContain("— Sources —");
	});
});
