import { beforeEach, describe, expect, it, vi } from "vitest";

// The backfill/repopulate path (#1290): reindexCorpus reads the existing corpus and upserts
// every chunk into `sux-corpus` under its namespace, reusing stored embeddings. Mock the
// index builders + the _source chunk store (their own suites cover building); assert the
// upsert fan-out, the per-domain report, idempotency (stable ids), and the no-binding throw.
vi.mock("./_vault_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultSemanticIndex: vi.fn() }));
vi.mock("./_mail_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), mailSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_files_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), filesSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_contact_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), contactSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_source", async (importOriginal) => ({ ...(await importOriginal<object>()), listDomains: vi.fn(async () => []), listChunks: vi.fn(async () => []) }));
vi.mock("./obsidian", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultCfg: vi.fn(() => ({ repo: "owner/repo", branch: "main", dir: "", inVault: (p: string) => p })) }));

import { queryCorpus, vectorId } from "./_vectorize";
import { listChunks, listDomains } from "./_source";
import { vaultSemanticIndex } from "./_vault_semantic";
import { REINDEX_DOMAINS, advanceReindexCursor, hasVectorizeBackfill, nextReindexDomain, reindexCorpus, reindexCorpusTick, rotateReindexDomain } from "./_reindex";

const vaultBuild = vaultSemanticIndex as unknown as ReturnType<typeof vi.fn>;
const domainsList = listDomains as unknown as ReturnType<typeof vi.fn>;
const chunksList = listChunks as unknown as ReturnType<typeof vi.fn>;

function makeVectorize() {
	const store = new Map<string, VectorizeVector>();
	return {
		store,
		upsert: async (vectors: VectorizeVector[]) => {
			for (const v of vectors) store.set(v.id, v);
			return { mutationId: "m" };
		},
		query: async (vector: number[], opts: VectorizeQueryOptions = {}) => {
			const scored = [...store.values()].filter((v) => opts.namespace === undefined || v.namespace === opts.namespace).map((v) => ({ id: v.id, namespace: v.namespace, metadata: v.metadata, score: 1 }));
			return { matches: scored.slice(0, opts.topK ?? 5), count: scored.length };
		},
		deleteByIds: async () => ({ mutationId: "d" }),
	};
}

describe("reindexCorpus (#1290 backfill)", () => {
	it("throws when the Vectorize binding is absent (nothing to populate)", async () => {
		await expect(reindexCorpus({} as any)).rejects.toThrow(/not bound/);
	});

	it("backfills vault chunks (grouped per note) and reports per-domain counts", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx, OBSIDIAN_VAULT_REPO: "owner/repo" } as any;
		vaultBuild.mockResolvedValue({
			sha: "h",
			version: 2,
			at: 1,
			total: 2,
			truncated: false,
			chunks: [
				{ path: "a.md", title: "a", text: "a1", embedding: [1, 0, 0] },
				{ path: "a.md", title: "a", text: "a2", embedding: [0, 1, 0] },
				{ path: "b.md", title: "b", text: "b1", embedding: [0, 0, 1] },
			],
		});
		const report = await reindexCorpus(env, { domains: ["vault"] });
		expect(report.index).toBe("sux-corpus");
		expect(report.domains.vault.indexed).toBe(3);
		expect(report.total).toBe(3);
		expect(vx.store.size).toBe(3);
		// a.md's two chunks got distinct ids (sub 0/1); pointer round-trips.
		const hits = await queryCorpus(env, "vault", [1, 0, 0], 5);
		expect(hits.every((h) => h.pointer === "vault:a.md" || h.pointer === "vault:b.md")).toBe(true);
	});

	it("is idempotent: re-running the same backfill upserts in place, never duplicates", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx, OBSIDIAN_VAULT_REPO: "owner/repo" } as any;
		vaultBuild.mockResolvedValue({ sha: "h", version: 2, at: 1, total: 1, truncated: false, chunks: [{ path: "a.md", title: "a", text: "a1", embedding: [1, 0, 0] }] });
		await reindexCorpus(env, { domains: ["vault"] });
		await reindexCorpus(env, { domains: ["vault"] });
		expect(vx.store.size).toBe(1);
	});

	it("source-chunk sweep keys off the KV chunk id — matching the write-path tap's id", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx } as any;
		domainsList.mockResolvedValue(["oracle:atomic_habits"]);
		chunksList.mockResolvedValue([{ id: "kv1", source_id: "s1", domain: "oracle:atomic_habits", authority: "authoritative", title: "book", text: "make it obvious", embedding: [1, 0, 0] }]);
		const report = await reindexCorpus(env, { domains: ["source"] });
		expect(report.domains.source.indexed).toBe(1);
		// The stored vector's id is exactly vectorId("oracle", chunkId, "") — the shared scheme.
		expect(vx.store.has(await vectorId("oracle", "kv1", ""))).toBe(true);
		const hits = await queryCorpus(env, "oracle", [1, 0, 0], 5);
		expect(hits[0].pointer).toBe("whitelisted:atomic_habits"); // authoritative → whitelisted
	});

	it("captures a per-domain failure without sinking the rest of the backfill", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx, OBSIDIAN_VAULT_REPO: "owner/repo" } as any;
		vaultBuild.mockRejectedValue(new Error("vault build boom"));
		domainsList.mockResolvedValue([]);
		const report = await reindexCorpus(env, { domains: ["vault", "source"] });
		expect(report.domains.vault.error).toMatch(/boom/);
		expect(report.domains.source.indexed).toBe(0); // ran despite vault failing
	});
});

