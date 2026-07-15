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

import { defaultEngine, parseDdg, parseGoogleSerp, parseKagiMarkdown, parseKagiSession, webSearch, withOperators } from "./web_search";

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

describe("parseKagiSession", () => {
	// Trimmed from a live kagi.com/html/search response (Cookie-auth'd on the subscription).
	const html = `
		<div class="_0_SRI  search-result " data-highlight="">
		  <div class="_0_TITLE __sri-title"><h3 class="__sri-title-box">
		    <a class="__sri_title_link _ext_ub_t _0_sri_title_link _0_URL" data-domain="openwrt.org" href="https://openwrt.org/docs/guide-user/network/wan/multiwan/mwan3"> [OpenWrt Wiki] mwan3 (failover) </a>
		  </h3></div>
		  <div class="_0_DESC __sri-desc">Jun 1, 2026 — mwan3 does policy routing &amp; failover across WANs.</div>
		</div>
		<div class="_0_SRI _ext_ub_r search-result ">
		  <div class="_0_TITLE __sri-title"><h3 class="__sri-title-box">
		    <a class="__sri_title_link _0_URL" data-domain="forum.openwrt.org" href="https://forum.openwrt.org/t/failover/123"> Failover using mwan3 - OpenWrt Forum </a>
		  </h3></div>
		  <div class="__sri-desc">Greetings — here is how I configured mwan3.</div>
		</div>`;
	it("parses title/url/snippet from Kagi's SSR result blocks, honoring the limit", () => {
		const hits = parseKagiSession(html, 10);
		expect(hits.length).toBe(2);
		expect(hits[0]).toMatchObject({ title: "[OpenWrt Wiki] mwan3 (failover)", url: "https://openwrt.org/docs/guide-user/network/wan/multiwan/mwan3" });
		expect(hits[0].snippet).toContain("policy routing & failover"); // entities decoded
		expect(hits[1].url).toBe("https://forum.openwrt.org/t/failover/123");
		expect(parseKagiSession(html, 1).length).toBe(1); // limit respected
	});
});

describe("parseKagiMarkdown", () => {
	it("parses ### [title](url) blocks with a snippet, respecting limit", () => {
		const md = "### [First](https://a.com)\n**URL:** https://a.com\nFirst snippet.\n\n### [Second](https://b.com)\n**URL:** https://b.com\nSecond snippet.";
		const hits = parseKagiMarkdown(md, 1);
		expect(hits.length).toBe(1);
		expect(hits[0]).toMatchObject({ title: "First", url: "https://a.com" });
		expect(hits[0].snippet).toContain("First snippet");
	});

	it("returns an empty array for markdown with no result blocks", () => {
		expect(parseKagiMarkdown("(no results)", 10)).toEqual([]);
	});
});

describe("defaultEngine", () => {
	it("prefers free Kagi-on-the-subscription when KAGI_SESSION is set, else keyless DDG", () => {
		expect(defaultEngine({ KAGI_SESSION: "tok" })).toBe("kagi_session");
		expect(defaultEngine({})).toBe("ddg");
	});
});

describe("withOperators", () => {
	it("returns the query unchanged with no scope", () => {
		expect(withOperators("cats", undefined)).toBe("cats");
	});

	it("folds file_type into a filetype: operator", () => {
		expect(withOperators("cats", { file_type: "pdf" })).toBe("cats filetype:pdf");
	});

	it("folds include_domains/exclude_domains into site:/-site: operators", () => {
		expect(withOperators("cats", { include_domains: ["archive.org"], exclude_domains: ["spam.com"] })).toBe("cats site:archive.org -site:spam.com");
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

	it("egresses the Kagi query direct (auto route) by default", async () => {
		const { kagiTool } = await import("../kagi");
		await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "x", engine: "kagi" });
		expect(kagiTool).toHaveBeenLastCalledWith(expect.anything(), "kagi_search_fetch", expect.anything(), "auto");
	});

	it("routes the Kagi query through the residential proxy when proxy: true", async () => {
		const { kagiTool } = await import("../kagi");
		await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "x", engine: "kagi", proxy: true });
		expect(kagiTool).toHaveBeenLastCalledWith(expect.anything(), "kagi_search_fetch", expect.anything(), "proxy");
	});

	it("folds file_type/include_domains into the kagi engine's query text (API has no file_type-over-session equivalent)", async () => {
		const { kagiTool } = await import("../kagi");
		await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "textbook", engine: "kagi", file_type: "pdf", include_domains: ["archive.org"] });
		expect(kagiTool).toHaveBeenLastCalledWith(expect.anything(), "kagi_search_fetch", expect.objectContaining({ query: "textbook filetype:pdf site:archive.org" }), "auto");
	});

	it("folds file_type/exclude_domains into the kagi_session query as operators (session path has no structured params)", async () => {
		smartFetch.mockResolvedValueOnce(new Response("<html></html>", { status: 200 }));
		await webSearch.run({ KAGI_SESSION: "tok" } as any, { query: "textbook", engine: "kagi_session", file_type: "pdf", exclude_domains: ["spam.com"] });
		const calledUrl = decodeURIComponent(String(smartFetch.mock.calls[0][1]));
		expect(calledUrl).toContain("q=textbook filetype:pdf -site:spam.com");
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

	it("calls Exa when the key is present", async () => {
		const fetchMock = vi.fn(async (_u?: any, _i?: any) => new Response(JSON.stringify({ results: [{ title: "E", url: "https://e.com", text: "exa snippet" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await webSearch.run({ EXA_API_KEY: "k" } as any, { query: "x", engine: "exa" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. E");
		expect((fetchMock.mock.calls[0][1] as any).headers["x-api-key"]).toBe("k");
	});

	it("gates exa without the key", async () => {
		const r = await webSearch.run({} as any, { query: "x", engine: "exa" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/EXA_API_KEY/);
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
		const r = await webSearch.run({ KAGI_API_KEY: "k" } as any, { query: "hello", engine: "kagi", summarize: true });
		expect(r.content[0].text).toMatch(/summary skipped/);
	});

	it("summarize uses Workers AI when available", async () => {
		const env = { KAGI_API_KEY: "k", AI: { run: vi.fn(async () => ({ response: "A concise briefing [1]." })) } } as any;
		const r = await webSearch.run(env, { query: "hello", engine: "kagi", summarize: true });
		expect(r.content[0].text).toContain("concise briefing");
		expect(r.content[0].text).toContain("— Sources —");
	});
});
