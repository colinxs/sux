import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("<html>hello</html>", { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { scrape } from "./scrape";

describe("scrape", () => {
	it("rejects a non-http(s) url", async () => {
		const r = await scrape.run({} as any, { url: "ftp://example.com/file" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http\(s\) url/);
	});

	it("fetches a page through the proxy and returns its body", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("<h1>Hi</h1>", { status: 200 }));
		const r = await scrape.run({} as any, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("HTTP 200 — https://example.com");
		expect(r.content[0].text).toContain("<h1>Hi</h1>");
	});

	it("truncates bodies to 100k characters", async () => {
		const big = "x".repeat(150_000);
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response(big, { status: 200 }));
		const r = await scrape.run({} as any, { url: "https://example.com/big" });
		const body = r.content[0].text.split("\n\n").slice(1).join("\n\n");
		expect(body.length).toBe(100_000);
	});

	it("surfaces a non-200 status from the upstream response", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
		const r = await scrape.run({} as any, { url: "https://example.com/missing" });
		expect(r.content[0].text).toContain("HTTP 404 — https://example.com/missing");
		expect(r.content[0].text).toContain("Not Found");
	});

	it("marks upstream error pages noCache (they must not poison the cache)", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
		const r = await scrape.run({} as any, { url: "https://example.com/hot" });
		expect(r.isError).toBeFalsy(); // raw transport still returns the body
		expect(r.noCache).toBe(true);
		// 2xx responses stay cacheable.
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const good = await scrape.run({} as any, { url: "https://example.com" });
		expect(good.noCache).toBeUndefined();
	});
});
