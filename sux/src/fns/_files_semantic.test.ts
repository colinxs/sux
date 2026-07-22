import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./_dropbox-full", () => ({ hasDropboxFull: vi.fn(), readFull: vi.fn(), listFullChanges: vi.fn() }));
vi.mock("./_vectorize", async (importOriginal) => ({ ...(await importOriginal<object>()), deleteCorpusIds: vi.fn(async () => {}) }));

import { hasDropboxFull, listFullChanges, readFull } from "./_dropbox-full";
import { filesSemanticIndex, topKFilesByCosine } from "./_files_semantic";
import { encodeEmbedding } from "./_embed";
import { deleteCorpusIds, vectorId } from "./_vectorize";

const dbxHas = hasDropboxFull as unknown as ReturnType<typeof vi.fn>;
const listChanges = listFullChanges as unknown as ReturnType<typeof vi.fn>;
const read = readFull as unknown as ReturnType<typeof vi.fn>;
const deleteIds = deleteCorpusIds as unknown as ReturnType<typeof vi.fn>;

function kvStub() {
	const store = new Map<string, string>();
	return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)), delete: vi.fn(async (k: string) => void store.delete(k)) };
}

// bge model always answers a constant, non-empty vector — good enough for build/incremental
// tests that only check WHICH paths/texts got embedded, not ranking (topKFilesByCosine's own
// test below exercises ranking directly against hand-built chunks).
const aiEnv = () => ({ OAUTH_KV: kvStub(), AI: { run: vi.fn(async (_m: string, inputs: any) => ({ data: (inputs.text as string[]).map(() => [1, 0, 0]) })) } }) as any;

afterEach(() => vi.clearAllMocks());

