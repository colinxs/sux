import { describe, expect, it, vi } from "vitest";

// Mock the residential fetch seam so the test drives content without a network
// round-trip. select.run (used for the selector reduce) reads inline html and
// never fetches, so it needs no mock.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("", { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { listWatches, watch } from "./watch";

function fakeEnv() {
	const store = new Map<string, string>();
	const env = {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
		},
	} as any;
	return { env, store };
}

function body(text: string) {
	vi.mocked(smartFetch).mockResolvedValueOnce(new Response(text, { status: 200 }));
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("watch", () => {
	it("rejects a non-http(s) url", async () => {
		const { env } = fakeEnv();
		const r = await watch.run(env, { url: "ftp://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/http\(s\)/);
	});

	it("first sight stores the hash and reports first_seen:true, changed:false", async () => {
		const { env, store } = fakeEnv();
		body("<h1>original</h1>");
		const r = await watch.run(env, { url: "https://example.com/a" });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j.first_seen).toBe(true);
		expect(j.changed).toBe(false);
		expect(j.previous_hash).toBeUndefined();
		expect(typeof j.hash).toBe("string");
		expect(j.hash).toHaveLength(64);
		// The hash was persisted under a sux:watch: key, plus the directory index (#899).
		const keys = [...store.keys()];
		expect(keys).toHaveLength(2);
		const hashKey = keys.find((k) => k !== "sux:watch:index")!;
		expect(hashKey).toMatch(/^sux:watch:/);
		expect(store.get(hashKey)).toBe(j.hash);
		expect(r.noCache).toBe(true);
		// The directory index now knows about this watch.
		const index = JSON.parse(store.get("sux:watch:index")!);
		expect(index).toHaveLength(1);
		expect(index[0]).toMatchObject({ url: "https://example.com/a" });
	});

	it("identical content on a later check reports changed:false", async () => {
		const { env, store } = fakeEnv();
		body("<h1>same</h1>");
		const first = parse(await watch.run(env, { url: "https://example.com/b" }));
		body("<h1>same</h1>");
		const second = parse(await watch.run(env, { url: "https://example.com/b" }));
		expect(second.first_seen).toBe(false);
		expect(second.changed).toBe(false);
		expect(second.hash).toBe(first.hash);
		expect(second.previous_hash).toBe(first.hash);
		// A no-change recheck touches neither the hash key nor the directory index (#899).
		expect(store.size).toBe(2);
	});

	it("changed content reports changed:true with previous_hash and updates the store", async () => {
		const { env, store } = fakeEnv();
		body("<h1>before</h1>");
		const first = parse(await watch.run(env, { url: "https://example.com/c" }));
		body("<h1>after</h1>");
		const second = parse(await watch.run(env, { url: "https://example.com/c" }));
		expect(second.first_seen).toBe(false);
		expect(second.changed).toBe(true);
		expect(second.previous_hash).toBe(first.hash);
		expect(second.hash).not.toBe(first.hash);
		// The store now holds the new hash.
		const key = [...store.keys()][0];
		expect(store.get(key)).toBe(second.hash);
	});

	it("reduces to a CSS selector region so noise outside it is ignored", async () => {
		const { env } = fakeEnv();
		body('<div id="price">$10</div><footer>1234 visits</footer>');
		const first = parse(await watch.run(env, { url: "https://example.com/d", selector: "#price" }));
		expect(first.first_seen).toBe(true);
		// Same price, different footer → no change under the #price selector.
		body('<div id="price">$10</div><footer>9999 visits</footer>');
		const second = parse(await watch.run(env, { url: "https://example.com/d", selector: "#price" }));
		expect(second.changed).toBe(false);
		// Price changes → change detected.
		body('<div id="price">$20</div><footer>1 visit</footer>');
		const third = parse(await watch.run(env, { url: "https://example.com/d", selector: "#price" }));
		expect(third.changed).toBe(true);
	});

	it("namespaces distinct labels independently for the same url", async () => {
		const { env, store } = fakeEnv();
		body("<h1>x</h1>");
		await watch.run(env, { url: "https://example.com/e", label: "one" });
		body("<h1>x</h1>");
		const other = parse(await watch.run(env, { url: "https://example.com/e", label: "two" }));
		// A different label is its own watch → first sight, not a comparison.
		expect(other.first_seen).toBe(true);
		expect(other.label).toBe("two");
		// 2 hash keys + the shared directory index.
		expect(store.size).toBe(3);
		const index = JSON.parse(store.get("sux:watch:index")!);
		expect(index).toHaveLength(2);
	});

	it("reset drops the baseline (no fetch) so the next check re-baselines", async () => {
		const { env, store } = fakeEnv();
		body("<h1>seed</h1>");
		const first = parse(await watch.run(env, { url: "https://example.com/r" }));
		expect(first.first_seen).toBe(true);
		expect(store.size).toBe(2);

		// reset deletes the stored hash without fetching (no body() queued), and prunes the
		// directory index entry — with nothing else watched, the index key itself is removed.
		const cleared = parse(await watch.run(env, { url: "https://example.com/r", reset: true }));
		expect(cleared.reset).toBe(true);
		expect(cleared.existed).toBe(true);
		expect(store.size).toBe(0);

		// The next check is a fresh first sight again.
		body("<h1>seed</h1>");
		const reseen = parse(await watch.run(env, { url: "https://example.com/r" }));
		expect(reseen.first_seen).toBe(true);
	});

	it("reset on an unknown watch reports existed:false", async () => {
		const { env } = fakeEnv();
		const r = parse(await watch.run(env, { url: "https://example.com/never", reset: true }));
		expect(r.reset).toBe(true);
		expect(r.existed).toBe(false);
	});

	it("surfaces an upstream failure without throwing", async () => {
		const { env } = fakeEnv();
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("nope", { status: 503 }));
		const r = await watch.run(env, { url: "https://example.com/down" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/\[upstream_error\]/);
	});

	describe("directory index (#899)", () => {
		it("listWatches enumerates every active watch for a cron sweep to re-check", async () => {
			const { env } = fakeEnv();
			body("<h1>a</h1>");
			await watch.run(env, { url: "https://example.com/f", label: "one" });
			body("<h1>b</h1>");
			await watch.run(env, { url: "https://example.com/g" });
			const entries = await listWatches(env);
			expect(entries).toHaveLength(2);
			expect(entries.map((e) => e.url).sort()).toEqual(["https://example.com/f", "https://example.com/g"]);
			expect(entries.find((e) => e.url === "https://example.com/f")?.label).toBe("one");
		});

		it("listWatches degrades to an empty list when nothing is watched", async () => {
			const { env } = fakeEnv();
			expect(await listWatches(env)).toEqual([]);
		});

		it("reset prunes only that watch from the index, leaving others intact", async () => {
			const { env } = fakeEnv();
			body("<h1>a</h1>");
			await watch.run(env, { url: "https://example.com/h" });
			body("<h1>b</h1>");
			await watch.run(env, { url: "https://example.com/i" });
			await watch.run(env, { url: "https://example.com/h", reset: true });
			const entries = await listWatches(env);
			expect(entries).toHaveLength(1);
			expect(entries[0].url).toBe("https://example.com/i");
		});

		it("a no-change recheck leaves the index entry as-is (no extra KV write)", async () => {
			const { env } = fakeEnv();
			body("<h1>same</h1>");
			await watch.run(env, { url: "https://example.com/j" });
			const before = await listWatches(env);
			body("<h1>same</h1>");
			await watch.run(env, { url: "https://example.com/j" });
			const after = await listWatches(env);
			expect(after).toEqual(before);
		});
	});
});
