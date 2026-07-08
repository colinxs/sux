import { afterEach, describe, expect, it, vi } from "vitest";
import { weekly_ad } from "./weekly_ad";

const BODY = {
	items: [
		{
			flyer_item_id: 111,
			name: "Boneless Chicken Breast",
			current_price: 2.99,
			original_price: 5.99,
			merchant_name: "Safeway",
			merchant_logo: "https://img/safeway.png",
			valid_to: "2026-07-14",
		},
		{
			flyer_item_id: 222,
			name: "Whole Chicken",
			current_price: 0.99,
			original_price: 1.49,
			merchant_name: "Fred Meyer",
			merchant_logo: "https://img/fredmeyer.png",
			valid_to: "2026-07-13",
		},
	],
};

afterEach(() => vi.restoreAllMocks());

describe("weekly_ad", () => {
	it("normalizes Flipp items and hits the keyless endpoint with zip + term", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await weekly_ad.run({} as any, { term: "chicken", zip: "97201" });
		const out = JSON.parse(r.content[0].text);
		expect(out.source).toBe("flipp");
		expect(out.term).toBe("chicken");
		expect(out.zip).toBe("97201");
		expect(out.count).toBe(2);
		expect(out.items[0]).toEqual({
			id: "111",
			title: "Boneless Chicken Breast",
			price: 2.99,
			original_price: 5.99,
			currency: "USD",
			merchant: "Safeway",
			merchant_logo: "https://img/safeway.png",
			valid_to: "2026-07-14",
		});
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("backflipp.wishabi.com/flipp/items/search");
		expect(url).toContain("postal_code=97201");
		expect(url).toContain("q=chicken");
		expect(url).toContain("locale=en-us");
	});

	it("filters by merchant substring, case-insensitively", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await weekly_ad.run({} as any, { term: "chicken", zip: "97201", merchant: "fred" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		expect(out.items[0].merchant).toBe("Fred Meyer");
	});

	it("returns an empty item list when Flipp has no matches", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
		const r = await weekly_ad.run({} as any, { term: "zzzznope", zip: "97201" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(0);
		expect(out.items).toEqual([]);
	});

	it("errors without a term", async () => {
		const r = await weekly_ad.run({} as any, { zip: "97201" });
		expect(r.isError).toBe(true);
	});

	it("errors on a non-5-digit zip", async () => {
		const r = await weekly_ad.run({} as any, { term: "chicken", zip: "972" });
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
		const r = await weekly_ad.run({} as any, { term: "chicken", zip: "97201" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/500/);
	});
});
