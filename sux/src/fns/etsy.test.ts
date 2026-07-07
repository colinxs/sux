import { afterEach, describe, expect, it, vi } from "vitest";

import { etsy } from "./etsy";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LISTINGS = {
	count: 2,
	results: [
		{
			listing_id: 123456789,
			title: "Handmade Ceramic Mug",
			price: { amount: 2499, divisor: 100, currency_code: "USD" },
			url: "https://www.etsy.com/listing/123456789/handmade-ceramic-mug",
			tags: ["mug", "ceramic", "handmade"],
		},
		{
			listing_id: 987654321,
			title: "Free Item",
			price: { amount: 0, divisor: 100, currency_code: "USD" },
		},
	],
};

const keyedEnv = () => ({ ETSY_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("etsy", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await etsy.run({} as any, { term: "mug" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/ETSY_API_KEY/);
	});

	it("normalizes listings, dividing amount by divisor", async () => {
		const calls: Array<{ url: string; headers: any }> = [];
		global.fetch = vi.fn(async (u: any, init: any) => {
			calls.push({ url: String(u), headers: init?.headers });
			return json(LISTINGS);
		}) as any;
		const r = await etsy.run(keyedEnv(), { term: "mug", limit: 10 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.retailer).toBe("etsy");
		expect(j.count).toBe(2);
		expect(j.products[0]).toMatchObject({
			id: "123456789",
			title: "Handmade Ceramic Mug",
			price: 24.99,
			currency: "USD",
			url: "https://www.etsy.com/listing/123456789/handmade-ceramic-mug",
			tags: ["mug", "ceramic", "handmade"],
		});
		// amount 0 → price undefined (normalizeMoney drops non-positive).
		expect(j.products[1].price).toBeUndefined();
		expect(j.products[1].url).toBe("https://www.etsy.com/listing/987654321");
		expect(calls[0].url).toContain("keywords=mug");
		expect(calls[0].url).toContain("limit=10");
		expect(calls[0].headers["x-api-key"]).toBe("KEY");
	});

	it("carries upstream HTTP status into the failure", async () => {
		global.fetch = vi.fn(async () => json({ error: "unauthorized" }, 401)) as any;
		const r = await etsy.run(keyedEnv(), { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 401/);
	});
});
