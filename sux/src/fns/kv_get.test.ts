import { describe, expect, it } from "vitest";
import { kv_get } from "./kv_get";

function fakeEnv(seed: Record<string, string> = {}) {
	const store = new Map(Object.entries(seed));
	return {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
			list: async ({ prefix }: { prefix?: string } = {}) => ({
				keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			}),
		},
	} as any;
}

describe("kv_get", () => {
	it("rejects a key that reaches into reserved space", async () => {
		const r = await kv_get.run(fakeEnv(), { key: "oauth:token" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/reserved space/);
	});

	it("reads a namespaced value", async () => {
		const env = fakeEnv({ "kv:greeting": "hello" });
		const r = await kv_get.run(env, { key: "greeting" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("hello");
	});

	it("trims the key before namespacing", async () => {
		const env = fakeEnv({ "kv:trimmed": "yes" });
		const r = await kv_get.run(env, { key: "  trimmed  " });
		expect(r.content[0].text).toBe("yes");
	});

	it("returns a clear not-found for a missing key", async () => {
		const r = await kv_get.run(fakeEnv(), { key: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not found/);
	});

	it("fails cleanly (not an uncaught throw) on a corrupt compressed value", async () => {
		// A value carrying the `\0gz:` frame prefix but whose base64 is not a valid gzip
		// stream must surface as a fail(), mirroring dropbox/store — never an uncaught reject.
		const env = fakeEnv({ "kv:broken": "\u0000gz:bm90LWd6aXA=" }); // base64 of "not-gzip"
		const r = await kv_get.run(env, { key: "broken" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/could not be decompressed/);
	});
});
