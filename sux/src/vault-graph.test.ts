import { describe, expect, it } from "vitest";
import { extractTags, extractWikilinks, frontmatterMatches, linkResolvesTo, noteBasename, parseFrontmatter } from "./vault-graph";

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
});
