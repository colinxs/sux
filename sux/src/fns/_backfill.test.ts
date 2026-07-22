import { describe, expect, it, vi } from "vitest";

// The durable batched backfill (#1315): backfillTick advances a per-domain KV cursor by a
// bounded window each call, upserting into `sux-corpus` with stable ids. Mock the semantic
// index builders + the _source chunk store (their own suites cover building); assert the cursor
// advances, resumes, is idempotent, and that an empty domain completes cleanly. The backfill
// enumerates via the CACHED reads (vaultSemanticIndexCached), so mock that, not the builder.
vi.mock("./_vault_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultSemanticIndexCached: vi.fn() }));
vi.mock("./_mail_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), mailSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_files_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), filesSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_contact_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), contactSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_source", async (importOriginal) => ({ ...(await importOriginal<object>()), listDomains: vi.fn(async () => []), listChunks: vi.fn(async () => []) }));
vi.mock("./obsidian", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultCfg: vi.fn(() => ({ repo: "owner/repo", branch: "main", dir: "", inVault: (p: string) => p })) }));

import { listChunks, listDomains } from "./_source";
import { vectorId } from "./_vectorize";
import { vaultSemanticIndexCached } from "./_vault_semantic";
import { backfillStatus, backfillTick, resetBackfill } from "./_backfill";

const vaultCached = vaultSemanticIndexCached as unknown as ReturnType<typeof vi.fn>;
const domainsList = listDomains as unknown as ReturnType<typeof vi.fn>;
const chunksList = listChunks as unknown as ReturnType<typeof vi.fn>;

function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
	};
}

function makeVectorize() {
	const store = new Map<string, VectorizeVector>();
	return {
		store,
		upsert: async (vectors: VectorizeVector[]) => {
			for (const v of vectors) store.set(v.id, v);
			return { mutationId: "m" };
		},
		query: async () => ({ matches: [], count: 0 }),
		describe: async () => ({ vectorCount: store.size, dimensions: 768, processedUpToDatetime: 0, processedUpToMutation: 0 }),
		deleteByIds: async () => ({ mutationId: "d" }),
	};
}

/** A vault cached-index of `n` distinct-path notes (one chunk each), stable order a0..a{n-1}. */
function vaultIndex(n: number) {
	return {
		sha: "h",
		version: 2,
		at: 1,
		total: n,
		truncated: false,
		chunks: Array.from({ length: n }, (_, i) => ({ path: `a${i}.md`, title: `a${i}`, text: `t${i}`, embedding: [i + 1, 0, 0] })),
	};
}

function makeEnv() {
	const vx = makeVectorize();
	const kv = makeKv();
	return { env: { VECTORIZE: vx, OAUTH_KV: kv, OBSIDIAN_VAULT_REPO: "owner/repo" } as any, vx, kv };
}

