import { describe, expect, it, vi } from "vitest";

import { retrievalStats } from "./_retrieval_stats";
import { KV_BLOB_WARN_BYTES, KV_CHUNK_WARN, nearCeiling, putChunk, type SourceChunk, sourceStats } from "./_source";

// KV-bet observability (v5 W5, #1278): per-domain chunk_count + blob_size_bytes + indexed_at,
// with a near-ceiling flag arming the Vectorize graduation decision (sux#1290). These drive the
// stat gatherers through a metadata-aware KV mock — putChunk stamps {ts,size} into KV metadata,
// so sourceStats totals a domain from list() alone (no value GETs).

/** A Map-backed OAUTH_KV that models the ONE feature the #1278 path relies on the real KV for:
 *  per-key metadata on put(), returned by list(). (The shared _answer.test.ts mock drops both.) */
function makeKv() {
	const store = new Map<string, { value: string; metadata?: unknown }>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)!.value : null)),
		put: vi.fn(async (k: string, v: string, opts?: { metadata?: unknown }) => void store.set(k, { value: v, metadata: opts?.metadata })),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string; cursor?: string } = {}) => ({
			keys: [...store.entries()]
				.filter(([k]) => !prefix || k.startsWith(prefix))
				.map(([name, v]) => ({ name, ...(v.metadata !== undefined ? { metadata: v.metadata } : {}) })),
			list_complete: true as const,
		})),
	};
}

const chunk = (over: Partial<SourceChunk> & Pick<SourceChunk, "id" | "domain" | "ts">): SourceChunk => ({
	source_id: "s",
	authority: "contextual",
	title: "t",
	text: "some chunk text",
	embedding: [1, 0, 0],
	...over,
});

describe("sourceStats — per-domain KV-bet observability from list() metadata", () => {
	it("reports chunk_count + blob_size_bytes + indexed_at per domain", async () => {
		const kv = makeKv();
		const env = { OAUTH_KV: kv } as any;
		await putChunk(env, chunk({ id: "a1", domain: "assim:mail", ts: 1000 }));
		await putChunk(env, chunk({ id: "a2", domain: "assim:mail", ts: 2000, text: "a longer second chunk of text" }));
		await putChunk(env, chunk({ id: "o1", domain: "oracle:health", ts: 1500 }));

		const byDomain = Object.fromEntries((await sourceStats(env)).map((s) => [s.domain, s]));
		// domain splits on the LAST colon — the namespaced "assim:mail"/"oracle:health" stay intact.
		expect(byDomain["assim:mail"]).toMatchObject({ chunk_count: 2, metered_chunks: 2, indexed_at: 2000, near_ceiling: false });
		expect(byDomain["assim:mail"].blob_size_bytes).toBeGreaterThan(0);
		expect(byDomain["oracle:health"]).toMatchObject({ chunk_count: 1, metered_chunks: 1, indexed_at: 1500, near_ceiling: false });
	});

	it("an empty keyspace reports [] — no error", async () => {
		expect(await sourceStats({ OAUTH_KV: makeKv() } as any)).toEqual([]);
	});

	it("no KV binding reports [] — no error", async () => {
		expect(await sourceStats({} as any)).toEqual([]);
	});
});

describe("nearCeiling — the sux#1290 graduation trigger", () => {
	it("trips exactly at the chunk-count and blob-size warn lines", () => {
		expect(nearCeiling(KV_CHUNK_WARN - 1, 0)).toBe(false);
		expect(nearCeiling(KV_CHUNK_WARN, 0)).toBe(true);
		expect(nearCeiling(0, KV_BLOB_WARN_BYTES - 1)).toBe(false);
		expect(nearCeiling(0, KV_BLOB_WARN_BYTES)).toBe(true);
	});

	it("flags a domain end-to-end once its chunk count crosses the warn line", async () => {
		const kv = makeKv();
		for (let i = 0; i < KV_CHUNK_WARN; i++) kv.store.set(`sux:source:chunk:assim:scan:c${i}`, { value: "{}", metadata: { ts: i, size: 10 } });
		const scan = (await sourceStats({ OAUTH_KV: kv } as any)).find((s) => s.domain === "assim:scan")!;
		expect(scan.chunk_count).toBe(KV_CHUNK_WARN);
		expect(scan.near_ceiling).toBe(true);
	});

	it("flags a domain end-to-end once its blob size crosses the warn line", async () => {
		const kv = makeKv();
		kv.store.set("sux:source:chunk:phi:medical:big", { value: "{}", metadata: { ts: 5, size: KV_BLOB_WARN_BYTES + 1 } });
		const phi = (await sourceStats({ OAUTH_KV: kv } as any)).find((s) => s.domain === "phi:medical")!;
		expect(phi).toMatchObject({ chunk_count: 1, blob_size_bytes: KV_BLOB_WARN_BYTES + 1, near_ceiling: true });
	});
});

