import { afterEach, describe, expect, it, vi } from "vitest";

import { KV_CHUNK_CEILING, listChunks, putChunk, queryDomain, type SourceChunk, topKPassages } from "./_source";

// queryDomain is the ONE instrumented kNN path (#1278) — wraps listChunks + topKPassages with the
// per-domain observability fields Workers Observability keys on. These tests exercise the real
// chunk store (a Map-backed OAUTH_KV, same shape advise.test.ts/oracle.test.ts use elsewhere) so
// the assertions see real KV round-trips, not a mocked listChunks/topKPassages.

/** A minimal Map-backed OAUTH_KV (get/put/delete/list) matching the CF KV surface. */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true as const,
			cursor,
		})),
	};
}

function makeChunk(over: Partial<SourceChunk> = {}): SourceChunk {
	return {
		id: crypto.randomUUID(),
		source_id: "src-1",
		domain: "d",
		authority: "authoritative",
		title: "t",
		text: "hello world",
		embedding: [1, 0, 0],
		ts: Date.now(),
		...over,
	};
}

/** Pull the parsed JSON payload of the one structured console.log call queryDomain emits. */
function loggedPayload(logSpy: ReturnType<typeof vi.fn>): any {
	const call = logSpy.mock.calls.find(([line]) => typeof line === "string" && line.includes("source_knn_query"));
	return call ? JSON.parse(call[0] as string) : undefined;
}

afterEach(() => vi.restoreAllMocks());

describe("queryDomain", () => {
	it("logs the 5 required structured fields", async () => {
		const env = { OAUTH_KV: makeKv() } as any;
		await putChunk(env, makeChunk({ id: "a", ts: 100 }));
		await putChunk(env, makeChunk({ id: "b", ts: 200 }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { stats } = await queryDomain(env, "d", [1, 0, 0], 6);

		const payload = loggedPayload(logSpy);
		expect(payload).toMatchObject({ event: "source_knn_query", source_domain: "d", chunk_count: 2, indexed_at: 200 });
		expect(typeof payload.blob_size_bytes).toBe("number");
		expect(payload.blob_size_bytes).toBeGreaterThan(0);
		expect(typeof payload.retrieval_ms).toBe("number");
		const { event: _event, ...loggedStats } = payload;
		expect(stats).toEqual(loggedStats);
	});

	it("indexed_at is null for an empty domain, and the max ts for a populated one", async () => {
		const env = { OAUTH_KV: makeKv() } as any;
		vi.spyOn(console, "log").mockImplementation(() => {});

		const empty = await queryDomain(env, "never-populated", [1, 0, 0], 6);
		expect(empty.stats.chunk_count).toBe(0);
		expect(empty.stats.indexed_at).toBeNull();
		expect(empty.stats.blob_size_bytes).toBe(0);

		await putChunk(env, makeChunk({ domain: "d2", id: "a", ts: 50 }));
		await putChunk(env, makeChunk({ domain: "d2", id: "b", ts: 900 }));
		await putChunk(env, makeChunk({ domain: "d2", id: "c", ts: 400 }));
		const populated = await queryDomain(env, "d2", [1, 0, 0], 6);
		expect(populated.stats.indexed_at).toBe(900);
	});

	it("returns the same passages a direct listChunks + topKPassages call would (no behavior change)", async () => {
		const env = { OAUTH_KV: makeKv() } as any;
		vi.spyOn(console, "log").mockImplementation(() => {});
		await putChunk(env, makeChunk({ domain: "d3", id: "sodium", title: "sodium", embedding: [1, 0, 0], ts: 1 }));
		await putChunk(env, makeChunk({ domain: "d3", id: "exercise", title: "exercise", embedding: [0, 1, 0], ts: 2 }));

		const vec = [0.9, 0.1, 0];
		const direct = topKPassages(vec, await listChunks(env, "d3"), 6);
		const { passages } = await queryDomain(env, "d3", vec, 6);

		expect(passages).toEqual(direct);
	});

	it("does not warn when well under the ceiling", async () => {
		const env = { OAUTH_KV: makeKv() } as any;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await putChunk(env, makeChunk({ domain: "small" }));

		await queryDomain(env, "small", [1, 0, 0], 6);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("warns (approaching) at 90% of KV_CHUNK_CEILING", async () => {
		const env = { OAUTH_KV: makeKv() } as any;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const approaching = Math.ceil(KV_CHUNK_CEILING * 0.9);
		for (let i = 0; i < approaching; i++) await putChunk(env, makeChunk({ domain: "approaching", id: `c${i}`, ts: i }));

		await queryDomain(env, "approaching", [1, 0, 0], 6);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warned = String(warnSpy.mock.calls[0]![0]);
		expect(warned).toContain("approaching");
		expect(warned).toContain(String(approaching));
		expect(warned).toContain("sux#1290");
	});

	it("warns (at/over) when chunk_count reaches KV_CHUNK_CEILING, citing sux#1290", async () => {
		const env = { OAUTH_KV: makeKv() } as any;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < KV_CHUNK_CEILING; i++) await putChunk(env, makeChunk({ domain: "big", id: `c${i}`, ts: i }));

		await queryDomain(env, "big", [1, 0, 0], 6);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warned = String(warnSpy.mock.calls[0]![0]);
		expect(warned).toContain("big");
		expect(warned).toContain(String(KV_CHUNK_CEILING));
		expect(warned).toContain("sux#1290");
	});
});
