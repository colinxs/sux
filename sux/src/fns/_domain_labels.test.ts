import { describe, expect, it } from "vitest";
import { ALL_DOMAIN_CATEGORIES, compileHighConfidenceSieve, labelsFor } from "./_domain_labels";

// The label outputs below are the authoritative expectations from the audited generator's `--check`
// mode (scripts/gen-sieve). labelsFor is a verbatim port, so these must match byte-for-byte.
describe("labelsFor — high-confidence sender-domain labels", () => {
	it("hierarchical education, most-specific first", () => {
		expect(labelsFor("student@uw.edu")).toEqual(["edu", "uw"]);
		expect(labelsFor("prof@cs.uw.edu")).toEqual(["edu", "uw", "cs"]);
		expect(labelsFor("ta@ece.uw.edu")).toEqual(["edu", "uw", "ece"]);
		expect(labelsFor("support@cs.washington.edu")).toEqual(["edu", "uw", "cs"]);
		expect(labelsFor("husky@washington.edu")).toEqual(["edu", "uw"]);
	});

	it("a multi-level UW subdomain stays edu+uw (no messy compound dept flag)", () => {
		expect(labelsFor("x@mail.cs.uw.edu")).toEqual(["edu", "uw"]);
	});

	it("generic .edu and international academic TLDs get edu only", () => {
		expect(labelsFor("newton@mit.edu")).toEqual(["edu"]);
		expect(labelsFor("don@balliol.ac.uk")).toEqual(["edu"]);
	});

	it("brand groups match apex + subdomains by first-party domain", () => {
		expect(labelsFor("alerts@email.chase.com")).toEqual(["finance"]);
		expect(labelsFor("receipts@order.amazon.com")).toEqual(["shopping"]);
	});

	it("excludes ESP / relay infrastructure (it carries unrelated brands' mail)", () => {
		expect(labelsFor("x@sendgrid.net")).toEqual([]);
	});

	it("independent institutional TLDs — gov and mil", () => {
		expect(labelsFor("noreply@irs.gov")).toEqual(["gov"]);
		expect(labelsFor("soldier@navy.mil")).toEqual(["mil"]);
	});

	it("personal senders get no label", () => {
		expect(labelsFor("a@gmail.com")).toEqual([]);
		expect(labelsFor("friend@outlook.com")).toEqual([]);
	});

	it("is case-insensitive on the address", () => {
		expect(labelsFor("Prof@CS.UW.EDU")).toEqual(["edu", "uw", "cs"]);
	});
});

describe("compileHighConfidenceSieve — Sieve emission", () => {
	it("declares imap4flags + variables and stays addflag-only (never hides a message)", () => {
		const { script } = compileHighConfidenceSieve();
		expect(script).toContain('require ["imap4flags", "variables"];');
		const code = script
			.split("\n")
			.filter((l) => !l.trim().startsWith("#"))
			.join("\n")
			.toLowerCase();
		for (const verb of ["fileinto", "discard", "reject", "redirect"]) expect(code).not.toContain(verb);
	});

	it("emits the hierarchical education cascade with the ${1} department capture", () => {
		const { script } = compileHighConfidenceSieve();
		expect(script).toContain('addflag ["edu", "uw", "${1}"];');
		expect(script).toContain('elsif address :domain :matches "from"');
	});

	it("emits a brand group as an anyof(:is apex, :matches *.apex) block", () => {
		const { script } = compileHighConfidenceSieve();
		expect(script).toContain('address :domain :is "from"');
		expect(script).toContain('address :domain :matches "from"');
		expect(script).toContain('addflag "finance";');
		expect(script).toContain("chase.com");
	});

	it("narrows to the requested categories, omitting the rest", () => {
		const { script, categories } = compileHighConfidenceSieve(["finance"]);
		expect(categories).toEqual(["finance"]);
		expect(script).toContain('addflag "finance";');
		expect(script).not.toContain('addflag "shopping";');
		expect(script).not.toContain('addflag ["edu", "uw", "${1}"];');
	});

	it("throws on an unknown category rather than silently emitting a partial script", () => {
		expect(() => compileHighConfidenceSieve(["bogus"])).toThrow(/unknown domain categor/i);
	});

	it("exposes every selectable category (education + gov/mil + brand groups)", () => {
		expect(ALL_DOMAIN_CATEGORIES).toContain("education");
		expect(ALL_DOMAIN_CATEGORIES).toContain("gov");
		expect(ALL_DOMAIN_CATEGORIES).toContain("mil");
		expect(ALL_DOMAIN_CATEGORIES).toContain("finance");
	});
});
