import { describe, expect, it } from "vitest";
import { CACHE_TTL_SECONDS, cacheKey, deferCacheWrite } from "./mcp-util";

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
		const store = new Map<string, { value: string; opts: { expirationTtl: number } }>();
		const kv = {
			put: async (key: string, value: string, opts: { expirationTtl: number }) => {
				await Promise.resolve(); // genuinely async, so a blocking (awaited-inline) write would be visible
				store.set(key, { value, opts });
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
		expect(entry.opts).toEqual({ expirationTtl: CACHE_TTL_SECONDS });
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

		deferCacheWrite(kv, ctx, "cache:k1", result);

		expect(deferred).toHaveLength(0);
		expect("noCache" in result).toBe(false); // internal flag must not leak into the MCP response
	});

	it("strips a falsy noCache flag before the value is stored", async () => {
		const { ctx, deferred } = makeCtx();
		const { kv, store } = makeKv();
		const result = { content: [{ type: "text", text: "ok" }], noCache: false };

		deferCacheWrite(kv, ctx, "cache:k1", result);

		expect("noCache" in result).toBe(false);
		await Promise.all(deferred);
		expect(store.get("cache:k1")!.value).not.toContain("noCache");
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
		const kv = { put: async (k: string, v: string, opts: { expirationTtl: number }) => void store.set(k, { value: v, opts }) };
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
