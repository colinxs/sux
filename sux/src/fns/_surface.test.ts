import { describe, expect, it } from "vitest";
import { DOMAINS, domainKeys, firstSentence, renderDomain } from "./_surface";
import { FUNCTIONS } from "./index";

describe("_surface firstSentence", () => {
	it("takes the first sentence and trims", () => {
		expect(firstSentence("Search the web. Then do more.")).toBe("Search the web");
	});

	it("does not truncate at an abbreviation like e.g. or i.e.", () => {
		// The `. ` inside "e.g. " must not be treated as a sentence boundary.
		expect(firstSentence("Convert formats, e.g. markdown and html, at the edge. Second sentence.")).toBe(
			"Convert formats, e.g. markdown and html, at the edge",
		);
		expect(firstSentence("Redact PII, i.e. names and emails, before storing. And more.")).toBe(
			"Redact PII, i.e. names and emails, before storing",
		);
	});

	it("caps overlong first sentences with an ellipsis", () => {
		const long = `${"x".repeat(200)}. next.`;
		const out = firstSentence(long);
		expect(out.length).toBe(140);
		expect(out.endsWith("…")).toBe(true);
	});
});

// A leaf reachable only through the overview's "other" bucket has no discovery path at
// all: "other" is not a domain key, so sux({domain:"other"}) errors (#1479 — `put`/`get`
// were undiscoverable, and a prior session wrongly concluded the capability didn't exist).
describe("_surface domain placement", () => {
	it("puts the store's download verbs in a real, zoomable domain", () => {
		const covered = new Set(DOMAINS.flatMap((d) => d.leaves));
		for (const name of ["put", "get"]) expect(covered.has(name)).toBe(true);
		const storage = renderDomain(FUNCTIONS, "storage") ?? "";
		expect(storage).toContain("`put`");
		expect(storage).toContain("`get`");
	});

	it("never lists a leaf under a domain key sux() cannot zoom into", () => {
		const keys = new Set(domainKeys());
		expect(keys.has("other")).toBe(false);
		for (const d of DOMAINS) expect(keys.has(d.key)).toBe(true);
	});

	it("only names leaves that are actually registered", () => {
		const registered = new Set(FUNCTIONS.map((f) => f.name));
		const namespaceVerbs = new Set(["vault", "mail", "files", "calendar", "contact"]);
		const missing = DOMAINS.flatMap((d) => d.leaves).filter((n) => !registered.has(n) && !namespaceVerbs.has(n));
		expect(missing).toEqual([]);
	});
});
