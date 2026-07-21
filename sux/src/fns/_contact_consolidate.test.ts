import { describe, expect, it } from "vitest";
import { findDuplicateContacts, hasContactConsolidate, normPhone, type ContactRef } from "./_contact_consolidate";

describe("hasContactConsolidate", () => {
	it("is off by default and on common falsy strings", () => {
		expect(hasContactConsolidate({} as any)).toBe(false);
		expect(hasContactConsolidate({ CONTACT_CONSOLIDATE_ENABLED: "0" } as any)).toBe(false);
		expect(hasContactConsolidate({ CONTACT_CONSOLIDATE_ENABLED: "false" } as any)).toBe(false);
		expect(hasContactConsolidate({ CONTACT_CONSOLIDATE_ENABLED: "off" } as any)).toBe(false);
	});

	it("is on for any other truthy value", () => {
		expect(hasContactConsolidate({ CONTACT_CONSOLIDATE_ENABLED: "1" } as any)).toBe(true);
		expect(hasContactConsolidate({ CONTACT_CONSOLIDATE_ENABLED: "true" } as any)).toBe(true);
	});
});

describe("findDuplicateContacts", () => {
	it("groups two contacts sharing an email into one cluster", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Ada Lovelace", emails: ["ada@example.com"] },
			{ id: "2", name: "Ada L", emails: ["ADA@Example.com"] },
			{ id: "3", name: "Bob Smith", emails: ["bob@example.com"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("groups two contacts sharing a phone number regardless of formatting", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Carol", phones: ["+1 (555) 123-4567"] },
			{ id: "2", name: "Carol J", phones: ["555-123-4567"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("fuzzy-matches a full name against an initial ('Colin Powell' vs 'C. Powell')", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Colin Powell" },
			{ id: "2", name: "C. Powell" },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("matches a parenthetical-tagged duplicate ('Colin Powell' vs 'Colin Powell (work)')", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Colin Powell" },
			{ id: "2", name: "Colin Powell (work)" },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("does not match two different people with the same last name only", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Colin Powell" },
			{ id: "2", name: "Jamie Powell" },
		];
		expect(findDuplicateContacts(contacts)).toEqual([]);
	});

	it("transitively unions a 3+ contact chain via different signals into ONE cluster", () => {
		// 1<->2 share an email, 2<->3 share a phone — all three collapse into one group.
		const contacts: ContactRef[] = [
			{ id: "1", name: "Dana West", emails: ["dana@example.com"] },
			{ id: "2", name: "D. West", emails: ["dana@example.com"], phones: ["555-000-1111"] },
			{ id: "3", name: "Dana W", phones: ["555-000-1111"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2", "3"]));
	});

	it("drops singleton groups — nothing else in the page matched", () => {
		const contacts: ContactRef[] = [{ id: "1", name: "Solo Person", emails: ["solo@example.com"] }];
		expect(findDuplicateContacts(contacts)).toEqual([]);
	});

	it("ignores a too-short phone number as too weak a signal", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "A", phones: ["123"] },
			{ id: "2", name: "B", phones: ["123"] },
		];
		expect(findDuplicateContacts(contacts)).toEqual([]);
	});

	it("strips a trailing extension so it clusters with the bare number (#1013)", () => {
		expect(normPhone("555-123-4567 ext 22")).toBe("5551234567");
		expect(normPhone("555-123-4567 x22")).toBe("5551234567");
		const contacts: ContactRef[] = [
			{ id: "1", name: "Carol", phones: ["555-123-4567 ext 22"] },
			{ id: "2", name: "Carol J", phones: ["555-123-4567"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("strips a colon-separated trailing extension so it clusters with the bare number (#1032)", () => {
		expect(normPhone("555-123-4567 Ext: 22")).toBe("5551234567");
		expect(normPhone("555-123-4567 ext. 22")).toBe("5551234567");
		const contacts: ContactRef[] = [
			{ id: "1", name: "Dana", phones: ["555-123-4567 Ext: 22"] },
			{ id: "2", name: "Dana K", phones: ["555-123-4567"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("strips a parenthesized trailing extension so it clusters with the bare number (#1039)", () => {
		expect(normPhone("555-123-4567 (ext 22)")).toBe("5551234567");
		const contacts: ContactRef[] = [
			{ id: "1", name: "Eve", phones: ["555-123-4567 (ext 22)"] },
			{ id: "2", name: "Eve R", phones: ["555-123-4567"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("does not cluster two different people sharing only a bare 7-digit number across area codes (#1013)", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Erin Adams", phones: ["555-1234"] },
			{ id: "2", name: "Frank Baker", phones: ["555-1234"] },
		];
		expect(findDuplicateContacts(contacts)).toEqual([]);
	});

	it("still clusters a bare 7-digit number when the names also corroborate the match (#1013)", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Erin Adams", phones: ["555-1234"] },
			{ id: "2", name: "E. Adams", phones: ["555-1234"] },
		];
		const clusters = findDuplicateContacts(contacts);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].ids)).toEqual(new Set(["1", "2"]));
	});

	it("returns an empty array for an empty page", () => {
		expect(findDuplicateContacts([])).toEqual([]);
	});

	it("excludes an already-merged archive from re-clustering (#989)", () => {
		const contacts: ContactRef[] = [
			{ id: "1", name: "Ada Lovelace", emails: ["ada@example.com"] },
			{ id: "2", name: "Ada Lovelace (merged into 1)", emails: ["ada@example.com"] },
			{ id: "3", name: "Bob Smith", emails: ["bob@example.com"] },
		];
		expect(findDuplicateContacts(contacts)).toEqual([]);
	});
});
