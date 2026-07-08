import { describe, expect, it, vi } from "vitest";

// Mock the residential fetch seam so the test drives content without a network
// round-trip. select.run (used for the selector reduce) reads inline html and
// never fetches, so it needs no mock.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("", { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { watch } from "./watch";

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
		// The hash was persisted under a sux:watch: key.
		const keys = [...store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^sux:watch:/);
		expect(store.get(keys[0])).toBe(j.hash);
		expect(r.noCache).toBe(true);
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
		expect(store.size).toBe(1);
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
		expect(store.size).toBe(2);
	});

	it("surfaces an upstream failure without throwing", async () => {
		const { env } = fakeEnv();
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("nope", { status: 503 }));
		const r = await watch.run(env, { url: "https://example.com/down" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/\[upstream_error\]/);
	});
});
