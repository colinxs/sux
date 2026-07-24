import { describe, expect, it } from "vitest";
import {
	atLeastAsSensitiveAs,
	classify,
	derive,
	isTagged,
	join,
	MAX_SENSITIVITY,
	PUBLIC,
	sameSensitivity,
	SENSITIVITY_TAGS,
	sensitivity,
	type Sensitivity,
	type SensitivityTag,
	tag,
	tagsOf,
} from "./sensitivity";

/** All 32 subsets of the tag set. The lattice is small enough to check EXHAUSTIVELY, which beats
 * random sampling: a randomized property test that happens never to draw the empty set or the
 * full set would miss both boundaries, and those are exactly where a fail-open bug hides. */
const POWERSET: Sensitivity[] = Array.from({ length: 1 << SENSITIVITY_TAGS.length }, (_, mask) =>
	sensitivity(...SENSITIVITY_TAGS.filter((_t, i) => mask & (1 << i))),
);

describe("sensitivity lattice — a tag SET, not an ordered scale (#1457)", () => {
	it("is a set of tags, with no ordering to collapse them onto", () => {
		const phi = sensitivity("phi");
		const legal = sensitivity("legal");
		// Neither dominates: a routine lab value is PHI but not embarrassing, a public court
		// filing is legally fine anywhere but embarrassing. An integer riskTier cannot say that.
		expect(atLeastAsSensitiveAs(phi, legal)).toBe(false);
		expect(atLeastAsSensitiveAs(legal, phi)).toBe(false);
		expect(isTagged(phi, "phi")).toBe(true);
		expect(isTagged(phi, "legal")).toBe(false);
	});

	it("join NEVER narrows — the invariant that makes laundering impossible, over all 1024 pairs", () => {
		for (const a of POWERSET) {
			for (const b of POWERSET) {
				const j = join(a, b);
				expect(atLeastAsSensitiveAs(j, a)).toBe(true);
				expect(atLeastAsSensitiveAs(j, b)).toBe(true);
			}
		}
	});

	it("join is commutative, associative and idempotent — a value's tags can't depend on the order its sources were combined", () => {
		for (const a of POWERSET) {
			expect(sameSensitivity(join(a, a), a)).toBe(true);
			for (const b of POWERSET) {
				expect(sameSensitivity(join(a, b), join(b, a))).toBe(true);
				const c = sensitivity("secrets");
				expect(sameSensitivity(join(join(a, b), c), join(a, join(b, c)))).toBe(true);
			}
		}
	});

	it("join of no parts is PUBLIC, and PUBLIC is its identity", () => {
		expect(sameSensitivity(join(), PUBLIC)).toBe(true);
		for (const a of POWERSET) expect(sameSensitivity(join(a, PUBLIC), a)).toBe(true);
	});

	it("a summary of a PHI document is still PHI, and a diff of a legal file is still legal", () => {
		const note = tag("<clinical note>", sensitivity("phi"), "mychart:uwmedicine");
		const filing = tag("<court filing>", sensitivity("legal"), "vault:legal/");
		expect(tagsOf(derive("a summary", [note]).sensitivity)).toEqual(["phi"]);
		expect(tagsOf(derive("a diff", [filing]).sensitivity)).toEqual(["legal"]);
		// Combining them unions rather than picking a winner.
		const both = derive("a memo citing both", [note, filing]);
		expect(tagsOf(both.sensitivity)).toEqual(["phi", "legal"]);
		expect(both.sources).toEqual(["mychart:uwmedicine", "vault:legal/"]);
	});

	it("derive can add tags the transformation itself introduces, and never drops the inputs'", () => {
		const src = tag("x", sensitivity("financial"), "monarch");
		expect(tagsOf(derive("y", [src], sensitivity("embarrassment")).sensitivity)).toEqual(["embarrassment", "financial"]);
	});
});

describe("classify fails CLOSED — getting the direction backwards is silent and catastrophic (#1457)", () => {
	it("treats an unclassified value as maximally sensitive, NOT as public", () => {
		for (const unknownish of [undefined, null]) {
			expect(sameSensitivity(classify(unknownish), MAX_SENSITIVITY)).toBe(true);
			expect(sameSensitivity(classify(unknownish), PUBLIC)).toBe(false);
		}
	});

	it("taints the whole set on ONE unrecognized tag rather than dropping it — an unknown tag is more likely newer than wrong", () => {
		expect(sameSensitivity(classify(["phi", "quantum-risk"]), MAX_SENSITIVITY)).toBe(true);
		expect(sameSensitivity(classify([42]), MAX_SENSITIVITY)).toBe(true);
		expect(sameSensitivity(classify("not-a-tag"), MAX_SENSITIVITY)).toBe(true);
	});

	it("distinguishes a real empty Set (a classification was made) from an empty array (a field may have been dropped)", () => {
		expect(sameSensitivity(classify(new Set()), PUBLIC)).toBe(true);
		expect(sameSensitivity(classify([]), MAX_SENSITIVITY)).toBe(true);
	});

	it("round-trips a well-formed classification unchanged, from an array or a Set", () => {
		expect(tagsOf(classify(["legal", "phi"]))).toEqual(["phi", "legal"]);
		expect(tagsOf(classify(new Set<SensitivityTag>(["secrets"])))).toEqual(["secrets"]);
		expect(tagsOf(classify("phi"))).toEqual(["phi"]);
	});

	it("classifying then joining still never narrows — the fail-closed default survives a derivation", () => {
		const unclassified = classify(undefined);
		for (const a of POWERSET) expect(sameSensitivity(join(a, unclassified), MAX_SENSITIVITY)).toBe(true);
	});
});

describe("sensitivity serialization + comparison", () => {
	it("tagsOf is canonically ordered, so two equal classifications built in different orders serialize identically", () => {
		expect(tagsOf(sensitivity("financial", "phi"))).toEqual(tagsOf(sensitivity("phi", "financial")));
		expect(tagsOf(MAX_SENSITIVITY)).toEqual([...SENSITIVITY_TAGS]);
	});

	it("sameSensitivity is structural — two equal Sets are never ===, which would quietly make a gate never match", () => {
		expect(sensitivity("phi") === sensitivity("phi")).toBe(false);
		expect(sameSensitivity(sensitivity("phi"), sensitivity("phi"))).toBe(true);
		expect(sameSensitivity(sensitivity("phi"), sensitivity("phi", "legal"))).toBe(false);
	});

	it("MAX_SENSITIVITY and PUBLIC are frozen — a caller mutating a shared constant would silently reclassify every later comparison", () => {
		expect(() => (MAX_SENSITIVITY as Set<SensitivityTag>).clear()).toThrow();
		expect(() => (PUBLIC as Set<SensitivityTag>).add("phi")).toThrow();
	});
});
