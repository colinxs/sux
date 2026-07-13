import { describe, expect, it, vi } from "vitest";
import { store } from "./store";
import { handleObservability } from "../observability";

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
			return { size: o.bytes.length, httpMetadata: { contentType: o.ct }, customMetadata: o.meta, text: async () => new TextDecoder().decode(o.bytes), arrayBuffer: async () => o.bytes.buffer };
		},
		head: async () => null,
		delete: async (key: string) => void m.delete(key),
		list: async (opts?: any) => {
			let keys = [...m.keys()];
			if (opts?.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix));
			return { objects: keys.slice(0, opts?.limit ?? 100).map((k) => ({ key: k, size: m.get(k)!.bytes.length })), truncated: false };
		},
	};
}
const mkEnv = () => ({ R2: mockR2(), OAUTH_KV: mockKV() }) as any;
const j = (r: any) => JSON.parse(r.content[0].text);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe("store", () => {
	it("degrades gracefully without the R2 binding", async () => {
		const r = await store.run({ OAUTH_KV: mockKV() } as any, { data: "hi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/R2 is not available/);
	});

	it("put returns a url ending in a uuid and maps it in KV; get by id round-trips", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "hello world" }));
		expect(put.key).toBe(`cas/${put.sha256}`);
		expect(put.size).toBe(11);
		expect(put.uuid).toMatch(UUID);
		expect(put.url).toBe(`https://suxos.net/s/${put.uuid}`);
		expect(env.OAUTH_KV._m.has(`store:${put.uuid}`)).toBe(true);
		const got = j(await store.run(env, { op: "get", id: put.uuid }));
		expect(got.text).toBe("hello world");
		// Also resolvable from the full URL.
		const got2 = j(await store.run(env, { op: "get", id: put.url }));
		expect(got2.text).toBe("hello world");
	});

	it("content-addresses: identical content dedupes to one blob but mints distinct handles", async () => {
		const env = mkEnv();
		const a = j(await store.run(env, { data: "same" }));
		const b = j(await store.run(env, { data: "same" }));
		expect(a.key).toBe(b.key);
		expect(a.uuid).not.toBe(b.uuid);
		expect(env.R2._m.size).toBe(1);
		expect(env.OAUTH_KV._m.size).toBe(2);
	});

	it("stores and returns binary as base64", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { base64: btoa("\x00\x01\x02"), content_type: "application/octet-stream" }));
		const got = j(await store.run(env, { op: "get", id: put.uuid }));
		expect(got.base64).toBe(btoa("\x00\x01\x02"));
	});

	it("put with neither data nor base64 fails", async () => {
		const r = await store.run(mkEnv(), { op: "put" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/put needs `data`/);
	});

	it("rejects an unknown op", async () => {
		const r = await store.run(mkEnv(), { op: "zap" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown op 'zap'/);
	});

	it("get by raw key falls back to the object's stored content type (text branch)", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: '{"a":1}', content_type: "application/json" }));
		const got = j(await store.run(env, { op: "get", key: put.key }));
		expect(got.key).toBe(put.key);
		expect(got.content_type).toBe("application/json");
		expect(got.text).toBe('{"a":1}');
		expect(got.base64).toBeUndefined();
	});

	it("get by raw key defaults to octet-stream (base64 branch) when the object has no content type", async () => {
		const env = mkEnv();
		env.R2._m.set("raw/no-ct", { bytes: new Uint8Array([0, 1, 2]) }); // no httpMetadata contentType
		const got = j(await store.run(env, { op: "get", key: "raw/no-ct" }));
		expect(got.content_type).toBe("application/octet-stream");
		expect(got.base64).toBe(btoa("\x00\x01\x02"));
		expect(got.text).toBeUndefined();
	});

	it("get by a missing raw key fails", async () => {
		const r = await store.run(mkEnv(), { op: "get", key: "cas/nothing" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/No object at key 'cas\/nothing'/);
	});

	it("list filters by prefix over raw R2 keys", async () => {
		const env = mkEnv();
		await store.run(env, { data: "one" });
		await store.run(env, { data: "two" });
		env.R2._m.set("other/misc", { bytes: new Uint8Array([1]) });
		const all = j(await store.run(env, { op: "list" }));
		expect(all.objects).toHaveLength(3);
		expect(all.truncated).toBe(false);
		const cas = j(await store.run(env, { op: "list", prefix: "cas/" }));
		expect(cas.objects).toHaveLength(2);
		expect(cas.objects.every((o: any) => o.key.startsWith("cas/"))).toBe(true);
	});

	it("list clamps limit into [1, 1000] and defaults to 100", async () => {
		const env = mkEnv();
		await store.run(env, { data: "a" });
		await store.run(env, { data: "b" });
		const spy = vi.spyOn(env.R2, "list");
		const one = j(await store.run(env, { op: "list", limit: -5 }));
		expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));
		expect(one.objects).toHaveLength(1); // the clamp is observable, not just passed through
		await store.run(env, { op: "list", limit: 5000 });
		expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1000 }));
		await store.run(env, { op: "list", limit: 0 });
		expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 })); // falsy -> default
	});

	it("list passes truncated and cursor through from R2", async () => {
		const env = mkEnv();
		env.R2.list = async () => ({ objects: [{ key: "cas/x", size: 1, uploaded: "2026-01-01T00:00:00Z" }], truncated: true, cursor: "next-page" });
		const out = j(await store.run(env, { op: "list" }));
		expect(out.objects).toEqual([{ key: "cas/x", size: 1, uploaded: "2026-01-01T00:00:00Z" }]);
		expect(out.truncated).toBe(true);
		expect(out.cursor).toBe("next-page");
	});

	it("delete removes the handle but keeps the blob", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "x" }));
		const del = j(await store.run(env, { op: "delete", id: put.uuid }));
		expect(del.deleted).toBe(true);
		expect((await store.run(env, { op: "get", id: put.uuid })).isError).toBe(true);
		expect(env.R2._m.size).toBe(1); // blob retained
	});

	it("get by id of an over-4MB object returns the url ref and never inlines (texty branch)", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "small", content_type: "text/plain" }));
		const text = vi.fn(async () => "small");
		const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);
		env.R2.get = async () => ({ size: 5 * 1024 * 1024, httpMetadata: { contentType: "text/plain" }, customMetadata: {}, text, arrayBuffer });
		const got = j(await store.run(env, { op: "get", id: put.uuid }));
		expect(got.url).toBe(put.url);
		expect(got.key).toBe(put.key);
		expect(got.sha256).toBe(put.sha256);
		expect(got.size).toBe(5 * 1024 * 1024);
		expect(got.content_type).toBe("text/plain");
		expect(got.note).toMatch(/too large|inline limit/);
		expect(got.text).toBeUndefined();
		expect(got.base64).toBeUndefined();
		expect(text).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("get by raw key of an over-4MB binary object mints a handle and returns the url ref", async () => {
		const env = mkEnv();
		const text = vi.fn(async () => "x");
		const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);
		env.R2.get = async () => ({ size: 4 * 1024 * 1024 + 1, httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { sha256: "abc123" }, text, arrayBuffer });
		const got = j(await store.run(env, { op: "get", key: "cas/abc123" }));
		expect(got.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(got.sha256).toBe("abc123");
		expect(got.base64).toBeUndefined();
		expect(text).not.toHaveBeenCalled();
		expect(arrayBuffer).not.toHaveBeenCalled();
		// The minted handle resolves in KV.
		const uuid = got.url.split("/s/")[1];
		expect(JSON.parse(env.OAUTH_KV._m.get(`store:${uuid}`)!)).toMatchObject({ key: "cas/abc123", size: 4 * 1024 * 1024 + 1 });
	});

	it("get at exactly the 4MB threshold still inlines", async () => {
		const env = mkEnv();
		// Read as bytes (uniformly, so a gzip marker can be detected); a raw/unmarked
		// object decodes straight back to its text.
		const arrayBuffer = vi.fn(async () => new TextEncoder().encode("body").buffer);
		env.R2.get = async () => ({ size: 4 * 1024 * 1024, httpMetadata: { contentType: "text/plain" }, customMetadata: {}, arrayBuffer });
		const got = j(await store.run(env, { op: "get", key: "cas/x" }));
		expect(got.text).toBe("body");
		expect(arrayBuffer).toHaveBeenCalled();
	});

	it("GET /s/<uuid> serves the stored bytes with its content type", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "page body", content_type: "text/plain" }));
		const resp = await handleObservability(new URL(put.url), new Request(put.url), env);
		expect(resp).toBeTruthy();
		expect(resp!.status).toBe(200);
		expect(resp!.headers.get("content-type")).toMatch(/text\/plain/);
		expect(await resp!.text()).toBe("page body");
	});

	it("put with no ttl_seconds mints a permanent handle (no expiry) — backward compatible", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "forever" }));
		expect(put.expiry).toBeUndefined();
		expect(JSON.parse(env.OAUTH_KV._m.get(`store:${put.uuid}`)!).expiry).toBeUndefined();
	});

	it("put with ttl_seconds records an absolute expiry and sets KV expirationTtl; still readable before it lapses", async () => {
		const env = mkEnv();
		const spy = vi.spyOn(env.OAUTH_KV, "put");
		const put = j(await store.run(env, { data: "ephemeral", ttl_seconds: 3600 }));
		expect(put.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
		// The handle JSON carries the same expiry, and KV self-evicts via expirationTtl.
		expect(JSON.parse(env.OAUTH_KV._m.get(`store:${put.uuid}`)!).expiry).toBe(put.expiry);
		expect(spy).toHaveBeenCalledWith(`store:${put.uuid}`, expect.any(String), expect.objectContaining({ expirationTtl: 3600 }));
		expect(j(await store.run(env, { op: "get", id: put.uuid })).text).toBe("ephemeral");
	});

	it("rejects a non-positive ttl_seconds", async () => {
		const r = await store.run(mkEnv(), { data: "x", ttl_seconds: 0 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/ttl_seconds must be a positive integer/);
	});

	it("sub-60s ttl_seconds records the expiry but skips expirationTtl (KV's 60s floor)", async () => {
		const env = mkEnv();
		const spy = vi.spyOn(env.OAUTH_KV, "put");
		const put = j(await store.run(env, { data: "blink", ttl_seconds: 30 }));
		expect(put.expiry).toBe(Math.floor(Date.now() / 1000) + 30);
		expect(spy).toHaveBeenCalledWith(`store:${put.uuid}`, expect.any(String), undefined);
	});

	it("get of an expired handle is not-found and best-effort deletes the handle", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "gone soon", ttl_seconds: 60 }));
		// Simulate KV expiry lapsing: rewind the handle's absolute expiry into the past.
		const key = `store:${put.uuid}`;
		const handle = JSON.parse(env.OAUTH_KV._m.get(key)!);
		handle.expiry = Math.floor(Date.now() / 1000) - 1;
		env.OAUTH_KV._m.set(key, JSON.stringify(handle));
		const r = await store.run(env, { op: "get", id: put.uuid });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/expired/);
		expect(env.OAUTH_KV._m.has(key)).toBe(false); // best-effort deleted
		// The content-addressed blob itself is retained (may be shared).
		expect(env.R2._m.size).toBe(1);
	});

	it("GET /s/<uuid> of an expired handle is 404 and reaps the handle", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "expiring page", ttl_seconds: 60 }));
		const key = `store:${put.uuid}`;
		const handle = JSON.parse(env.OAUTH_KV._m.get(key)!);
		handle.expiry = Math.floor(Date.now() / 1000) - 1;
		env.OAUTH_KV._m.set(key, JSON.stringify(handle));
		const resp = await handleObservability(new URL(put.url), new Request(put.url), env);
		expect(resp!.status).toBe(404);
		expect(env.OAUTH_KV._m.has(key)).toBe(false);
	});

	it("transparently gzips a large text blob in R2 and inflates it on get + /s/", async () => {
		const env = mkEnv();
		const body = "sux transparent compression round-trip. ".repeat(300);
		const put = j(await store.run(env, { data: body, content_type: "text/plain" }));
		// R2 holds the compressed frame (marker + gzip magic), smaller than the input.
		const stored = env.R2._m.get(put.key)!.bytes;
		expect(stored.length).toBeLessThan(new TextEncoder().encode(body).length);
		expect(stored[0]).toBe(0x00);
		expect(stored[1]).toBe(0x1f);
		expect(stored[2]).toBe(0x8b);
		// get inflates back to the original text.
		expect(j(await store.run(env, { op: "get", id: put.uuid })).text).toBe(body);
		// The public /s/ route serves the ORIGINAL bytes to external consumers.
		const resp = await handleObservability(new URL(put.url), new Request(put.url), env);
		expect(await resp!.text()).toBe(body);
	});

	it("GET /s/<unknown> is 404", async () => {
		const env = mkEnv();
		const resp = await handleObservability(new URL("https://x/s/does-not-exist"), new Request("https://x/s/does-not-exist"), env);
		expect(resp!.status).toBe(404);
	});
});