describe("backfillTick (#1315 durable batched backfill)", () => {
	it("throws when the Vectorize binding is absent (nothing to populate)", async () => {
		await expect(backfillTick({ OAUTH_KV: makeKv() } as any)).rejects.toThrow(/not bound/);
	});

	it("one bounded window advances the cursor by batchSize and no further", async () => {
		const { env, vx } = makeEnv();
		vaultCached.mockResolvedValue(vaultIndex(5));
		const r = await backfillTick(env, { domain: "vault", batchSize: 2, maxBatches: 1 });
		const vault = r.domains.find((d) => d.domain === "vault")!;
		expect(vault.offset).toBe(2); // advanced exactly one window
		expect(vault.processed).toBe(2);
		expect(vault.total).toBe(5);
		expect(vault.remaining).toBe(3);
		expect(vault.done).toBe(false);
		expect(vx.store.size).toBe(2); // only the first two vectors upserted
		expect(r.vectorCount).toBe(2); // live describe() reflects the store
	});

	it("resumes from the persisted cursor — a later tick only processes the remainder", async () => {
		const { env, vx } = makeEnv();
		vaultCached.mockResolvedValue(vaultIndex(5));
		await backfillTick(env, { domain: "vault", batchSize: 2, maxBatches: 1 }); // offset 0→2
		await backfillTick(env, { domain: "vault", batchSize: 2, maxBatches: 1 }); // offset 2→4
		const r = await backfillTick(env, { domain: "vault", batchSize: 2, maxBatches: 1 }); // offset 4→5, done
		const vault = r.domains.find((d) => d.domain === "vault")!;
		expect(vault.offset).toBe(5);
		expect(vault.processed).toBe(5);
		expect(vault.done).toBe(true);
		expect(vault.remaining).toBe(0);
		expect(vx.store.size).toBe(5); // all five, no duplication across the three ticks
	});

	it("drives a domain to completion in one tick when the budget allows (unbounded windows)", async () => {
		const { env, vx } = makeEnv();
		vaultCached.mockResolvedValue(vaultIndex(5));
		const r = await backfillTick(env, { domain: "vault", batchSize: 2 });
		const vault = r.domains.find((d) => d.domain === "vault")!;
		expect(vault.done).toBe(true);
		expect(vault.offset).toBe(5);
		expect(vx.store.size).toBe(5);
		expect(r.done).toBe(true);
	});

	it("is idempotent: re-running after completion never duplicates (stable ids)", async () => {
		const { env, vx } = makeEnv();
		vaultCached.mockResolvedValue(vaultIndex(3));
		await backfillTick(env, { domain: "vault" });
		expect(vx.store.size).toBe(3);
		// reset the cursor and run the whole thing again — same stable ids, still 3 vectors.
		await resetBackfill(env, { domain: "vault" });
		const r = await backfillTick(env, { domain: "vault" });
		expect(vx.store.size).toBe(3);
		expect(r.domains[0].processed).toBe(3);
	});

	it("a domain with no chunks completes cleanly (done, zero processed)", async () => {
		const { env, vx } = makeEnv();
		domainsList.mockResolvedValue([]); // no source domains at all
		const r = await backfillTick(env, { domain: "source" });
		const source = r.domains.find((d) => d.domain === "source")!;
		expect(source.done).toBe(true);
		expect(source.total).toBe(0);
		expect(source.processed).toBe(0);
		expect(source.remaining).toBe(0);
		expect(vx.store.size).toBe(0);
	});

	it("a not-ready domain (cold cache) leaves the cursor un-done and retries next tick", async () => {
		const { env } = makeEnv();
		vaultCached.mockResolvedValue(null); // cache not warm yet
		const r = await backfillTick(env, { domain: "vault" });
		const vault = r.domains.find((d) => d.domain === "vault")!;
		expect(vault.done).toBe(false); // NOT prematurely marked done
		expect(vault.offset).toBe(0);
		expect(vault.note).toMatch(/not warm/);
	});

	it("source sweep keys off the KV chunk id — the shared write-path-tap id scheme", async () => {
		const { env, vx } = makeEnv();
		domainsList.mockResolvedValue(["oracle:atomic_habits"]);
		chunksList.mockResolvedValue([{ id: "kv1", source_id: "s1", domain: "oracle:atomic_habits", authority: "authoritative", title: "book", text: "make it obvious", embedding: [1, 0, 0] }]);
		const r = await backfillTick(env, { domain: "source" });
		expect(r.domains[0].processed).toBe(1);
		expect(vx.store.has(await vectorId("oracle", "kv1", ""))).toBe(true);
	});

	it("backfillStatus is a pure read — reports cursor progress + live vectorCount, no upserts", async () => {
		const { env, vx } = makeEnv();
		vaultCached.mockResolvedValue(vaultIndex(4));
		await backfillTick(env, { domain: "vault", batchSize: 2, maxBatches: 1 }); // offset 0→2
		const before = vx.store.size;
		const s = await backfillStatus(env, { domain: "vault" });
		expect(vx.store.size).toBe(before); // status did not upsert anything
		expect(s.domains[0].offset).toBe(2);
		expect(s.domains[0].processed).toBe(2);
		expect(s.vectorCount).toBe(before);
	});

	it("resetBackfill clears the cursor so the next tick restarts from the beginning", async () => {
		const { env } = makeEnv();
		vaultCached.mockResolvedValue(vaultIndex(5));
		await backfillTick(env, { domain: "vault", batchSize: 2, maxBatches: 1 }); // offset 2
		await resetBackfill(env, { domain: "vault" });
		const s = await backfillStatus(env, { domain: "vault" });
		expect(s.domains[0].offset).toBe(0);
		expect(s.domains[0].done).toBe(false);
		expect(s.domains[0].total).toBeNull();
	});
});
