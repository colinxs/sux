import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./_dropbox-full", () => ({ listFullChanges: vi.fn() }));

import { listFullChanges } from "./_dropbox-full";
import { collectBinaryCandidates, findBinaryDuplicateFiles } from "./_files_binary_dup";

const listChanges = listFullChanges as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

describe("collectBinaryCandidates", () => {
	it("keeps non-textual files with a content_hash, skips folders/textual-ext/zero-byte/hashless entries", async () => {
		listChanges.mockResolvedValue({
			entries: [
				{ kind: "file", path: "/a.png", size: 100, content_hash: "h1" },
				{ kind: "folder", path: "/dir", size: 0, content_hash: "h2" },
				{ kind: "file", path: "/notes.md", size: 100, content_hash: "h3" }, // textual — files_semantic's turf
				{ kind: "file", path: "/empty.pdf", size: 0, content_hash: "h4" },
				{ kind: "file", path: "/nohash.jpg", size: 100, content_hash: undefined },
			],
			has_more: false,
			cursor: "c1",
		});
		const { files, truncated } = await collectBinaryCandidates({} as any);
		expect(files).toEqual([{ path: "/a.png", content_hash: "h1" }]);
		expect(truncated).toBe(false);
	});

	it("pages through list_folder/continue until has_more is false", async () => {
		listChanges
			.mockResolvedValueOnce({ entries: [{ kind: "file", path: "/a.png", size: 1, content_hash: "h1" }], has_more: true, cursor: "c1" })
			.mockResolvedValueOnce({ entries: [{ kind: "file", path: "/b.png", size: 1, content_hash: "h1" }], has_more: false, cursor: "c2" });
		const { files, truncated } = await collectBinaryCandidates({} as any);
		expect(files.map((f) => f.path)).toEqual(["/a.png", "/b.png"]);
		expect(truncated).toBe(false);
		expect(listChanges).toHaveBeenCalledTimes(2);
	});
});

describe("findBinaryDuplicateFiles", () => {
	it("clusters files sharing a content_hash", () => {
		const clusters = findBinaryDuplicateFiles([
			{ path: "/a.png", content_hash: "h1" },
			{ path: "/b.png", content_hash: "h1" },
			{ path: "/c.pdf", content_hash: "h2" },
		]);
		expect(clusters).toHaveLength(1);
		expect(new Set(clusters[0].paths)).toEqual(new Set(["/a.png", "/b.png"]));
	});

	it("drops singleton hashes", () => {
		expect(findBinaryDuplicateFiles([{ path: "/a.png", content_hash: "h1" }])).toEqual([]);
	});

	it("returns no clusters for an empty candidate list", () => {
		expect(findBinaryDuplicateFiles([])).toEqual([]);
	});
});