// The automatic batched backfill (#1315): a cron tick runs EXACTLY one REINDEX_DOMAINS entry
// (the existing per-domain granularity IS the batching) and rotates a persisted KV cursor, so
// a full corpus backfill spans multiple ticks instead of one oversized request.
function makeKV() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	};
}

describe("reindex rotation cursor (#1315 batched backfill)", () => {
	it("rotateReindexDomain steps through REINDEX_DOMAINS in order", () => {
		for (let i = 0; i < REINDEX_DOMAINS.length - 1; i++) {
			expect(rotateReindexDomain(REINDEX_DOMAINS[i])).toBe(REINDEX_DOMAINS[i + 1]);
		}
	});

	it("rotateReindexDomain wraps back to the first domain after the last", () => {
		expect(rotateReindexDomain(REINDEX_DOMAINS[REINDEX_DOMAINS.length - 1])).toBe(REINDEX_DOMAINS[0]);
	});

	it("nextReindexDomain defaults to the first domain when the cursor is unset", async () => {
		const env = { OAUTH_KV: makeKV() } as any;
		expect(await nextReindexDomain(env)).toBe(REINDEX_DOMAINS[0]);
	});

	it("nextReindexDomain defaults to the first domain on a stale/invalid cursor value", async () => {
		const kv = makeKV();
		kv.store.set("sux:reindex:cursor", "not-a-real-domain");
		const env = { OAUTH_KV: kv } as any;
		expect(await nextReindexDomain(env)).toBe(REINDEX_DOMAINS[0]);
	});

	it("advanceReindexCursor persists the next domain, and wraps after the last", async () => {
		const kv = makeKV();
		const env = { OAUTH_KV: kv } as any;
		await advanceReindexCursor(env, REINDEX_DOMAINS[0]);
		expect(await nextReindexDomain(env)).toBe(REINDEX_DOMAINS[1]);
		await advanceReindexCursor(env, REINDEX_DOMAINS[REINDEX_DOMAINS.length - 1]);
		expect(await nextReindexDomain(env)).toBe(REINDEX_DOMAINS[0]);
	});
});

describe("reindexCorpusTick (#1315 batched backfill)", () => {
	beforeEach(() => {
		// Reset the per-domain builder mocks to the same safe defaults they start the file
		// with — this suite's tests shouldn't depend on execution order relative to the
		// reindexCorpus suite above (which leaves some of these mocked to error/empty states).
		vaultBuild.mockReset();
		domainsList.mockReset();
		domainsList.mockResolvedValue([]);
		chunksList.mockReset();
		chunksList.mockResolvedValue([]);
	});

	it("is a dormant no-op when VECTORIZE_BACKFILL_ENABLED is unset", async () => {
		const kv = makeKV();
		const env = { VECTORIZE: makeVectorize(), OAUTH_KV: kv } as any;
		expect(hasVectorizeBackfill(env)).toBe(false);
		expect(await reindexCorpusTick(env)).toEqual({ dormant: true });
		expect(kv.store.size).toBe(0); // cursor untouched — no partial progress recorded
	});

	it("processes exactly one domain per call and advances the cursor to the next", async () => {
		const env = { VECTORIZE: makeVectorize(), OAUTH_KV: makeKV(), VECTORIZE_BACKFILL_ENABLED: "1" } as any;
		const r1 = (await reindexCorpusTick(env)) as { domain: string; next: string; domains: Record<string, unknown> };
		expect(r1.domain).toBe(REINDEX_DOMAINS[0]);
		expect(r1.next).toBe(REINDEX_DOMAINS[1]);
		expect(Object.keys(r1.domains)).toEqual([REINDEX_DOMAINS[0]]);
		expect(await nextReindexDomain(env)).toBe(REINDEX_DOMAINS[1]);

		const r2 = (await reindexCorpusTick(env)) as { domain: string; next: string; domains: Record<string, unknown> };
		expect(r2.domain).toBe(REINDEX_DOMAINS[1]);
		expect(Object.keys(r2.domains)).toEqual([REINDEX_DOMAINS[1]]);
	});

	it("a full rotation (REINDEX_DOMAINS.length ticks) touches every domain exactly once and wraps", async () => {
		const env = { VECTORIZE: makeVectorize(), OAUTH_KV: makeKV(), VECTORIZE_BACKFILL_ENABLED: "1" } as any;
		const seen: string[] = [];
		for (let i = 0; i < REINDEX_DOMAINS.length; i++) {
			const r = (await reindexCorpusTick(env)) as { domain: string };
			seen.push(r.domain);
		}
		expect(seen).toEqual(REINDEX_DOMAINS);
		expect(await nextReindexDomain(env)).toBe(REINDEX_DOMAINS[0]); // wrapped back to the start
	});
});
