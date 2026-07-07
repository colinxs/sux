import { describe, expect, it } from "vitest";

import { normalizeMoney } from "./_retail";

// normalizeMoney is the shared money coercion behind every retailer fn's price
// field, so its edge behavior (strip currency/thousands, drop non-positive/junk)
// is load-bearing across kroger/walmart/costco/homedepot/lowes/ace/amazon.
describe("normalizeMoney", () => {
	it("passes through a positive number", () => {
		expect(normalizeMoney(99)).toBe(99);
		expect(normalizeMoney(3.99)).toBe(3.99);
	});

	it("parses a currency/thousands-formatted string", () => {
		expect(normalizeMoney("$1,234.56")).toBe(1234.56);
		expect(normalizeMoney("59.99")).toBe(59.99);
		expect(normalizeMoney("$0.50")).toBe(0.5);
	});

	it("treats a non-positive value as 'no price' (undefined)", () => {
		// Retailers signal "no price for this store" with 0, and a 0 promo = no promo.
		expect(normalizeMoney(0)).toBeUndefined();
		expect(normalizeMoney("$0.00")).toBeUndefined();
		expect(normalizeMoney(-5)).toBeUndefined();
	});

	it("returns undefined for unparseable / non-money inputs", () => {
		expect(normalizeMoney(undefined)).toBeUndefined();
		expect(normalizeMoney(null)).toBeUndefined();
		expect(normalizeMoney("")).toBeUndefined();
		expect(normalizeMoney("free")).toBeUndefined();
		expect(normalizeMoney(Number.NaN)).toBeUndefined();
		expect(normalizeMoney({})).toBeUndefined();
	});
});
