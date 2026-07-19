import { describe, expect, it } from "vitest";
import { compactFileDuplicatePlan, proposeFileDuplicate } from "./_files_consolidate_plan";

describe("proposeFileDuplicate", () => {
	it("picks the lexicographically-first path as canonical regardless of input order", () => {
		const item = proposeFileDuplicate({ paths: ["/b.txt", "/a.txt"] });
		expect(item?.keep).toBe("/a.txt");
		expect(item?.archives).toEqual(["/b.txt"]);
	});

	it("proposes each archive's move into a parallel /Archive/Duplicates tree, preserving its own path", () => {
		const item = proposeFileDuplicate({ paths: ["/Notes/a.txt", "/Downloads/b.txt"] });
		expect(item?.moves).toEqual([{ from: "/Notes/a.txt", to: "/Archive/Duplicates/Notes/a.txt" }]);
	});

	it("composes a 3+ file group into ONE cluster with a single keep and every other member as an archive", () => {
		const item = proposeFileDuplicate({ paths: ["/c.txt", "/a.txt", "/b.txt"] });
		expect(item?.keep).toBe("/a.txt");
		expect(item?.archives.sort()).toEqual(["/b.txt", "/c.txt"]);
		expect(item?.moves.sort((a, b) => a.from.localeCompare(b.from))).toEqual([
			{ from: "/b.txt", to: "/Archive/Duplicates/b.txt" },
			{ from: "/c.txt", to: "/Archive/Duplicates/c.txt" },
		]);
	});

	it("returns null for a cluster with fewer than 2 paths", () => {
		expect(proposeFileDuplicate({ paths: ["/a.txt"] })).toBeNull();
	});

	it("returns null for an empty/malformed cluster", () => {
		expect(proposeFileDuplicate({ paths: [] })).toBeNull();
		expect(proposeFileDuplicate({} as any)).toBeNull();
	});
});

describe("compactFileDuplicatePlan", () => {
	it("drops nulls and keeps order", () => {
		const a = { keep: "/a.txt", archives: ["/b.txt"], moves: [{ from: "/b.txt", to: "/Archive/Duplicates/b.txt" }] };
		expect(compactFileDuplicatePlan([a, null, null])).toEqual([a]);
	});

	it("returns an empty array for an all-null batch", () => {
		expect(compactFileDuplicatePlan([null, null])).toEqual([]);
	});
});
