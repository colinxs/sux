import { describe, expect, it } from "vitest";
import { mail_sieve_hc } from "./mail_sieve_hc";
import { ALL_DOMAIN_CATEGORIES } from "./_domain_labels";

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("mail_sieve_hc (front verb)", () => {
	it("with no categories, compiles all of them and never touches JMAP (cacheable, text-only)", async () => {
		const r = await mail_sieve_hc.run({} as any, {});
		expect(r.isError).toBeUndefined();
		const out = parse(r);
		expect(out.categories.sort()).toEqual([...ALL_DOMAIN_CATEGORIES].sort());
		expect(out.script).toContain('require ["imap4flags"];');
		expect(out.rule_count).toBeGreaterThan(0);
		expect(out.note).toMatch(/paste/i);
	});

	it("narrows to the requested categories only", async () => {
		const r = await mail_sieve_hc.run({} as any, { categories: ["gov", "mil"] });
		const out = parse(r);
		expect(out.categories).toEqual(["gov", "mil"]);
		expect(out.script).toContain('addflag "gov"');
		expect(out.script).toContain('addflag "mil"');
		expect(out.script).not.toContain('addflag "finance"');
		expect(out.script).not.toMatch(/UW department subdomains/); // education cascade excluded
	});

	it("the education category compiles the hierarchical UW cascade, not just a flat 'edu' flag", async () => {
		const r = await mail_sieve_hc.run({} as any, { categories: ["education"] });
		const out = parse(r);
		expect(out.categories).toEqual(["education"]);
		expect(out.script).toMatch(/UW department subdomains/);
		// #1417 defect 1: the dept tier is explicit per-department blocks, NOT a `${1}` wildcard capture
		// (which tagged u.washington.edu as a "u" department on 158 of the newest 2000 real messages).
		expect(out.script).toContain('addflag ["edu", "uw", "cs"]');
		expect(out.script).not.toContain("${1}");
	});

	it("a brand group (finance) tags apex + wildcard subdomains under one label", async () => {
		const r = await mail_sieve_hc.run({} as any, { categories: ["finance"] });
		const out = parse(r);
		expect(out.brand_domains).toBeGreaterThan(0);
		expect(out.script).toContain('addflag "finance"');
	});

	it("rejects an unknown category as a bad_input-style failure, without a partial script", async () => {
		const r = await mail_sieve_hc.run({} as any, { categories: ["not-a-real-category"] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/unknown domain category/);
		expect(r.content[0].text).toMatch(/not-a-real-category/);
	});

	it("coerces non-array/non-string categories to undefined (falls back to all)", async () => {
		const r = await mail_sieve_hc.run({} as any, { categories: "finance" } as any);
		const out = parse(r);
		expect(out.categories.sort()).toEqual([...ALL_DOMAIN_CATEGORIES].sort());
	});
});
