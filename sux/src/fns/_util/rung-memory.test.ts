import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { learnedRung, recordRung, rungAtLeast } from "./rung-memory";

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		kv: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
		},
	};
}

describe("rung-memory", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0.99)); // never land in the reprobe fraction
	afterEach(() => vi.restoreAllMocks());

	it("returns null with no KV bound", async () => {
		expect(await learnedRung({} as any, "https://example.com")).toBeNull();
	});

	it("returns null for an unlearned domain", async () => {
		const { kv } = fakeKv();
		expect(await learnedRung({ OAUTH_KV: kv } as any, "https://example.com")).toBeNull();
	});

	it("round-trips a recorded rung", async () => {
		const { kv } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		await recordRung(env, "https://example.com/page", "render");
		expect(await learnedRung(env, "https://example.com/other-page")).toBe("render");
	});

	it("scopes by domain, not full URL", async () => {
		const { kv } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		await recordRung(env, "https://a.example.com/x", "unlocker");
		expect(await learnedRung(env, "https://b.example.com/y")).toBeNull();
	});

	it("treats a stale entry as unlearned (self-heals)", async () => {
		const { kv, store } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		store.set("rung:example.com", JSON.stringify({ rung: "unlocker", at: 0 }));
		expect(await learnedRung(env, "https://example.com")).toBeNull();
	});

	it("ignores a live entry during the periodic re-probe fraction", async () => {
		const { kv } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		await recordRung(env, "https://example.com", "unlocker");
		vi.spyOn(Math, "random").mockReturnValue(0); // always lands in the reprobe fraction
		expect(await learnedRung(env, "https://example.com")).toBeNull();
	});

	it("never throws on a malformed stored value", async () => {
		const { kv, store } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		store.set("rung:example.com", "not json");
		expect(await learnedRung(env, "https://example.com")).toBeNull();
	});

	it("does not let a cheaper rung downgrade a live learned pin", async () => {
		const { kv } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		await recordRung(env, "https://example.com/product", "unlocker");
		await recordRung(env, "https://example.com/robots.txt", "scrape");
		expect(await learnedRung(env, "https://example.com")).toBe("unlocker");
	});

	it("still allows an upgrade to a more expensive rung", async () => {
		const { kv } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		await recordRung(env, "https://example.com/product", "render");
		await recordRung(env, "https://example.com/product", "unlocker");
		expect(await learnedRung(env, "https://example.com")).toBe("unlocker");
	});

	it("allows a downgrade once the existing pin has expired", async () => {
		const { kv, store } = fakeKv();
		const env = { OAUTH_KV: kv } as any;
		store.set("rung:example.com", JSON.stringify({ rung: "unlocker", at: 0 }));
		await recordRung(env, "https://example.com/robots.txt", "scrape");
		expect(await learnedRung(env, "https://example.com")).toBe("scrape");
	});

	it("rungAtLeast orders scrape < render < unlocker", () => {
		expect(rungAtLeast("unlocker", "render")).toBe(true);
		expect(rungAtLeast("render", "unlocker")).toBe(false);
		expect(rungAtLeast("render", "render")).toBe(true);
		expect(rungAtLeast("scrape", "render")).toBe(false);
	});
});
