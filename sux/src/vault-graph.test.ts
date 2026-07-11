import { describe, expect, it } from "vitest";
import { evalFilter, frontmatterMatches, parseFrontmatter, patchBlockRef, patchFrontmatter, patchHeadingSection } from "./vault-graph";

describe("parseFrontmatter", () => {
	it("parses scalars, inline arrays, block arrays, and typed values", () => {
		const { fm, body } = parseFrontmatter(
			["---", "type: project", "status: active", "year: 2017", "done: false", "tags: [a, b, c]", "aliases:", "  - one", "  - two", 'title: "A: colon"', "---", "", "# Body"].join("\n"),
		);
		expect(fm).toMatchObject({ type: "project", status: "active", year: 2017, done: false, tags: ["a", "b", "c"], aliases: ["one", "two"], title: "A: colon" });
		expect(body).toBe("\n# Body");
	});

	it("keeps dates and versions as strings, not numbers", () => {
		const { fm } = parseFrontmatter(["---", "added: 2026-07-09", "v: 1.2.3", "---", ""].join("\n"));
		expect(fm.added).toBe("2026-07-09");
		expect(fm.v).toBe("1.2.3");
	});

	it("no fence → empty fm, whole content as body", () => {
		const { fm, body } = parseFrontmatter("# Just a note\ntext");
		expect(fm).toEqual({});
		expect(body).toBe("# Just a note\ntext");
	});
});

describe("frontmatterMatches (simple form)", () => {
	const fm = { type: "project", tags: ["nlp", "ml"], year: 2017 };
	it("presence when value omitted", () => {
		expect(frontmatterMatches(fm, "type")).toBe(true);
		expect(frontmatterMatches(fm, "missing")).toBe(false);
	});
	it("equality (string-coerced) on a scalar field", () => {
		expect(frontmatterMatches(fm, "type", "project")).toBe(true);
		expect(frontmatterMatches(fm, "year", "2017")).toBe(true);
		expect(frontmatterMatches(fm, "type", "note")).toBe(false);
	});
	it("membership on an array field", () => {
		expect(frontmatterMatches(fm, "tags", "nlp")).toBe(true);
		expect(frontmatterMatches(fm, "tags", "cv")).toBe(false);
	});
});

describe("evalFilter (JsonLogic-lite)", () => {
	const fm = { type: "project", status: "active", year: 2020, tags: ["nlp", "ml"], added: "2026-07-09" };

	it("== / != with the missing-field rule", () => {
		expect(evalFilter(fm, { "==": ["type", "project"] })).toBe(true);
		expect(evalFilter(fm, { "==": ["type", "note"] })).toBe(false);
		expect(evalFilter(fm, { "!=": ["status", "done"] })).toBe(true);
		expect(evalFilter(fm, { "==": ["missing", "x"] })).toBe(false);
		expect(evalFilter(fm, { "!=": ["missing", "x"] })).toBe(true); // absent field is not equal to anything
	});

	it("numeric comparators", () => {
		expect(evalFilter(fm, { ">": ["year", 2019] })).toBe(true);
		expect(evalFilter(fm, { ">=": ["year", 2020] })).toBe(true);
		expect(evalFilter(fm, { "<": ["year", 2020] })).toBe(false);
		expect(evalFilter(fm, { "<=": ["year", 2020] })).toBe(true);
	});

	it("ordered comparators on a date string sort lexically (ISO = chronological)", () => {
		expect(evalFilter(fm, { ">": ["added", "2026-01-01"] })).toBe(true);
		expect(evalFilter(fm, { "<": ["added", "2026-01-01"] })).toBe(false);
	});

	it("ordered comparator on an absent field never matches", () => {
		expect(evalFilter(fm, { ">": ["missing", 0] })).toBe(false);
		expect(evalFilter(fm, { "<=": ["missing", 999999] })).toBe(false);
	});

	it("in → array membership", () => {
		expect(evalFilter(fm, { in: ["tags", "nlp"] })).toBe(true);
		expect(evalFilter(fm, { in: ["tags", "cv"] })).toBe(false);
	});

	it("nested and/or/not", () => {
		const f = { and: [{ "==": ["type", "project"] }, { or: [{ "==": ["status", "active"] }, { "==": ["status", "paused"] }] }, { not: { in: ["tags", "archived"] } }] };
		expect(evalFilter(fm, f)).toBe(true);
		expect(evalFilter({ ...fm, status: "done" }, f)).toBe(false);
	});

	it("throws on a malformed node", () => {
		expect(() => evalFilter(fm, {} as any)).toThrow(/exactly one operator/);
		expect(() => evalFilter(fm, { "==": ["type"] } as any)).toThrow(/\[field, value\]/);
		expect(() => evalFilter(fm, { bogus: [] } as any)).toThrow(/unknown filter operator/);
		expect(() => evalFilter(fm, [] as any)).toThrow(/JsonLogic object/);
	});
});

