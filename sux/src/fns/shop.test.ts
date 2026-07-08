import { beforeEach, describe, expect, it, vi } from "vitest";

// shop is a DISPATCHER: it routes {query, store, limit, zip} to a dedicated
// retail fn via the FUNCTIONS registry. Mock the registry so we can assert which
// fn was called with which translated args, and pass its result through verbatim.
const { runs } = vi.hoisted(() => ({
	runs: {
		amazon: vi.fn(),
		walmart: vi.fn(),
		homedepot: vi.fn(),
		lowes: vi.fn(),
		ace: vi.fn(),
		costco: vi.fn(),
		kroger: vi.fn(),
		weekly_ad: vi.fn(),
	} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("./index", () => ({
	FUNCTIONS: Object.entries(runs).map(([name, run]) => ({ name, run })),
}));

import { shop } from "./shop";

const okResult = (text: string) => ({ content: [{ type: "text", text }] });

beforeEach(() => {
	for (const fn of Object.values(runs)) fn.mockReset().mockResolvedValue(okResult("[]"));
});

describe("shop", () => {
	it("requires a query", async () => {
		const r = await shop.run({} as any, { query: "", store: "amazon" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/query is required/);
	});

	it("rejects an unknown store", async () => {
		const r = await shop.run({} as any, { query: "tv", store: "gshop" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/store must be one of/);
	});

	it("routes a plain retailer as action=search with the query as term", async () => {
		runs.walmart.mockResolvedValueOnce(okResult('{"retailer":"walmart"}'));
		const r = await shop.run({} as any, { query: "cordless drill", store: "walmart", limit: 5 });
		expect(runs.walmart).toHaveBeenCalledWith(expect.anything(), { action: "search", term: "cordless drill", limit: 5 });
		expect(r.content[0].text).toBe('{"retailer":"walmart"}'); // result passed through verbatim
	});

	it("maps home_depot -> homedepot and forwards zip", async () => {
		await shop.run({} as any, { query: "hammer", store: "home_depot", zip: "97201" });
		expect(runs.homedepot).toHaveBeenCalledWith(expect.anything(), { action: "search", term: "hammer", limit: 10, zip: "97201" });
		expect(runs.amazon).not.toHaveBeenCalled();
	});

	it("routes fred_meyer through kroger with the Fred Meyer chain filter", async () => {
		await shop.run({} as any, { query: "milk", store: "fred_meyer", zip: "97201" });
		expect(runs.kroger).toHaveBeenCalledWith(expect.anything(), { action: "search", term: "milk", limit: 10, chain: "Fred Meyer", zip: "97201" });
	});

	it("omits zip when none is given", async () => {
		await shop.run({} as any, { query: "eggs", store: "kroger" });
		expect(runs.kroger).toHaveBeenCalledWith(expect.anything(), { action: "search", term: "eggs", limit: 10 });
	});

	it("routes deals -> weekly_ad (term/zip/limit)", async () => {
		await shop.run({} as any, { query: "chicken", store: "deals", zip: "97201", limit: 8 });
		expect(runs.weekly_ad).toHaveBeenCalledWith(expect.anything(), { term: "chicken", limit: 8, zip: "97201" });
	});

	it("requires a 5-digit zip for deals", async () => {
		const r = await shop.run({} as any, { query: "chicken", store: "deals" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires a 5-digit/);
		expect(runs.weekly_ad).not.toHaveBeenCalled();
	});

	it("clamps limit to 1..25", async () => {
		await shop.run({} as any, { query: "tv", store: "amazon", limit: 999 });
		expect(runs.amazon).toHaveBeenCalledWith(expect.anything(), { action: "search", term: "tv", limit: 25 });
	});

	it("surfaces a thrown dispatch error as a failure", async () => {
		runs.ace.mockRejectedValueOnce(new Error("boom"));
		const r = await shop.run({} as any, { query: "paint", store: "ace" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/shop → ace failed: boom/);
	});
});
