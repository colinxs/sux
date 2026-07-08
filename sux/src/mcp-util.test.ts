import { describe, expect, it } from "vitest";
import { CACHE_STALE_GRACE_SECONDS, CACHE_TTL_SECONDS, cacheKey, deferCacheWrite } from "./mcp-util";

// Verifies the content-addressed KV cache mechanism used by index.ts tools/call:
// key = sha256(tool + stable-stringified args), then a single key drives both the
// read (get) and write (put), so identical calls hit.

describe("cacheKey", () => {
	it("is deterministic for identical inputs", async () => {
		expect(await cacheKey("search", { q: "cats", n: 3 })).toBe(await cacheKey("search", { q: "cats", n: 3 }));
	});

	it("is order-independent over argument keys (stable stringify)", async () => {
		expect(await cacheKey("search", { q: "cats", n: 3 })).toBe(await cacheKey("search", { n: 3, q: "cats" }));
	});

	it("differs by tool name and by arguments", async () => {
		expect(await cacheKey("search", { q: "cats" })).not.toBe(await cacheKey("scrape", { q: "cats" }));
		expect(await cacheKey("search", { q: "cats" })).not.toBe(await cacheKey("search", { q: "dogs" }));
	});

	it("produces a namespaced hex key", async () => {
		const k = await cacheKey("t", { a: 1 });
		expect(k).toMatch(/^cache:[0-9a-f]{64}$/);
	});
});

// deferCacheWrite is the real write side of index.ts tools/call: it decides
// cacheability, strips the internal noCache flag, and hands the KV put to
// ctx.waitUntil so the response path never waits on (or fails from) the write.

