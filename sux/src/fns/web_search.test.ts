import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../kagi", () => ({
	kagiTool: vi.fn(async () => ({ content: [{ type: "text", text: "### [Kagi Result](https://example.com/a)\n**URL:** https://example.com/a\nA kagi snippet.\n\n### [Second Result](https://example.org/b)\n**URL:** https://example.org/b\nAnother snippet." }] })),
}));

// google renders via the `render` mac backend (registry); ddg scrapes via the
// residential proxy (smartFetch). Mock both seams.
const { renderRun } = vi.hoisted(() => ({ renderRun: vi.fn() }));
vi.mock("./index", () => ({ FUNCTIONS: [{ name: "render", run: renderRun }] }));
const { smartFetch } = vi.hoisted(() => ({ smartFetch: vi.fn() }));
vi.mock("../proxy", () => ({ smartFetch }));

import { parseDdg, parseGoogleSerp, webSearch } from "./web_search";

const serp = (hits: Array<{ url: string; title: string }>) =>
	`<html><body>${hits.map((h) => `<div class="g"><a href="${h.url}"><h3>${h.title}</h3></a></div>`).join("")}</body></html>`;

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("parseGoogleSerp", () => {
	it("extracts anchor→h3 result pairs, drops Google's own hosts, unwraps /url?q=", () => {
		const html = `
			<a href="/url?q=https://real.example/page&sa=U"><h3>Real Result</h3></a>
			<a href="https://support.google.com/x"><h3>Google Help</h3></a>
			<a href="https://foo.com/a"><h3>Foo</h3></a>
			<a href="https://foo.com/a"><h3>Foo dupe</h3></a>`;
		const hits = parseGoogleSerp(html, 10);
		expect(hits.map((h) => h.url)).toEqual(["https://real.example/page", "https://foo.com/a"]);
		expect(hits[0].title).toBe("Real Result");
	});

	it("drops YouTube's off-site redirect wrapper (path-based, not host-based)", () => {
		const html = `
			<a href="https://www.youtube.com/redirect?q=https://real-site.com"><h3>YT Redirect</h3></a>
			<a href="https://foo.com/a"><h3>Foo</h3></a>`;
		const hits = parseGoogleSerp(html, 10);
		expect(hits.map((h) => h.url)).toEqual(["https://foo.com/a"]);
	});
});

describe("parseDdg", () => {
	it("skips a result whose uddg redirect has a malformed percent-escape, keeps the rest", () => {
		// The second anchor's uddg ends in a truncated escape (%E0%A4%A) that makes
		// decodeURIComponent throw — it must be skipped, not abort the whole parse.
		const html = `
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.example%2Fone">One</a>
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.example%2F%E0%A4%A">Bad</a>
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.example%2Ftwo">Two</a>`;
		const hits = parseDdg(html, 10);
		expect(hits.map((h) => h.url)).toEqual(["https://good.example/one", "https://good.example/two"]);
	});
});

describe("web_search", () => {
	it("requires a query", async () => {
		expect((await webSearch.run({} as any, {})).isError).toBe(true);
	});

	it("rejects an unknown engine", async () => {
		expect((await webSearch.run({} as any, { query: "x", engine: "yahoo" })).isError).toBe(true);
	});

	it("searches Kagi via engine:kagi (with the key)", async () => {
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "x", engine: "kagi" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. Kagi Result");
		expect(r.content[0].text).toContain("2. Second Result");
	});

	it("scrapes DuckDuckGo keyless (no render) and decodes the uddg redirect", async () => {
		const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fex.com%2Fp&rut=z">DDG Result</a>';
		smartFetch.mockResolvedValueOnce(new Response(html, { status: 200 }));
		const r = await webSearch.run({} as any, { query: "x", engine: "ddg" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. DDG Result");
		expect(r.content[0].text).toContain("https://ex.com/p");
		expect(String(smartFetch.mock.calls[0][1])).toContain("html.duckduckgo.com/html/");
		expect(renderRun).not.toHaveBeenCalled(); // no heavy render
	});

	it("renders Google via the mac backend (no key) and parses results", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: serp([{ url: "https://g.com/x", title: "G Result" }]) }] });
		const r = await webSearch.run({} as any, { query: "x", engine: "google" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. G Result");
		expect(r.content[0].text).toContain("https://g.com/x");
		expect(renderRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ backend: "mac", solve: true }));
		expect(String(renderRun.mock.calls[0][1].url)).toContain("google.com/search");
	});

	it("over-requests the Google SERP so a high limit can be honored after host-drops/dedupe", async () => {
		// Google's host filtering + dedupe shrink the parsed count, so the requested
		// num must exceed limit — a num capped at 20 could never honor limit:25.
		renderRun.mockResolvedValueOnce({ content: [{ text: serp([{ url: "https://g.com/x", title: "G Result" }]) }] });
		await webSearch.run({} as any, { query: "x", engine: "google", limit: 25 });
		const num = Number(new URL(String(renderRun.mock.calls[0][1].url)).searchParams.get("num"));
		expect(num).toBeGreaterThan(25);
	});

	it("calls Brave when the key is present", async () => {
		const fetchMock = vi.fn(async (_u?: any, _i?: any) => new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b.com", description: "brave desc" }] } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await webSearch.run({ BRAVE_API_KEY: "k" } as any, { query: "x", engine: "brave" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. B");
		expect((fetchMock.mock.calls[0][1] as any).headers["X-Subscription-Token"]).toBe("k");
	});

	it("gates brave without the key", async () => {
		const r = await webSearch.run({} as any, { query: "x", engine: "brave" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/BRAVE_API_KEY/);
	});

	it("engine 'all' fans out over the keyless engines + kagi and merges by consensus", async () => {
		// google also returns example.com/a → consensus ranks it above example.org/b; ddg returns nothing.
		renderRun.mockResolvedValueOnce({ content: [{ text: serp([{ url: "https://example.com/a", title: "Shared" }]) }] });
		smartFetch.mockResolvedValueOnce(new Response("<html></html>", { status: 200 }));
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "hello", engine: "all" });
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toMatch(/Merged \d+ results from: kagi, ddg, google/);
		expect(text.indexOf("example.com/a")).toBeLessThan(text.indexOf("example.org/b"));
	});

	it("surfaces a single engine's error instead of masking it as 'no results'", async () => {
		const kagi = await import("../kagi");
		(kagi.kagiTool as any).mockRejectedValueOnce(new Error("HTTP 401"));
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "x", engine: "kagi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("Engine 'kagi' failed");
		expect(r.content[0].text).toContain("HTTP 401");
		expect(r.content[0].text).not.toMatch(/No results/);
	});

	it("summarize falls back to the plain list when AI is absent", async () => {
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "hello", summarize: true });
		expect(r.content[0].text).toMatch(/summary skipped/);
	});

	it("summarize uses Workers AI when available", async () => {
		const env = { KAGI_API_KEY: "k", AI: { run: vi.fn(async () => ({ response: "A concise briefing [1]." })) } } as any;
		const r = await webSearch.run(env, { query: "hello", summarize: true });
		expect(r.content[0].text).toContain("concise briefing");
		expect(r.content[0].text).toContain("— Sources —");
	});
});
