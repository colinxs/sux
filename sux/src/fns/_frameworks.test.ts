import { describe, expect, it } from "vitest";
import { FRAMEWORKS } from "./_frameworks";

describe("FRAMEWORKS", () => {
	for (const name of ["nvc", "principled-negotiation", "tactical-empathy", "carnegie", "cialdini"]) {
		it(`defines "${name}" with a non-empty versioned spec`, () => {
			const lens = FRAMEWORKS[name];
			expect(lens).toBeDefined();
			expect(typeof lens.version).toBe("number");
			expect(lens.version).toBeGreaterThanOrEqual(1);
			expect(lens.spec.trim().length).toBeGreaterThan(0);
		});
	}

	it("has exactly the 5 named lenses", () => {
		expect(Object.keys(FRAMEWORKS).sort()).toEqual(["carnegie", "cialdini", "nvc", "principled-negotiation", "tactical-empathy"]);
	});
});
