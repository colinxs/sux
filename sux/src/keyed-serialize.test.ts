import { describe, expect, it } from "vitest";
import { keyedSerialize } from "./keyed-serialize";

// A shared "KV cell" whose read and write both yield to the event loop, so an
// unserialized read-modify-write of two concurrent callers WOULD interleave and lose
// an update. keyedSerialize must prevent that.
function racyCell(initial = 0) {
	let value = initial;
	const tick = () => new Promise<void>((r) => setTimeout(r, 0));
	return {
		get: async () => {
			await tick();
			return value;
		},
		put: async (v: number) => {
			await tick();
			value = v;
		},
	};
}

describe("keyedSerialize", () => {
	it("serializes concurrent same-key read-modify-writes so no update is lost", async () => {
		const cell = racyCell(0);
		const chains = new Map<string, Promise<unknown>>();
		const inc = () =>
			keyedSerialize(chains, "k", async () => {
				const v = await cell.get();
				await cell.put(v + 1);
			});
		// Fire ten in parallel; without serialization the interleaved reads collapse to ~1.
		await Promise.all(Array.from({ length: 10 }, inc));
		expect(await cell.get()).toBe(10);
	});

	it("runs different keys independently (no cross-key blocking)", async () => {
		const chains = new Map<string, Promise<unknown>>();
		const order: string[] = [];
		const a = keyedSerialize(chains, "a", async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push("a");
		});
		const b = keyedSerialize(chains, "b", async () => {
			order.push("b");
		});
		await Promise.all([a, b]);
		// b's key is free, so it finishes before a's 20ms task despite being queued after.
		expect(order).toEqual(["b", "a"]);
	});

	it("propagates a task's rejection to its caller but keeps the chain alive for followers", async () => {
		const chains = new Map<string, Promise<unknown>>();
		const boom = keyedSerialize(chains, "k", async () => {
			throw new Error("boom");
		});
		await expect(boom).rejects.toThrow("boom");
		// A follower on the same key still runs after the failed one settles.
		const after = keyedSerialize(chains, "k", async () => 42);
		expect(await after).toBe(42);
	});

	it("garbage-collects the chain entry once the last queued task settles", async () => {
		const chains = new Map<string, Promise<unknown>>();
		await keyedSerialize(chains, "k", async () => {});
		// Let the settle/finally microtasks flush.
		await new Promise((r) => setTimeout(r, 0));
		expect(chains.has("k")).toBe(false);
	});
});
