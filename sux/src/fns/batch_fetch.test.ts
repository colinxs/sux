import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: unknown, url: string) => {
		if (url.includes("boom")) throw new Error("network down");
		if (url.includes("blocked")) return new Response("rate limited", { status: 429 });
		if (url.includes("huge")) return new Response("x", { status: 200, headers: { "content-length": "99999999" } }); // declared > 25MB cap
		if (url.includes("bigtext")) return new Response("y".repeat(3_000_000), { status: 200 }); // 3MB body > FETCH_TEXT_MAX_BYTES
		return new Response(`body of ${url}`, { status: 200 });
	}),
}));

import { batch_fetch } from "./batch_fetch";
import { FETCH_TEXT_MAX_BYTES } from "./_util";

// Minimal R2 + KV mocks (mirrors store.test.ts) so as:"url" can content-address
// bytes into CAS and mint /s/<uuid> handles.
function mockKV() {
	const m = new Map<string, string>();
	return { _m: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
function mockR2() {
	const m = new Map<string, { bytes: Uint8Array; ct?: string; meta?: Record<string, string> }>();
	return {
		_m: m,
		put: async (key: string, value: any, opts?: any) => {
			const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
			m.set(key, { bytes, ct: opts?.httpMetadata?.contentType, meta: opts?.customMetadata });
		},
		get: async (key: string) => {
			const o = m.get(key);
			if (!o) return null;
			return { size: o.bytes.length, httpMetadata: { contentType: o.ct }, customMetadata: o.meta, arrayBuffer: async () => o.bytes.buffer };
		},
	};
}
const mkStoreEnv = () => ({ R2: mockR2(), OAUTH_KV: mockKV() }) as any;
const UUID = /\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("batch_fetch", () => {
	it("rejects a non-array urls value", async () => {
		const r = await batch_fetch.run({} as any, { urls: "http://a.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/`urls` must be an array/);
	});

	it("fetches multiple URLs and returns per-url status/bytes/text", async () => {
		const r = await batch_fetch.run({} as any, { urls: ["https://a.com", "https://b.com"] });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ url: "https://a.com", status: 200 });
		expect(out[0].text).toContain("body of https://a.com");
		expect(out[0].bytes).toBe(out[0].text.length);
	});

	it("flags non-http URLs and isolates per-url fetch failures", async () => {
		const r = await batch_fetch.run({} as any, { urls: ["ftp://nope", "https://boom.com", "https://ok.com"] });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].error).toMatch(/not an absolute http/);
		expect(out[1].error).toMatch(/network down/);
		expect(out[2].status).toBe(200); // survivor
	});

	it("rejects an empty urls array", async () => {
		const r = await batch_fetch.run({} as any, { urls: [] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/must not be empty/);
	});

	it("rejects more than 100 urls (amplification cap) but accepts exactly 100", async () => {
		const many = Array.from({ length: 101 }, (_, i) => `https://a.com/${i}`);
		const over = await batch_fetch.run({} as any, { urls: many });
		expect(over.isError).toBe(true);
		expect(over.content[0].text).toMatch(/Too many urls: 101 \(max 100/);
		const at = await batch_fetch.run({} as any, { urls: many.slice(0, 100) });
		expect(at.isError).toBeFalsy();
		expect(JSON.parse(at.content[0].text)).toHaveLength(100);
	});

	it("marks the batch noCache when any URL errors or comes back 4xx (must not poison the cache)", async () => {
		const bad = await batch_fetch.run({} as any, { urls: ["https://blocked.com", "https://ok.com"] });
		expect(bad.isError).toBeFalsy(); // per-url results are still returned
		expect(JSON.parse(bad.content[0].text)[0].status).toBe(429);
		expect(bad.noCache).toBe(true);
		// Per-url fetch exceptions must not be cached either.
		const thrown = await batch_fetch.run({} as any, { urls: ["https://boom.com", "https://ok.com"] });
		expect(thrown.noCache).toBe(true);
		// An all-2xx batch stays cacheable.
		const good = await batch_fetch.run({} as any, { urls: ["https://a.com", "https://b.com"] });
		expect(good.noCache).toBeUndefined();
	});

	it('as:"url" stores each body to CAS and returns a /s/<uuid> ref instead of text', async () => {
		const env = mkStoreEnv();
		const r = await batch_fetch.run(env, { urls: ["https://a.com", "https://b.com"], as: "url" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out).toHaveLength(2);
		for (const item of out) {
			expect(item.status).toBe(200);
			expect(item.ref).toMatch(UUID);
			expect(item.text).toBeUndefined();
			// bytes reported is the raw stored size.
			expect(item.bytes).toBe(new TextEncoder().encode(`body of ${item.url}`).length);
		}
		// Two distinct bodies → two CAS blobs and two handles.
		expect(env.R2._m.size).toBe(2);
		expect(env.OAUTH_KV._m.size).toBe(2);
		// The stored bytes are the actual response bodies (fetch through the mocked proxy).
		const refUuid = out[0].ref.split("/s/")[1];
		const kvRef = JSON.parse(env.OAUTH_KV._m.get(`store:${refUuid}`));
		expect(new TextDecoder().decode(env.R2._m.get(kvRef.key).bytes)).toBe("body of https://a.com");
	});

	it('as:"url" aborts an oversize body before buffering — reports oversize, stores nothing for it, OOMs nothing', async () => {
		const env = mkStoreEnv();
		const r = await batch_fetch.run(env, { urls: ["https://ex.com/huge", "https://ex.com/ok"], as: "url" });
		const out = JSON.parse(r.content[0].text);
		const huge = out.find((x: any) => x.url.includes("huge"));
		expect(huge.oversize).toBe(true);
		expect(huge.ref).toBeUndefined(); // never stored
		const ok = out.find((x: any) => x.url.includes("ok"));
		expect(ok.ref).toMatch(UUID); // the normal URL still stored
		expect(env.R2._m.size).toBe(1); // only the ok body in CAS, not the huge one
	});

	it('as:"url" isolates per-url failures — a survivor still gets a ref', async () => {
		const env = mkStoreEnv();
		const r = await batch_fetch.run(env, { urls: ["ftp://nope", "https://boom.com", "https://ok.com"], as: "url" });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].error).toMatch(/not an absolute http/);
		expect(out[1].error).toMatch(/network down/);
		expect(out[2].status).toBe(200);
		expect(out[2].ref).toMatch(UUID);
		expect(out[2].text).toBeUndefined();
		// Only the survivor was stored.
		expect(env.R2._m.size).toBe(1);
	});

	it('as:"url" mints a self-expiring handle by default (staging artifacts, not permanent)', async () => {
		const env = mkStoreEnv();
		const r = await batch_fetch.run(env, { urls: ["https://a.com"], as: "url" });
		const out = JSON.parse(r.content[0].text);
		const uuid = out[0].ref.split("/s/")[1];
		const handle = JSON.parse(env.OAUTH_KV._m.get(`store:${uuid}`));
		expect(typeof handle.expiry).toBe("number");
		const now = Math.floor(Date.now() / 1000);
		expect(handle.expiry).toBeGreaterThan(now);
		expect(handle.expiry).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 + 5);
	});

	it("clamps an oversized max_bytes to FETCH_TEXT_MAX_BYTES so a wide batch can't OOM the isolate", async () => {
		const r = await batch_fetch.run({} as any, { urls: ["https://ex.com/bigtext"], max_bytes: 500_000_000 });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out[0].status).toBe(200);
		// Body is 3MB but the returned text is capped at the 2MB ceiling, not the requested 500MB.
		expect(out[0].text.length).toBeLessThanOrEqual(FETCH_TEXT_MAX_BYTES);
		expect(out[0].bytes).toBe(out[0].text.length);
	});

	it("declares the max_bytes ceiling in its schema", () => {
		expect((batch_fetch.inputSchema as any).properties.max_bytes.maximum).toBe(FETCH_TEXT_MAX_BYTES);
	});

	it('as:"url" without the R2 binding fails clearly', async () => {
		const r = await batch_fetch.run({ OAUTH_KV: mockKV() } as any, { urls: ["https://a.com"], as: "url" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/needs the R2 store/);
	});
});
