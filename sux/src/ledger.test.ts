import { describe, expect, it } from "vitest";
import { fingerprint, ledger } from "./ledger";

const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};

describe("ledger (idempotency over KV)", () => {
	it("marks and detects seen ids under a namespaced key", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		const l = ledger(env, "sweep");
		expect(await l.seen("a")).toBe(false);
		await l.mark("a");
		expect(await l.seen("a")).toBe(true);
		expect([...kv.store.keys()][0]).toBe("sux:ledger:sweep:a");
		expect(await ledger(env, "other").seen("a")).toBe(false); // namespaces are independent
	});

	it("get returns the marked value, or null when never marked", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const l = ledger(env, "cursor");
		expect(await l.get("offset")).toBe(null);
		await l.mark("offset", "42");
		expect(await l.get("offset")).toBe("42");
	});

	it("markIfNew is true once, then false (the idempotent gate)", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const l = ledger(env, "attach");
		expect(await l.markIfNew("x", "done")).toBe(true);
		expect(await l.markIfNew("x")).toBe(false);
		expect(await l.seen("x")).toBe(true);
	});

	it("degrades to 'always new' with no KV binding (never throws)", async () => {
		const l = ledger({} as any, "ns");
		expect(await l.seen("x")).toBe(false);
		await l.mark("x");
		expect(await l.markIfNew("y")).toBe(true); // can't dedupe without a store
	});

	it("fingerprint is a stable 16-hex digest, differing on content", async () => {
		const a = await fingerprint("hello");
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(await fingerprint("hello")).toBe(a); // stable
		expect(await fingerprint("world")).not.toBe(a);
	});
});