describe("retrievalStats — the unified readout across both storage models", () => {
	it("empty everywhere: every packed domain reports zeros + a note, no alerts, no error", async () => {
		const r = await retrievalStats({ OAUTH_KV: makeKv() } as any);
		const byDomain = Object.fromEntries(r.domains.map((d) => [d.domain, d]));
		// vault is unconfigured (no vault env) → not configured; the fixed-key indices are cold.
		expect(byDomain.vault).toMatchObject({ store: "packed_index", chunk_count: 0, blob_size_bytes: 0, indexed_at: null, near_ceiling: false });
		expect(byDomain.vault.note).toBe("not configured");
		for (const d of ["mail", "files", "contacts"]) {
			expect(byDomain[d]).toMatchObject({ chunk_count: 0, blob_size_bytes: 0, indexed_at: null, near_ceiling: false });
			expect(byDomain[d].note).toContain("cold");
		}
		expect(r.alerts).toEqual([]);
		expect(r.ceiling).toMatchObject({ warn_at_chunks: KV_CHUNK_WARN });
	});

	it("reads a packed semantic index's stored size + top-level count + freshness", async () => {
		const kv = makeKv();
		const blob = JSON.stringify({ state: "s", version: 1, at: 4242, total: 3, truncated: false, chunks: [{}, {}, {}] });
		await kv.put("sux:mail:semantic", blob);
		const mail = (await retrievalStats({ OAUTH_KV: kv } as any)).domains.find((d) => d.domain === "mail")!;
		expect(mail).toMatchObject({ store: "packed_index", chunk_count: 3, indexed_at: 4242, near_ceiling: false });
		expect(mail.blob_size_bytes).toBe(new TextEncoder().encode(blob).length);
	});

	it("merges both stores and surfaces near-ceiling domains in alerts", async () => {
		const kv = makeKv();
		const env = { OAUTH_KV: kv } as any;
		await putChunk(env, chunk({ id: "small", domain: "assim:doc", ts: 10 })); // well under the ceiling
		kv.store.set("sux:source:chunk:phi:medical:big", { value: "{}", metadata: { ts: 9, size: KV_BLOB_WARN_BYTES + 1 } });
		const r = await retrievalStats(env);
		const byDomain = Object.fromEntries(r.domains.map((d) => [d.domain, d]));
		expect(byDomain["assim:doc"]).toMatchObject({ store: "chunk_keyspace", chunk_count: 1, near_ceiling: false });
		expect(byDomain["phi:medical"].near_ceiling).toBe(true);
		expect(r.alerts).toContain("phi:medical");
		expect(r.alerts).not.toContain("assim:doc");
	});

	it("notes partial metering when some chunks predate the metadata stamp (self-heal)", async () => {
		const kv = makeKv();
		const env = { OAUTH_KV: kv } as any;
		await putChunk(env, chunk({ id: "new", domain: "assim:scan", ts: 100 })); // metered
		kv.store.set("sux:source:chunk:assim:scan:old", { value: "{}" }); // pre-metering: no metadata
		const scan = (await retrievalStats(env)).domains.find((d) => d.domain === "assim:scan")!;
		expect(scan.chunk_count).toBe(2);
		expect(scan.note).toContain("1/2");
	});
});