describe("deferCacheWrite", () => {
	const makeCtx = () => {
		const deferred: Promise<unknown>[] = [];
		return { deferred, ctx: { waitUntil: (p: Promise<unknown>) => void deferred.push(p) } };
	};
	const makeKv = () => {
		const store = new Map<string, { value: string; opts: { expirationTtl: number; metadata?: { softExpiresAt: number } } }>();
		const kv = {
			put: async (key: string, value: string | ArrayBufferView | ArrayBuffer, opts: { expirationTtl: number; metadata?: { softExpiresAt: number } }) => {
				await Promise.resolve(); // genuinely async, so a blocking (awaited-inline) write would be visible
				store.set(key, { value: value as string, opts }); // small test payloads stay plain strings (packForCache passthrough)
			},
		};
		return { store, kv };
	};

	it("writes a successful result through ctx.waitUntil with the cache TTL", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();
		const result = { content: [{ type: "text", text: "hi" }] };

		deferCacheWrite(kv, ctx, "cache:k1", result);

		expect(deferred).toHaveLength(1); // write handed to waitUntil…
		expect(store.size).toBe(0); // …and not yet landed: the response path didn't wait for it
		await Promise.all(deferred);
		const entry = store.get("cache:k1")!;
		expect(JSON.parse(entry.value)).toEqual(result);
		// The KV hard TTL is the soft (fn) lifetime extended by the stale grace window,
		// and the soft-expiry instant rides in metadata (soft lifetime out from now).
		expect(entry.opts.expirationTtl).toBe(CACHE_TTL_SECONDS + CACHE_STALE_GRACE_SECONDS);
		expect(entry.opts.metadata!.softExpiresAt).toBeGreaterThan(Date.now());
		expect(entry.opts.metadata!.softExpiresAt).toBeLessThanOrEqual(Date.now() + CACHE_TTL_SECONDS * 1000);
	});

	it("uses a fn's ttl on the KV write when one is passed", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();

		const before = Date.now();
		deferCacheWrite(kv, ctx, "cache:k1", { content: [{ type: "text", text: "hi" }] }, 300);

		await Promise.all(deferred);
		// Soft TTL = the passed 300s; hard KV TTL extends it by the stale grace window.
		expect(store.get("cache:k1")!.opts.expirationTtl).toBe(300 + CACHE_STALE_GRACE_SECONDS);
		expect(store.get("cache:k1")!.opts.metadata!.softExpiresAt).toBeGreaterThanOrEqual(before + 300 * 1000);
	});

	it("falls back to the global default ttl when a fn passes none", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();

		deferCacheWrite(kv, ctx, "cache:k1", { content: [{ type: "text", text: "hi" }] });

		await Promise.all(deferred);
		expect(store.get("cache:k1")!.opts.expirationTtl).toBe(CACHE_TTL_SECONDS + CACHE_STALE_GRACE_SECONDS);
	});

	it("ignores a non-positive ttl and falls back to the global default", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();

		deferCacheWrite(kv, ctx, "cache:k1", { content: [{ type: "text", text: "hi" }] }, 0);

		await Promise.all(deferred);
		expect(store.get("cache:k1")!.opts.expirationTtl).toBe(CACHE_TTL_SECONDS + CACHE_STALE_GRACE_SECONDS);
	});

	it("never writes isError results", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();

		deferCacheWrite(kv, ctx, "cache:k1", { content: [{ type: "text", text: "boom" }], isError: true });

		expect(deferred).toHaveLength(0);
		await Promise.all(deferred);
		expect(store.size).toBe(0);
	});

	it("never writes noCache results and strips the flag from the response", () => {
		const { ctx, deferred } = makeCtx();
		const { kv } = makeKv();
		const result = { content: [{ type: "text", text: "upstream 503 body" }], noCache: true };

		const cleaned = deferCacheWrite(kv, ctx, "cache:k1", result);

		expect(deferred).toHaveLength(0);
		expect("noCache" in cleaned).toBe(false); // internal flag must not leak into the MCP response
		expect("noCache" in result).toBe(true); // and the shared run result is left untouched
	});

	it("strips a falsy noCache flag before the value is stored", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();
		const result = { content: [{ type: "text", text: "ok" }], noCache: false };

		const cleaned = deferCacheWrite(kv, ctx, "cache:k1", result);

		expect("noCache" in cleaned).toBe(false);
		await Promise.all(deferred);
		expect(store.get("cache:k1")!.value).not.toContain("noCache");
	});

	it("coalesced callers sharing one noCache result never poison the cache", async () => {
		// Single-flight hands the SAME run result to every coalesced caller, and each
		// caller runs the write path once. A noCache upstream-error body must stay
		// uncached no matter how many callers process it — the first caller's strip
		// must not flip a later caller's decision to cacheable (the delete-based
		// version cached the error body as a 2nd-caller success under the normal key).
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();
		const shared = { content: [{ type: "text", text: "upstream 404 body" }], noCache: true };

		const a = deferCacheWrite(kv, ctx, "cache:k1", shared);
		const b = deferCacheWrite(kv, ctx, "cache:k1", shared); // 2nd+ coalesced caller

		expect(deferred).toHaveLength(0); // neither caller scheduled a write
		await Promise.all(deferred);
		expect(store.size).toBe(0); // the error body was never cached
		expect("noCache" in a).toBe(false); // stripped from each caller's response
		expect("noCache" in b).toBe(false);
	});

	it("writes nothing for non-cacheable fns (null key)", () => {
		const { ctx, deferred } = makeCtx();
		const { kv } = makeKv();

		deferCacheWrite(kv, ctx, null, { content: [{ type: "text", text: "ok" }] });

		expect(deferred).toHaveLength(0);
	});

	it("a failed put never rejects the response path", async () => {
		const { ctx, deferred } = makeCtx();
		const kv = {
			put: async () => {
				throw new Error("KV down");
			},
		};

		deferCacheWrite(kv, ctx, "cache:k1", { content: [{ type: "text", text: "ok" }] });

		expect(deferred).toHaveLength(1);
		await expect(deferred[0]).resolves.toBeUndefined(); // swallowed by the trailing .catch
	});
});

describe("cache read/write round-trip (index.ts flow)", () => {
	it("a repeated identical call hits the entry written by deferCacheWrite", async () => {
		const store = new Map<string, { value: string; opts: { expirationTtl: number } }>();
		const kv = { put: async (k: string, v: string | ArrayBufferView | ArrayBuffer, opts: { expirationTtl: number }) => void store.set(k, { value: v as string, opts }) };
		const deferred: Promise<unknown>[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => void deferred.push(p) };

		let ran = 0;
		const call = async (name: string, args: unknown) => {
			const key = await cacheKey(name, args);
			const cached = store.get(key)?.value ?? null;
			if (cached) return { cache: true, result: JSON.parse(cached) };
			const result = { content: [{ type: "text", text: `ran ${++ran}` }] };
			deferCacheWrite(kv, ctx, key, result);
			await Promise.all(deferred); // let the deferred write settle, as the runtime does after responding
			return { cache: false, result };
		};

		const a = await call("scrape", { url: "https://x" });
		const b = await call("scrape", { url: "https://x" });
		const c = await call("scrape", { url: "https://y" }); // different args -> miss

		expect(a.cache).toBe(false);
		expect(b.cache).toBe(true); // <-- cache hit
		expect(b.result).toEqual(a.result); // same stored value
		expect(c.cache).toBe(false);
		expect(ran).toBe(2); // run only executed for the two distinct arg sets
	});
});
