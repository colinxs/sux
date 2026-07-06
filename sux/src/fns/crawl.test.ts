import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { smartFetch } from "../proxy";
import { crawl } from "./crawl";

const mockFetch = smartFetch as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

describe("crawl", () => {
	it("rejects a non-absolute url", async () => {
		const r = await crawl.run({} as any, { url: "example.com/path" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("crawls same-origin links breadth-first and captures titles", async () => {
		mockFetch.mockImplementation(async (_env: unknown, url: string) => {
			if (url === "https://ex.com/") {
				return new Response(`<title> Home </title><a href="https://ex.com/about">a</a><a href="https://other.com/x">off</a>`, { status: 200 });
			}
			return new Response("<title>About</title>", { status: 200 });
		});
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 1, max: 25 });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.pages).toBe(2);
		expect(out.results.map((x: any) => x.url)).toEqual(["https://ex.com/", "https://ex.com/about"]);
		expect(out.results[0].title).toBe("Home");
		expect(out.results.some((x: any) => x.url.includes("other.com"))).toBe(false);
	});

	it("stops at depth 0 without following links (edge case)", async () => {
		mockFetch.mockResolvedValue(new Response(`<title>Seed</title><a href="https://ex.com/next">n</a>`, { status: 200 }));
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 0 });
		const out = JSON.parse(r.content[0].text);
		expect(out.pages).toBe(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("fails (not a cacheable empty success) when the seed fetch throws", async () => {
		mockFetch.mockRejectedValue(new Error("network down"));
		const r = await crawl.run({} as any, { url: "https://ex.com/" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/seed fetch failed/i);
		expect(r.content[0].text).toMatch(/network down/);
	});

	it("fails when the seed returns an HTTP error status", async () => {
		mockFetch.mockResolvedValue(new Response("<title>403 Forbidden</title>", { status: 403 }));
		const r = await crawl.run({} as any, { url: "https://ex.com/" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 403/);
	});

	it("skips a non-seed 404 page instead of indexing its error title", async () => {
		mockFetch.mockImplementation(async (_env: unknown, url: string) => {
			if (url === "https://ex.com/") {
				return new Response(`<title>Home</title><a href="https://ex.com/gone">g</a><a href="https://ex.com/about">a</a>`, { status: 200 });
			}
			if (url === "https://ex.com/gone") {
				return new Response(`<title>404 Not Found</title><a href="https://ex.com/from-error">e</a>`, { status: 404 });
			}
			return new Response("<title>About</title>", { status: 200 });
		});
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 2 });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.results.map((x: any) => x.url)).toEqual(["https://ex.com/", "https://ex.com/about"]);
		expect(out.results.some((x: any) => x.title?.includes("404"))).toBe(false);
		// links on the error page are not followed
		expect(mockFetch).not.toHaveBeenCalledWith(expect.anything(), "https://ex.com/from-error", expect.anything());
	});

	it("fetches a frontier level in parallel (pool > 1) but keeps deterministic index order", async () => {
		const links = Array.from({ length: 4 }, (_, i) => `<a href="https://ex.com/p${i}">l</a>`).join("");
		let inFlight = 0;
		let maxInFlight = 0;
		const resolvers: Array<() => void> = [];
		mockFetch.mockImplementation(async (_env: unknown, url: string) => {
			if (url === "https://ex.com/") return new Response(`<title>Home</title>${links}`, { status: 200 });
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Hold every child fetch open until all four have started, then release
			// them in reverse order — order in `results` must still be p0..p3.
			await new Promise<void>((resolve) => {
				resolvers.push(resolve);
				if (resolvers.length === 4) for (const r of resolvers.reverse()) r();
			});
			inFlight--;
			const n = url.slice(-1);
			return new Response(`<title>P${n}</title>`, { status: 200 });
		});
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 1, max: 25 });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(maxInFlight).toBe(4); // whole level was in flight at once
		expect(out.results.map((x: any) => x.url)).toEqual([
			"https://ex.com/",
			"https://ex.com/p0",
			"https://ex.com/p1",
			"https://ex.com/p2",
			"https://ex.com/p3",
		]);
	});

	it("respects max: fetches no more pages than the budget allows", async () => {
		const links = Array.from({ length: 20 }, (_, i) => `<a href="https://ex.com/p${i}">l</a>`).join("");
		mockFetch.mockImplementation(async (_env: unknown, url: string) => {
			if (url === "https://ex.com/") return new Response(`<title>Home</title>${links}`, { status: 200 });
			return new Response(`<title>Page</title>${links}`, { status: 200 });
		});
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 3, max: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.pages).toBe(5);
		// Budget bounds the *fetches* too, not just the indexed results.
		expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(5);
	});

	it("caps each page body read at 512KB (links past the cap are not seen)", async () => {
		const body = `<title>Seed</title><a href="https://ex.com/early">e</a>${"x".repeat(600 * 1024)}<a href="https://ex.com/late">l</a>`;
		mockFetch.mockImplementation(async (_env: unknown, url: string) => {
			if (url === "https://ex.com/") return new Response(body, { status: 200 });
			return new Response("<title>Early</title>", { status: 200 });
		});
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 1 });
		const out = JSON.parse(r.content[0].text);
		expect(out.results.map((x: any) => x.url)).toEqual(["https://ex.com/", "https://ex.com/early"]);
		expect(mockFetch).not.toHaveBeenCalledWith(expect.anything(), "https://ex.com/late", expect.anything());
	});
});
