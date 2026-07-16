import { afterEach, describe, expect, it, vi } from "vitest";
import { coingecko } from "./coingecko";

const SEARCH_BODY = {
	coins: [
		{ id: "bitcoin", name: "Bitcoin", symbol: "btc", market_cap_rank: 1 },
		{ id: "bitcoin-cash", name: "Bitcoin Cash", symbol: "bch", market_cap_rank: 20 },
	],
};

const PRICE_BODY = {
	bitcoin: { usd: 65000, usd_24h_change: 2.5 },
	ethereum: { usd: 3200, usd_24h_change: -1.1 },
};

afterEach(() => vi.restoreAllMocks());

describe("coingecko", () => {
	it("searches coins into { id, name, symbol, market_cap_rank }", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(SEARCH_BODY), { status: 200 }));
		const r = await coingecko.run({} as any, { action: "search", term: "bitcoin" });
		const out = JSON.parse(r.content[0].text);
		expect(out.action).toBe("search");
		expect(out.count).toBe(2);
		expect(out.coins[0]).toEqual({ id: "bitcoin", name: "Bitcoin", symbol: "btc", market_cap_rank: 1 });
		expect(String(spy.mock.calls[0][0])).toContain("/search?query=bitcoin");
	});

	it("defaults to search when no action is given", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(SEARCH_BODY), { status: 200 }));
		const r = await coingecko.run({} as any, { term: "btc" });
		const out = JSON.parse(r.content[0].text);
		expect(out.action).toBe("search");
		expect(out.count).toBe(2);
	});

	it("fetches prices into { id, price, change_24h }", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(PRICE_BODY), { status: 200 }));
		const r = await coingecko.run({} as any, { action: "price", ids: "bitcoin,ethereum" });
		const out = JSON.parse(r.content[0].text);
		expect(out.action).toBe("price");
		expect(out.currency).toBe("usd");
		expect(out.count).toBe(2);
		const btc = out.prices.find((p: any) => p.id === "bitcoin");
		expect(btc.price).toBe(65000);
		expect(btc.change_24h).toBe(2.5);
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("ids=bitcoin%2Cethereum");
		expect(url).toContain("include_24hr_change=true");
	});

	it("errors on price without ids", async () => {
		const r = await coingecko.run({} as any, { action: "price" });
		expect(r.isError).toBe(true);
	});

	it("errors on search without a term", async () => {
		const r = await coingecko.run({} as any, { action: "search" });
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }));
		const r = await coingecko.run({} as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/429/);
	});

	it("hints at COINGECKO_API_KEY on a keyless 403", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
		const r = await coingecko.run({} as any, { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/COINGECKO_API_KEY/);
	});

	it("sends x-cg-demo-api-key and omits the hint when COINGECKO_API_KEY is set", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(SEARCH_BODY), { status: 200 }));
		await coingecko.run({ COINGECKO_API_KEY: "demokey" } as any, { action: "search", term: "bitcoin" });
		const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["x-cg-demo-api-key"]).toBe("demokey");

		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
		const r = await coingecko.run({ COINGECKO_API_KEY: "demokey" } as any, { action: "search", term: "x" });
		expect(r.content[0].text).not.toMatch(/COINGECKO_API_KEY/);
	});
});
