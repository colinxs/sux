import { afterEach, describe, expect, it, vi } from "vitest";

import { bestbuy } from "./bestbuy";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PRODUCTS = {
	products: [
		{
			sku: 6487433,
			name: "Sony - WH-1000XM4 Wireless Headphones",
			salePrice: 279.99,
			regularPrice: 349.99,
			onlineAvailability: true,
			image: "https://img/xm4.jpg",
			url: "https://www.bestbuy.com/site/6487433.p",
			manufacturer: "Sony",
		},
		{
			sku: 6427408,
			name: "Full-price Widget",
			salePrice: 99.99,
			regularPrice: 99.99,
			onlineAvailability: false,
			image: "https://img/w.jpg",
			url: "https://www.bestbuy.com/site/6427408.p",
			manufacturer: "Acme",
		},
	],
};

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (/\/v1\/products\/\d+\.json/.test(url)) return json(PRODUCTS.products[0]);
		if (url.includes("/v1/products")) return json(PRODUCTS);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const keyedEnv = () => ({ BESTBUY_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("bestbuy", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await bestbuy.run({} as any, { action: "search", term: "headphones" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/BESTBUY_API_KEY/);
	});

	it("search returns normalized products with promo derived from sale<regular", async () => {
		const { calls } = installFetch();
		const r = await bestbuy.run(keyedEnv(), { action: "search", term: "headphones", limit: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({
			id: "6487433",
			title: "Sony - WH-1000XM4 Wireless Headphones",
			brand: "Sony",
			price: 279.99,
			promo_price: 279.99,
			currency: "USD",
			image: "https://img/xm4.jpg",
			url: "https://www.bestbuy.com/site/6487433.p",
			in_stock: true,
		});
		// No promo when salePrice == regularPrice.
		expect(j.products[1].promo_price).toBeUndefined();
		expect(j.products[1].in_stock).toBe(false);
		const url = calls.urls[0];
		expect(url).toContain("((search=headphones))");
		expect(url).toContain("apiKey=KEY");
		expect(url).toContain("pageSize=5");
	});

	it("product returns a single normalized product by SKU", async () => {
		const { calls } = installFetch();
		const r = await bestbuy.run(keyedEnv(), { action: "product", sku: "6487433" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.products[0].id).toBe("6487433");
		expect(calls.urls[0]).toContain("/v1/products/6487433.json");
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async () => json({ error: "rate" }, 429)) as any;
		const r = await bestbuy.run(keyedEnv(), { action: "search", term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
