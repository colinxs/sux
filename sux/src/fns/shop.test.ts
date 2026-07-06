import { afterEach, describe, expect, it, vi } from "vitest";
import { shop } from "./shop";

afterEach(() => vi.unstubAllGlobals());

describe("shop", () => {
	it("requires a query", async () => {
		expect((await shop.run({} as any, {})).isError).toBe(true);
	});

	it("reports unwired stores with guidance", async () => {
		const r = await shop.run({} as any, { query: "milk", store: "kroger" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Kroger.*API/i);
	});

	it("gates SerpAPI stores when the key is missing", async () => {
		const r = await shop.run({} as any, { query: "shoes", store: "gshop" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/SERPAPI_KEY/);
	});

	it("queries Google Shopping via SerpAPI and formats results", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ shopping_results: [{ title: "Widget", price: "$9.99", source: "Acme", link: "https://acme.com/w", rating: 4.5, reviews: 12 }] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const r = await shop.run({ SERPAPI_KEY: "k" } as any, { query: "widget", store: "gshop" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. Widget — $9.99");
		expect(r.content[0].text).toContain("4.5★ (12)");
		expect(r.content[0].text).toContain("[Acme]");
		// Correct engine + param name used.
		expect((fetchMock.mock.calls[0] as any[])[0]).toContain("engine=google_shopping");
		expect((fetchMock.mock.calls[0] as any[])[0]).toContain("q=widget");
	});

	it("uses the amazon engine with the k= param", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ organic_results: [{ title: "Book", price: "$5", link: "https://a.com/b" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await shop.run({ SERPAPI_KEY: "k" } as any, { query: "book", store: "amazon" });
		expect(r.isError).toBeFalsy();
		expect((fetchMock.mock.calls[0] as any[])[0]).toContain("engine=amazon");
		expect((fetchMock.mock.calls[0] as any[])[0]).toContain("k=book");
	});
});
