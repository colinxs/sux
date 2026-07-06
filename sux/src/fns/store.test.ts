import { describe, expect, it } from "vitest";
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
		expect(put.url).toBe(`https://sux.colinxs.workers.dev/s/${put.uuid}`);
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

	it("delete removes the handle but keeps the blob", async () => {
		const env = mkEnv();
		const put = j(await store.run(env, { data: "x" }));
		const del = j(await store.run(env, { op: "delete", id: put.uuid }));
		expect(del.deleted).toBe(true);
		expect((await store.run(env, { op: "get", id: put.uuid })).isError).toBe(true);
		expect(env.R2._m.size).toBe(1); // blob retained
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

	it("GET /s/<unknown> is 404", async () => {
		const env = mkEnv();
		const resp = await handleObservability(new URL("https://x/s/does-not-exist"), new Request("https://x/s/does-not-exist"), env);
		expect(resp!.status).toBe(404);
	});
});
