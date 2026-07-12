import { describe, expect, it } from "vitest";
import { pct, classify, estimateAnthropicSpend, evaluate } from "../../scripts/billing-check.mjs";

describe("pct", () => {
	it("computes consumed percentage", () => {
		expect(pct(80, 100)).toBe(80);
		expect(pct(5_000_000, 10_000_000)).toBe(50);
	});
	it("returns null for an unknown/zero limit or non-finite use", () => {
		expect(pct(10, 0)).toBeNull();
		expect(pct(Number.NaN, 100)).toBeNull();
		expect(pct(10, Number.NaN)).toBeNull();
	});
	it("can exceed 100 when over allowance", () => {
		expect(pct(150, 100)).toBe(150);
	});
});

describe("classify", () => {
	it("flags over at/above threshold", () => {
		expect(classify(80, 80)).toBe("over");
		expect(classify(95, 80)).toBe("over");
	});
	it("warns in the run-up and is ok below", () => {
		expect(classify(65, 80)).toBe("warn");
		expect(classify(10, 80)).toBe("ok");
	});
	it("is unknown without a percentage", () => {
		expect(classify(null, 80)).toBe("unknown");
	});
});

describe("estimateAnthropicSpend", () => {
	it("sums per-run costs and skips null counts", () => {
		const { usd, parts } = estimateAnthropicSpend(
			{ "security-review": 2, claude: 1, "claude-autofix": null },
			{ "security-review": 1, claude: 0.5, "claude-autofix": 0.3 },
		);
		expect(usd).toBeCloseTo(2.5, 5);
		expect(parts).toEqual(["security-review×2", "claude×1"]);
	});
});

describe("evaluate", () => {
	it("attaches pct + level for ok meters and passes through non-ok state", () => {
		const [ok, skipped] = evaluate(
			[
				{ name: "a", state: "ok", used: 90, limit: 100, unit: "req" },
				{ name: "b", state: "skip", note: "no token" },
			],
			80,
		);
		expect(ok.pct).toBe(90);
		expect(ok.level).toBe("over");
		expect(skipped.pct).toBeNull();
		expect(skipped.level).toBe("skip");
	});
});
