import { afterEach, describe, expect, it, vi } from "vitest";

// purgeStaleVaultChunks (#1347): a moved/deleted vault note (e.g. the Meta/→_meta/ migration)
// can linger in the cached KV cosine core + the Vectorize index forever — neither the HEAD-sha
// rebuild (only overwrites when something calls the BUILDING variant) nor the Vectorize backfill
// (purely additive) ever drops a since-vanished path on its own. Mock obsidian's `run` (the
// "list" action) only; readVaultSemanticBlob/writeVaultSemanticBlob stay real against a plain KV
// stub, same idiom the rest of this substrate's suites use.
vi.mock("./obsidian", async (importOriginal) => ({ ...(await importOriginal<object>()), obsidian: { run: vi.fn() } }));

import { encodeEmbedding } from "./_embed";
import { obsidian } from "./obsidian";
import { purgeStaleVaultChunks } from "./_vault_semantic";
import { writeVaultSemanticBlob } from "./obsidian";
import { deleteCorpusIds } from "./_vectorize";

vi.mock("./_vectorize", async (importOriginal) => ({ ...(await importOriginal<object>()), deleteCorpusIds: vi.fn(async () => {}) }));

const run = obsidian.run as unknown as ReturnType<typeof vi.fn>;
const deleteIds = deleteCorpusIds as unknown as ReturnType<typeof vi.fn>;

function kvStub() {
	const store = new Map<string, string>();
	return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)), delete: vi.fn(async (k: string) => void store.delete(k)) };
}

const cfg = { repo: "me/vault", branch: "main", dir: "", inVault: (p: string) => p };

function listResult(notes: string[]) {
	return { isError: false, content: [{ text: JSON.stringify({ notes }) }] };
}

async function seedCore(env: any, chunks: Array<{ path: string; title: string; text: string }>) {
	await writeVaultSemanticBlob(env, cfg, {
		sha: "h1",
		version: 2,
		at: 1,
		total: new Set(chunks.map((c) => c.path)).size,
		truncated: false,
		chunks: chunks.map((c) => ({ ...c, embedding: encodeEmbedding([1, 0, 0]) })),
	});
}

afterEach(() => vi.clearAllMocks());

describe("purgeStaleVaultChunks (#1347)", () => {
	it("drops chunks whose path no longer exists in the current vault listing, and deletes their Vectorize vectors", async () => {
		const env = { OAUTH_KV: kvStub() } as any;
		await seedCore(env, [
			{ path: "Meta/Graph-Health.md", title: "Graph-Health", text: "stale pre-migration note" },
			{ path: "_meta/Graph-Health.md", title: "Graph-Health", text: "current note" },
		]);
		run.mockResolvedValue(listResult(["_meta/Graph-Health.md"])); // Meta/ no longer exists at HEAD

		const { purgedPaths } = await purgeStaleVaultChunks(env, cfg);
		expect(purgedPaths).toEqual(["Meta/Graph-Health.md"]);
		expect(deleteIds).toHaveBeenCalledTimes(1);

		// The persisted core no longer carries the stale chunk.
		const { readVaultSemanticBlob } = await import("./obsidian");
		const stored = await readVaultSemanticBlob(env, cfg);
		expect(stored.chunks.map((c: any) => c.path)).toEqual(["_meta/Graph-Health.md"]);
	});

	it("is a no-op when every cached path still exists — idempotent, no write, no delete", async () => {
		const env = { OAUTH_KV: kvStub() } as any;
		await seedCore(env, [{ path: "Health/Labs.md", title: "Labs", text: "creatinine" }]);
		run.mockResolvedValue(listResult(["Health/Labs.md"]));

		const { purgedPaths } = await purgeStaleVaultChunks(env, cfg);
		expect(purgedPaths).toEqual([]);
		expect(deleteIds).not.toHaveBeenCalled();
	});

	it("skips the purge (never mass-deletes) when the listing comes back suspiciously empty", async () => {
		const env = { OAUTH_KV: kvStub() } as any;
		await seedCore(env, [{ path: "Health/Labs.md", title: "Labs", text: "creatinine" }]);
		run.mockResolvedValue(listResult([])); // more likely a transient failure than a truly emptied vault

		const { purgedPaths } = await purgeStaleVaultChunks(env, cfg);
		expect(purgedPaths).toEqual([]);
		expect(deleteIds).not.toHaveBeenCalled();
	});

	it("skips the purge when the listing call itself errors", async () => {
		const env = { OAUTH_KV: kvStub() } as any;
		await seedCore(env, [{ path: "Health/Labs.md", title: "Labs", text: "creatinine" }]);
		run.mockResolvedValue({ isError: true, content: [{ text: "boom" }] });

		const { purgedPaths } = await purgeStaleVaultChunks(env, cfg);
		expect(purgedPaths).toEqual([]);
		expect(deleteIds).not.toHaveBeenCalled();
	});

	it("no cached core is a fast no-op", async () => {
		const env = { OAUTH_KV: kvStub() } as any;
		const { purgedPaths } = await purgeStaleVaultChunks(env, cfg);
		expect(purgedPaths).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});
});
