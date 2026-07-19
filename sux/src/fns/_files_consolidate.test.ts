import { describe, expect, it } from "vitest";
import { findDuplicateFiles, hasFilesConsolidate } from "./_files_consolidate";
import type { FilesSemanticChunk } from "./_files_semantic";

describe("hasFilesConsolidate", () => {
	it("is off when unset", () => {
		expect(hasFilesConsolidate({} as any)).toBe(false);
	});

	it("is off for an explicit falsy value", () => {
		expect(hasFilesConsolidate({ FILES_CONSOLIDATE_ENABLED: "0" } as any)).toBe(false);
		expect(hasFilesConsolidate({ FILES_CONSOLIDATE_ENABLED: "false" } as any)).toBe(false);
	});

	it("is on for any other truthy value", () => {
		expect(hasFilesConsolidate({ FILES_CONSOLIDATE_ENABLED: "1" } as any)).toBe(true);
	});
});

const chunk = (path: string, embedding: number[]): FilesSemanticChunk => ({ path, text: "x", embedding });

describe("findDuplicateFiles", () => {
	it("clusters two files whose (single-chunk) embeddings are near-identical", () => {
		const chunks = [chunk("/a.txt", [1, 0, 0]), chunk("/b.txt", [0.999, 0.001, 0])];
		const clusters = findDuplicateFiles(chunks, 0.99);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].paths)).toEqual(new Set(["/a.txt", "/b.txt"]));
	});

	it("does not cluster dissimilar files", () => {
		const chunks = [chunk("/a.txt", [1, 0, 0]), chunk("/b.txt", [0, 1, 0])];
		expect(findDuplicateFiles(chunks, 0.9)).toEqual([]);
	});

	it("aggregates a multi-chunk file's chunks into one mean vector before comparing", () => {
		const chunks = [chunk("/a.txt", [1, 0, 0]), chunk("/a.txt", [0, 1, 0]), chunk("/b.txt", [0.5, 0.5, 0])];
		const clusters = findDuplicateFiles(chunks, 0.99);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].paths)).toEqual(new Set(["/a.txt", "/b.txt"]));
	});

	it("skips chunks with no embedding", () => {
		const chunks = [chunk("/a.txt", []), chunk("/b.txt", [1, 0, 0])];
		expect(findDuplicateFiles(chunks, 0.9)).toEqual([]);
	});

	it("groups 3+ near-identical files into a single cluster, not pairwise clusters", () => {
		const chunks = [chunk("/a.txt", [1, 0, 0]), chunk("/b.txt", [1, 0, 0]), chunk("/c.txt", [1, 0, 0])];
		const clusters = findDuplicateFiles(chunks, 0.99);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].paths)).toEqual(new Set(["/a.txt", "/b.txt", "/c.txt"]));
	});

	it("returns no clusters for an empty chunk list", () => {
		expect(findDuplicateFiles([])).toEqual([]);
	});
});
