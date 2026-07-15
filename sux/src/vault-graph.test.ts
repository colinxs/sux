import { describe, expect, it } from "vitest";
import { evalFilter, extractTags, extractWikilinks, frontmatterMatches, linkResolvesTo, noteBasename, parseFrontmatter, patchBlockRef, patchFrontmatter, patchHeadingSection } from "./vault-graph";

describe("vault-graph pure layer (§4)", () => {
	it("extractWikilinks strips alias/heading/block refs", () => {
		expect(extractWikilinks("see [[Note A]] and [[Folder/Note B|alias]] and [[Note C#head]] and [[Note D^blk]]")).toEqual(["Note A", "Folder/Note B", "Note C", "Note D"]);
		expect(extractWikilinks("no links here")).toEqual([]);
	});

	it("linkResolvesTo matches by basename or full path (Obsidian semantics)", () => {
		expect(linkResolvesTo("sux", "Projects/sux.md")).toBe(true); // basename
		expect(linkResolvesTo("Projects/sux", "Projects/sux.md")).toBe(true); // full path
		expect(linkResolvesTo("SUX", "Projects/sux.md")).toBe(true); // case-insensitive
		expect(linkResolvesTo("other", "Projects/sux.md")).toBe(false);
	});

	it("noteBasename drops folders + extension", () => {
		expect(noteBasename("a/b/Note.md")).toBe("note");
	});

	it("parseFrontmatter handles k:v, inline arrays, and block lists", () => {
		const fm = parseFrontmatter(["---", "title: Hello", "status: active", "tags: [a, b]", "aliases:", "  - one", "  - two", "---", "body"].join("\n"));
		expect(fm).toMatchObject({ title: "Hello", status: "active", tags: ["a", "b"], aliases: ["one", "two"] });
	});

	it("parseFrontmatter returns {} when there is no frontmatter block", () => {
		expect(parseFrontmatter("# just a heading\ntext")).toEqual({});
	});

	it("extractTags unions frontmatter tags with inline #tags, excluding code", () => {
		const content = ["---", "tags: [project, urgent]", "---", "Work on #sux and #vault/graph.", "```", "#not-a-tag-in-code", "```", "`#also-not`"].join("\n");
		const tags = extractTags(content, parseFrontmatter(content));
		expect(tags).toContain("project");
		expect(tags).toContain("urgent");
		expect(tags).toContain("sux");
		expect(tags).toContain("vault/graph");
		expect(tags).not.toContain("not-a-tag-in-code");
		expect(tags).not.toContain("also-not");
	});

	it("frontmatterMatches: equality, array-membership, presence", () => {
		const fm = { status: "active", tags: ["a", "b"] };
		expect(frontmatterMatches(fm, "status", "active")).toBe(true);
		expect(frontmatterMatches(fm, "status", "done")).toBe(false);
		expect(frontmatterMatches(fm, "tags", "b")).toBe(true); // array membership
		expect(frontmatterMatches(fm, "status")).toBe(true); // presence, no value
		expect(frontmatterMatches(fm, "missing")).toBe(false);
	});

	it("evalFilter: and/or/not + comparisons + membership (JsonLogic-lite, §obsidian)", () => {
		const fm = { type: "project", status: "active", priority: 3, tags: ["a", "b"] };
		expect(evalFilter(fm, { "==": ["type", "project"] })).toBe(true);
		expect(evalFilter(fm, { "!=": ["status", "done"] })).toBe(true);
		expect(evalFilter(fm, { ">": ["priority", 2] })).toBe(true);
		expect(evalFilter(fm, { "<=": ["priority", 3] })).toBe(true);
		expect(evalFilter(fm, { in: ["tags", "b"] })).toBe(true);
		expect(evalFilter(fm, { and: [{ "==": ["type", "project"] }, { "==": ["status", "active"] }] })).toBe(true);
		expect(evalFilter(fm, { or: [{ "==": ["type", "note"] }, { "==": ["status", "active"] }] })).toBe(true);
		expect(evalFilter(fm, { not: { "==": ["status", "active"] } })).toBe(false);
		expect(evalFilter({}, { ">": ["priority", 2] })).toBe(false); // absent field never matches an ordered compare
		expect(() => evalFilter(fm, { bogus: [] } as any)).toThrow(/unknown filter operator/);
		expect(() => evalFilter(fm, { "==": ["a", 1], "!=": ["b", 2] } as any)).toThrow(/exactly one operator/);
	});

	it("patchFrontmatter sets/replaces a key, idempotently, creating the block if absent", () => {
		const r1 = patchFrontmatter("# Note\nbody", "status", "active");
		expect(r1.changed).toBe(true);
		expect(r1.content).toMatch(/^---\nstatus: active\n---/);
		const r2 = patchFrontmatter("---\nstatus: draft\n---\nbody", "status", "active");
		expect(r2.content).toContain("status: active");
		expect(patchFrontmatter(r2.content, "status", "active").changed).toBe(false); // idempotent
	});

	it("patchFrontmatter leaves plain scalars unquoted (no regression)", () => {
		const r = patchFrontmatter("# Note\nbody", "title", "Hello World");
		expect(r.content).toContain("title: Hello World");
		expect(r.content).not.toContain('"Hello World"');
	});

	it("patchFrontmatter quotes a value with an embedded newline, so it can't fence-inject (#412)", () => {
		const evil = "foo\n---\nbar";
		const r = patchFrontmatter("# Note\nbody", "note", evil);
		// the embedded '---' must be escaped inside the quoted scalar, not left as a bare line
		expect(r.content).toContain(String.raw`"foo\n---\nbar"`);
		const fenceLines = r.content.split("\n").filter((l) => l === "---");
		expect(fenceLines).toHaveLength(2); // exactly the real open/close fence — no injected third fence
		expect(r.content).toContain("\n\n# Note\nbody"); // original body untouched, not swallowed as pseudo-frontmatter
		const fm = parseFrontmatter(r.content);
		expect(fm.note).toBe(String.raw`foo\n---\nbar`); // recovered from inside the fence, not split across it
	});

	it("patchFrontmatter preserves literal `$`-sequences in a value (no String.replace expansion)", () => {
		// content.replace(FENCE, rebuilt) with a STRING replacement interprets `$$`, `$&`,
		// `` $` ``, `$'`, and `$1` — and FENCE has a capture group, so a value with `$1`
		// would splice the whole OLD frontmatter block into the note. Assert every form
		// survives verbatim through a round-trip.
		const doc = "---\nstatus: draft\n---\nbody";
		// `a$$b`→`a$b` under `$$`; `v$1x`/`cost $1000` splice the old block via the `$1`
		// capture. All stay bare scalars, so the literal `price: <val>` line must survive.
		for (const val of ["a$$b", "v$1x", "cost $1000"]) {
			const r = patchFrontmatter(doc, "price", val);
			expect(parseFrontmatter(r.content).price).toBe(val);
			expect(r.content).toContain(`price: ${val}`);
		}
	});

	it("patchHeadingSection replace/append; ambiguous or missing heading throws", () => {
		const doc = "# A\nold\n\n# B\nkeep";
		expect(patchHeadingSection(doc, "A", "replace", "new").content).toBe("# A\nnew\n\n# B\nkeep");
		expect(patchHeadingSection(doc, "A", "append", "more").content).toContain("old\nmore");
		expect(() => patchHeadingSection(doc, "Missing", "replace", "x")).toThrow(/not found/);
		expect(() => patchHeadingSection("# A\n1\n# A\n2", "A", "replace", "x")).toThrow(/unique|matches/);
	});

	it("patchBlockRef replace keeps the anchor; unknown ref throws", () => {
		const r = patchBlockRef("line one ^id1\nline two", "id1", "replace", "rewritten");
		expect(r.content).toBe("rewritten ^id1\nline two");
		expect(() => patchBlockRef("no anchor here", "id1", "replace", "x")).toThrow(/not found/);
	});

});
