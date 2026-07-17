import { describe, expect, it } from "vitest";
import { MemoryStore, type Caps } from "@suxos/lib";
import { compactMergePlan, proposeMerge } from "./_vault_consolidate_plan";

const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;

describe("proposeMerge", () => {
	it("picks the lexicographically-first path as canonical regardless of a/b order", async () => {
		const item = await proposeMerge({ a: "Archive/Project Alpha (2).md", aContent: "alpha body", b: "Projects/project-alpha.md", bContent: "alpha body plus more", key: "project alpha" }, caps);
		expect(item?.keep).toBe("Archive/Project Alpha (2).md" < "Projects/project-alpha.md" ? "Archive/Project Alpha (2).md" : "Projects/project-alpha.md");
		expect(item?.archive).not.toBe(item?.keep);
	});

	it("agrees on keep/archive no matter which side of the cluster a/b land on", async () => {
		const forward = await proposeMerge({ a: "A.md", aContent: "x", b: "B.md", bContent: "y", key: "k" }, caps);
		const backward = await proposeMerge({ a: "B.md", aContent: "y", b: "A.md", bContent: "x", key: "k" }, caps);
		expect(forward?.keep).toBe("A.md");
		expect(forward?.archive).toBe("B.md");
		expect(backward?.keep).toBe(forward?.keep);
		expect(backward?.archive).toBe(forward?.archive);
	});

	it("faithful-unions both notes' content into mergedContent, deduping identical bodies", async () => {
		const item = await proposeMerge({ a: "A.md", aContent: "same body", b: "B.md", bContent: "same body", key: "k" }, caps);
		// faithful-union collapses identical content blocks to one copy, tagged with its source handle.
		expect(item?.mergedContent).toContain("same body");
		expect(item?.mergedContent?.match(/same body/g)).toHaveLength(1);
	});

	it("returns null for a malformed cluster (missing content)", async () => {
		expect(await proposeMerge({ a: "A.md", aContent: "", b: "B.md", bContent: "y", key: "k" }, caps)).toBeNull();
	});
});

describe("compactMergePlan", () => {
	it("drops nulls and keeps order", () => {
		const a = { keep: "A.md", archive: "B.md", mergedContent: "x", key: "k" };
		expect(compactMergePlan([a, null, null])).toEqual([a]);
	});

	it("returns an empty array for an all-null batch", () => {
		expect(compactMergePlan([null, null])).toEqual([]);
	});
});
