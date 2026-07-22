import { describe, expect, it, vi } from "vitest";

const { kagiTool } = vi.hoisted(() => ({
	kagiTool: vi.fn(async (_env: any, _name: string, args: any, _route?: string) => {
		if (args.query === "boom") return { content: [{ text: "err" }], isError: true };
		return { content: [{ text: `## Search Results\n### [Result](https://x.com)\nfor ${args.query} limit=${args.limit} wf=${args.workflow}` }] };
	}),
}));
vi.mock("../kagi", () => ({ kagiTool }));

const { webSearchRun } = vi.hoisted(() => ({
	webSearchRun: vi.fn(async (_env: any, args: any) => ({ content: [{ text: `consensus results for ${args.query} engine=${args.engine} limit=${args.limit}` }] })),
}));
vi.mock("./web_search", () => ({ webSearch: { run: webSearchRun } }));

import { search } from "./search";

describe("search", () => {
	it("rejects an empty query", async () => {
		const r = await search.run({} as any, { query: "   " });
		expect(r.isError).toBe(true);
	});
	it("returns Kagi results and passes limit/workflow", async () => {
		const r = await search.run({} as any, { query: "cats", limit: 5, workflow: "news" });
		expect(r.content[0].text).toContain("Search Results");
		expect(r.content[0].text).toContain("limit=5");
		expect(r.content[0].text).toContain("wf=news");
	});
	it("surfaces upstream errors", async () => {
		const r = await search.run({} as any, { query: "boom" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Search failed/);
	});
	it("egresses direct (auto route) by default", async () => {
		await search.run({} as any, { query: "cats" });
		expect(kagiTool).toHaveBeenLastCalledWith(expect.anything(), "kagi_search_fetch", expect.anything(), "auto");
	});
	it("routes through the proxy when proxy: true", async () => {
		await search.run({} as any, { query: "cats", proxy: true });
		expect(kagiTool).toHaveBeenLastCalledWith(expect.anything(), "kagi_search_fetch", expect.anything(), "proxy");
	});
	it("passes extract_count through to kagi_search_fetch", async () => {
		await search.run({} as any, { query: "cats", extract_count: 3 });
		expect(kagiTool).toHaveBeenLastCalledWith(expect.anything(), "kagi_search_fetch", expect.objectContaining({ extract_count: 3 }), "auto");
	});
	it("rejects lens_id combined with file_type (Kagi's API is mutually exclusive here)", async () => {
		const r = await search.run({} as any, { query: "cats", lens_id: "2", file_type: "pdf" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/lens_id.*mutually exclusive|mutually exclusive.*lens_id/i);
	});
	it("rejects lens_id combined with include_domains", async () => {
		const r = await search.run({} as any, { query: "cats", lens_id: "2", include_domains: ["archive.org"] });
		expect(r.isError).toBe(true);
	});

	describe("consensus mode (#1294)", () => {
		it("fans out via web_search's engine:'all' + merge core instead of calling Kagi alone", async () => {
			const kagiCallsBefore = kagiTool.mock.calls.length;
			const r = await search.run({} as any, { query: "cats", consensus: true, limit: 15 });
			expect(kagiTool.mock.calls.length).toBe(kagiCallsBefore); // consensus mode never touches kagiTool directly
			expect(webSearchRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ query: "cats", engine: "all", limit: 15 }));
			expect(r.content[0].text).toContain("consensus results for cats");
		});

		it("carries include_domains/exclude_domains/file_type scope over to web_search", async () => {
			await search.run({} as any, { query: "cats", consensus: true, include_domains: ["a.com"], exclude_domains: ["b.com"], file_type: "pdf" });
			expect(webSearchRun).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ include_domains: ["a.com"], exclude_domains: ["b.com"], file_type: "pdf" }));
		});

		it("routes through the proxy when proxy:true", async () => {
			await search.run({} as any, { query: "cats", consensus: true, proxy: true });
			expect(webSearchRun).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ proxy: true }));
		});
	});
});
