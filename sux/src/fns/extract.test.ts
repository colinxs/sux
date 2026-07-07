import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response('<a href="https://example.com/page">x</a>', { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { extract } from "./extract";

afterEach(() => vi.clearAllMocks());

describe("extract", () => {
	it("rejects a non-absolute url", async () => {
		const r = await extract.run({} as any, { url: "example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/url must be an absolute/);
	});

	it("extracts unique links from provided html", async () => {
		const html = '<a href="https://a.com">a</a><a href="https://b.com">b</a><a href="https://a.com">dup</a>';
		const r = await extract.run({} as any, { html, what: "links" });
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain("https://a.com");
		expect(text).toContain("https://b.com");
		// deduped: only one occurrence of a.com
		expect(text.split("\n").filter((l: string) => l === "https://a.com").length).toBe(1);
	});

	it("fetches via proxy when only a url is given (text mode strips tags)", async () => {
		const r = await extract.run({} as any, { url: "https://example.com" });
		expect(smartFetch).toHaveBeenCalledTimes(1);
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("x");
	});

	it("fails on an upstream 403 instead of extracting from the error page", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response('<h1>Access denied</h1><a href="https://cdn.blocker.example/help">x</a>', { status: 403 }));
		const r = await extract.run({} as any, { url: "https://example.com/blocked", what: "links" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Fetch failed: HTTP 403/);
	});

	it("fails on an upstream 404 instead of extracting from the error page", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("<p>not found</p>", { status: 404 }));
		const r = await extract.run({} as any, { url: "https://example.com/missing" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Fetch failed: HTTP 404/);
	});

	it("reports when no JSON-LD is present", async () => {
		const r = await extract.run({} as any, { html: "<p>no structured data here</p>", what: "jsonld" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/no JSON-LD found/);
	});
});