describe("_files_semantic", () => {
	it("returns null when Dropbox Mode B isn't configured, without touching Dropbox", async () => {
		dbxHas.mockReturnValue(false);
		const idx = await filesSemanticIndex({ AI: { run: vi.fn() } } as any);
		expect(idx).toBeNull();
		expect(listChanges).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});

	it("builds a full index on a cold cache: embeds matching small textual files, skips oversize/non-textual/folder entries", async () => {
		dbxHas.mockReturnValue(true);
		listChanges.mockResolvedValue({
			entries: [
				{ kind: "file", path: "/notes/plan.md", size: 500 },
				{ kind: "file", path: "/notes/huge.md", size: 300_000 }, // over FILE_SIZE_CAP
				{ kind: "file", path: "/notes/image.png", size: 100 }, // not a textual extension
				{ kind: "folder", path: "/notes" }, // not a file at all
			],
			deleted: [],
			has_more: false,
			cursor: "cur-1",
		});
		read.mockResolvedValue({ path: "/notes/plan.md", text: "Walk for exercise thirty minutes." });
		const env = aiEnv();
		const idx = await filesSemanticIndex(env);
		expect(idx?.cursor).toBe("cur-1");
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/plan.md"]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith(env, "/notes/plan.md");
		expect(await env.OAUTH_KV.get("sux:files:semantic")).toBeTruthy(); // persisted for the next call
	});

	it("a per-file readFull failure doesn't sink the whole build — that file is skipped, not thrown", async () => {
		dbxHas.mockReturnValue(true);
		listChanges.mockResolvedValue({
			entries: [
				{ kind: "file", path: "/notes/ok.md", size: 10 },
				{ kind: "file", path: "/notes/bad.md", size: 10 },
			],
			deleted: [],
			has_more: false,
			cursor: "cur-1",
		});
		read.mockImplementation(async (_env: any, path: string) => (path === "/notes/bad.md" ? Promise.reject(new Error("boom")) : { text: "ok text" }));
		const idx = await filesSemanticIndex(aiEnv());
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/ok.md"]);
		expect(idx?.truncated).toBe(true); // the index doesn't fully represent every candidate file
	});

	it("incremental update (list_folder/continue from the cached cursor) only re-embeds changed paths and drops deleted ones, purging the deleted path's Vectorize vector (#1353)", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		const cached = {
			cursor: "cur-1",
			version: 1,
			at: 0,
			total: 2,
			truncated: false,
			chunks: [
				{ path: "/notes/plan.md", text: "kept as-is", embedding: encodeEmbedding([1, 0, 0]) },
				{ path: "/notes/old.md", text: "will be deleted", embedding: encodeEmbedding([1, 0, 0]) },
			],
		};
		env.OAUTH_KV.store.set("sux:files:semantic", JSON.stringify(cached));
		listChanges.mockResolvedValue({ entries: [{ kind: "file", path: "/notes/new.md", size: 200 }], deleted: ["/notes/old.md"], has_more: false, cursor: "cur-2" });
		read.mockResolvedValue({ text: "Fresh content here." });
		const idx = await filesSemanticIndex(env);
		expect(idx?.cursor).toBe("cur-2");
		expect(idx?.chunks.map((c) => c.path).sort()).toEqual(["/notes/new.md", "/notes/plan.md"]); // old.md dropped, plan.md kept unchanged, new.md added
		expect(read).toHaveBeenCalledTimes(1); // only the changed path was re-read/embedded
		expect(read).toHaveBeenCalledWith(env, "/notes/new.md");
		expect(env.AI.run.mock.calls.length).toBe(1);
		expect(env.AI.run.mock.calls[0][1].text).toEqual(["Fresh content here."]); // plan.md's cached embedding wasn't recomputed
		expect(deleteIds).toHaveBeenCalledTimes(1);
		expect(deleteIds).toHaveBeenCalledWith(env, [await vectorId("files", "/notes/old.md", 0)]); // new.md has no prior chunks, so nothing to delete for it
	});

	it("a CHANGED path's every old sub-index chunk is purged from Vectorize, not just the first — a re-chunk can shrink the chunk count", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		const cached = {
			cursor: "cur-1",
			version: 1,
			at: 0,
			total: 1,
			truncated: false,
			chunks: [
				{ path: "/notes/multi.md", text: "old chunk 0", embedding: encodeEmbedding([1, 0, 0]) },
				{ path: "/notes/multi.md", text: "old chunk 1", embedding: encodeEmbedding([1, 0, 0]) },
			],
		};
		env.OAUTH_KV.store.set("sux:files:semantic", JSON.stringify(cached));
		listChanges.mockResolvedValue({ entries: [{ kind: "file", path: "/notes/multi.md", size: 50 }], deleted: [], has_more: false, cursor: "cur-2" });
		read.mockResolvedValue({ text: "shorter replacement text" });
		await filesSemanticIndex(env);
		expect(deleteIds).toHaveBeenCalledTimes(1);
		const [, ids] = deleteIds.mock.calls[0];
		expect(ids.sort()).toEqual([await vectorId("files", "/notes/multi.md", 0), await vectorId("files", "/notes/multi.md", 1)].sort());
	});

	it("a no-op incremental pass (nothing changed) skips the KV write", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		env.OAUTH_KV.store.set(
			"sux:files:semantic",
			JSON.stringify({ cursor: "cur-1", version: 1, at: 0, total: 1, truncated: false, chunks: [{ path: "/notes/a.md", text: "t", embedding: encodeEmbedding([1, 0, 0]) }] }),
		);
		const putCallsBefore = env.OAUTH_KV.put.mock.calls.length;
		listChanges.mockResolvedValue({ entries: [], deleted: [], has_more: false, cursor: "cur-1" });
		const idx = await filesSemanticIndex(env);
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/a.md"]);
		expect(env.OAUTH_KV.put.mock.calls.length).toBe(putCallsBefore); // no re-serialize + put for an unchanged index
	});

	it("a shape-drifted/wrong-version cached blob is treated as a miss and rebuilt (not continued from its stale cursor)", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		env.OAUTH_KV.store.set(
			"sux:files:semantic",
			JSON.stringify({ cursor: "stale-cursor", version: 999, at: 0, total: 1, truncated: false, chunks: [{ path: "/notes/a.md", text: "t", embedding: encodeEmbedding([1, 0, 0]) }] }),
		);
		listChanges.mockResolvedValue({ entries: [{ kind: "file", path: "/notes/fresh.md", size: 10 }], deleted: [], has_more: false, cursor: "new-cur" });
		read.mockResolvedValue({ text: "fresh text" });
		const idx = await filesSemanticIndex(env);
		expect(idx?.cursor).toBe("new-cur");
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/fresh.md"]);
		expect(listChanges).toHaveBeenCalledWith(env, undefined); // rebuilt fresh — never tried to continue from the stale cursor
	});

	it("falls back to a full rebuild when the cached cursor can no longer be continued (a reset-shaped Dropbox error)", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		env.OAUTH_KV.store.set(
			"sux:files:semantic",
			JSON.stringify({ cursor: "old-cur", version: 1, at: 0, total: 1, truncated: false, chunks: [{ path: "/notes/a.md", text: "t", embedding: encodeEmbedding([1, 0, 0]) }] }),
		);
		listChanges.mockImplementation(async (_env: any, cursor?: string) => {
			if (cursor === "old-cur") throw new Error("Dropbox list error: path/not_found/... reset");
			return { entries: [{ kind: "file", path: "/notes/b.md", size: 10 }], deleted: [], has_more: false, cursor: "new-cur" };
		});
		read.mockResolvedValue({ text: "b text" });
		const idx = await filesSemanticIndex(env);
		expect(idx?.cursor).toBe("new-cur");
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/b.md"]);
	});

	it("a transport failure during the incremental leg also falls back to a full rebuild rather than throwing", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		env.OAUTH_KV.store.set(
			"sux:files:semantic",
			JSON.stringify({ cursor: "old-cur", version: 1, at: 0, total: 1, truncated: false, chunks: [{ path: "/notes/a.md", text: "t", embedding: encodeEmbedding([1, 0, 0]) }] }),
		);
		listChanges.mockImplementation(async (_env: any, cursor?: string) => {
			if (cursor === "old-cur") throw new Error("Dropbox list error: HTTP 500");
			return { entries: [{ kind: "file", path: "/notes/c.md", size: 10 }], deleted: [], has_more: false, cursor: "new-cur" };
		});
		read.mockResolvedValue({ text: "c text" });
		const idx = await filesSemanticIndex(env);
		expect(idx).toBeTruthy(); // recovered via full rebuild instead of throwing
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/c.md"]);
	});

	// #1347: unpacked-archive/package-manager junk (node_modules, .yarn/cache, .git, an
	// /Auto/Unpack/ staging tree) must never be indexed, even when it otherwise passes the
	// size/extension gate.
	it("never embeds node_modules/.yarn/cache/.git/Auto-Unpack junk, even when it passes the size/extension gate", async () => {
		dbxHas.mockReturnValue(true);
		listChanges.mockResolvedValue({
			entries: [
				{ kind: "file", path: "/Auto/Unpack/plex-6.4.2/.yarn/cache/queue-microtask-npm-1.2/node_modules/queue-microtask/package.json", size: 200 },
				{ kind: "file", path: "/repo/.git/config", size: 50 },
				{ kind: "file", path: "/notes/real.md", size: 50 },
			],
			deleted: [],
			has_more: false,
			cursor: "cur-1",
		});
		read.mockResolvedValue({ text: "real note text" });
		const idx = await filesSemanticIndex(aiEnv());
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/real.md"]);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("purges already-indexed junk chunks from a cache built before the exclusion existed, and is idempotent on a re-run", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		env.OAUTH_KV.store.set(
			"sux:files:semantic",
			JSON.stringify({
				cursor: "cur-1",
				version: 1,
				at: 0,
				total: 2,
				truncated: false,
				chunks: [
					{ path: "/Auto/Unpack/plex-6.4.2/.yarn/cache/iconv-lite-npm-0.4/node_modules/iconv-lite/encodings/tables/shiftjis.json", text: "junk", embedding: encodeEmbedding([1, 0, 0]) },
					{ path: "/notes/keep.md", text: "keep me", embedding: encodeEmbedding([1, 0, 0]) },
				],
			}),
		);
		listChanges.mockResolvedValue({ entries: [], deleted: [], has_more: false, cursor: "cur-1" }); // no-op incremental pass
		const idx = await filesSemanticIndex(env);
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/keep.md"]);

		// A second pass over the now-clean cache purges nothing further (idempotent).
		listChanges.mockResolvedValue({ entries: [], deleted: [], has_more: false, cursor: "cur-1" });
		const idx2 = await filesSemanticIndex(env);
		expect(idx2?.chunks.map((c) => c.path)).toEqual(["/notes/keep.md"]);
	});

	it("filesSemanticIndexCached filters junk out in-memory too, without writing back to KV", async () => {
		dbxHas.mockReturnValue(true);
		const env = aiEnv();
		const putCallsBefore = env.OAUTH_KV.put.mock.calls.length;
		env.OAUTH_KV.store.set(
			"sux:files:semantic",
			JSON.stringify({
				cursor: "cur-1",
				version: 1,
				at: 0,
				total: 2,
				truncated: false,
				chunks: [
					{ path: "/repo/.git/HEAD", text: "junk", embedding: encodeEmbedding([1, 0, 0]) },
					{ path: "/notes/keep.md", text: "keep me", embedding: encodeEmbedding([1, 0, 0]) },
				],
			}),
		);
		const { filesSemanticIndexCached } = await import("./_files_semantic");
		const idx = await filesSemanticIndexCached(env);
		expect(idx?.chunks.map((c) => c.path)).toEqual(["/notes/keep.md"]);
		expect(env.OAUTH_KV.put.mock.calls.length).toBe(putCallsBefore); // read-only sibling never writes
	});

	it("topKFilesByCosine ranks by cosine similarity and skips chunks with no embedding", () => {
		const chunks = [
			{ path: "/a.md", text: "t", embedding: [1, 0, 0] },
			{ path: "/b.md", text: "t", embedding: [0, 1, 0] },
			{ path: "/c.md", text: "t", embedding: [] },
		];
		const hits = topKFilesByCosine([1, 0, 0], chunks, 5);
		expect(hits.map((h) => h.path)).toEqual(["/a.md", "/b.md"]);
		expect(hits[0].score).toBeCloseTo(1);
	});
});