describe("patchFrontmatter", () => {
	const note = ["---", "type: project", "status: active", "---", "", "# Body", "status: not-this-one"].join("\n");

	it("replaces an existing key only inside the fence, not the body", () => {
		const { content, changed } = patchFrontmatter(note, "status", "done");
		expect(changed).toBe(true);
		expect(content).toContain("status: done");
		expect(content).toContain("status: not-this-one"); // body line untouched
		expect(parseFrontmatter(content).fm.status).toBe("done");
	});

	it("adds a missing key before the closing fence", () => {
		const { content } = patchFrontmatter(note, "priority", 1);
		expect(parseFrontmatter(content).fm.priority).toBe(1);
		expect(parseFrontmatter(content).fm.type).toBe("project");
	});

	it("creates a fence when the note has none", () => {
		const { content, changed } = patchFrontmatter("# Bare note\n", "type", "note");
		expect(changed).toBe(true);
		expect(content.startsWith("---\ntype: note\n---\n")).toBe(true);
		expect(parseFrontmatter(content).fm.type).toBe("note");
	});

	it("is idempotent — setting the same value twice changes nothing the second time", () => {
		const once = patchFrontmatter(note, "status", "done");
		const twice = patchFrontmatter(once.content, "status", "done");
		expect(twice.changed).toBe(false);
		expect(twice.content).toBe(once.content);
	});

	it("serializes arrays and quotes only when needed", () => {
		const { content } = patchFrontmatter(note, "tags", ["a", "b"]);
		expect(content).toContain("tags: [a, b]");
		const q = patchFrontmatter(note, "title", "A: colon");
		expect(q.content).toContain('title: "A: colon"');
	});
});

describe("patchHeadingSection", () => {
	const note = ["# Top", "intro", "", "## Tasks", "- [ ] a", "- [ ] b", "", "## Notes", "note text", "", "### Sub of notes", "deep"].join("\n");

	it("replaces a section body up to the next same-or-higher heading", () => {
		const { content, changed } = patchHeadingSection(note, "Tasks", "replace", "- [x] done");
		expect(changed).toBe(true);
		expect(content).toContain("## Tasks\n- [x] done");
		expect(content).not.toContain("- [ ] a");
		expect(content).toContain("## Notes"); // boundary preserved
	});

	it("append adds to the end of the section, before the boundary", () => {
		const { content } = patchHeadingSection(note, "Tasks", "append", "- [ ] c");
		const tasks = content.slice(content.indexOf("## Tasks"), content.indexOf("## Notes"));
		expect(tasks).toContain("- [ ] b\n- [ ] c");
	});

	it("prepend inserts right after the heading line", () => {
		const { content } = patchHeadingSection(note, "Tasks", "prepend", "- [ ] first");
		expect(content).toContain("## Tasks\n- [ ] first\n- [ ] a");
	});

	it("a deeper heading does NOT end a higher section (level-aware boundary)", () => {
		const { content } = patchHeadingSection(note, "Notes", "append", "MORE");
		const notes = content.slice(content.indexOf("## Notes"));
		expect(notes).toContain("### Sub of notes"); // the h3 stayed inside the h2 section
		expect(notes).toContain("MORE");
	});

	it("throws on a missing or ambiguous heading", () => {
		expect(() => patchHeadingSection(note, "Nope", "replace", "x")).toThrow(/not found/);
		const dup = ["## Tasks", "a", "## Tasks", "b"].join("\n");
		expect(() => patchHeadingSection(dup, "Tasks", "replace", "x")).toThrow(/matches 2 times/);
	});
});

describe("patchBlockRef", () => {
	const note = ["- [ ] draft the memo ^t-ab12", "some para", "", "final line ^end"].join("\n");

	it("replace rewrites the anchored line but keeps the anchor", () => {
		const { content, changed } = patchBlockRef(note, "t-ab12", "replace", "- [x] draft the memo ✅");
		expect(changed).toBe(true);
		expect(content).toContain("- [x] draft the memo ✅ ^t-ab12");
		expect(content).not.toContain("- [ ] draft the memo");
	});

	it("accepts the id with a leading caret", () => {
		const { content } = patchBlockRef(note, "^end", "append", "appended");
		expect(content).toContain("final line ^end\nappended");
	});

	it("prepend inserts a line before the anchored line", () => {
		const { content } = patchBlockRef(note, "t-ab12", "prepend", "PRE");
		expect(content).toContain("PRE\n- [ ] draft the memo ^t-ab12");
	});

	it("throws on missing or ambiguous block ids", () => {
		expect(() => patchBlockRef(note, "nope", "replace", "x")).toThrow(/not found/);
		const dup = ["a ^dup", "b ^dup"].join("\n");
		expect(() => patchBlockRef(dup, "dup", "replace", "x")).toThrow(/must be unique/);
	});
});
