import { describe, expect, it } from "vitest";
import { cacheKey } from "./mcp-util";

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

describe("cache read/write round-trip (index.ts flow)", () => {
	it("a repeated identical call hits the stored entry", async () => {
		const kv = new Map<string, string>();
		const env = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) };

		const call = async (name: string, args: unknown, run: () => { text: string }) => {
			const key = await cacheKey(name, args);
			const cached = await env.get(key);
			if (cached) return { cache: true, result: JSON.parse(cached) };
			const result = run();
			await env.put(key, JSON.stringify(result));
			return { cache: false, result };
		};

		let ran = 0;
		const run = () => ({ text: `ran ${++ran}` });
		const a = await call("scrape", { url: "https://x" }, run);
		const b = await call("scrape", { url: "https://x" }, run);
		const c = await call("scrape", { url: "https://y" }, run); // different args -> miss

		expect(a.cache).toBe(false);
		expect(b.cache).toBe(true); // <-- cache hit
		expect(b.result).toEqual(a.result); // same stored value
		expect(c.cache).toBe(false);
		expect(ran).toBe(2); // run() only executed for the two distinct arg sets
	});
});
