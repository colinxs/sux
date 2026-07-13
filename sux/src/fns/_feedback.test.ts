import { describe, expect, it } from "vitest";
import { appendFeedback, readFeedback } from "./_feedback";

// A KV whose get/put yield to the event loop, so two unserialized read-modify-writes
// of the same key would interleave and lose an update. appendFeedback serializes them.
function racyEnv() {
	const store = new Map<string, string>();
	const tick = () => new Promise<void>((r) => setTimeout(r, 0));
	return {
		store,
		OAUTH_KV: {
			get: async (k: string) => {
				await tick();
				return store.get(k) ?? null;
			},
			put: async (k: string, v: string) => {
				await tick();
				store.set(k, v);
			},
		},
	} as any;
}

describe("appendFeedback — concurrency", () => {
	it("does not lose entries when many appends race in one isolate", async () => {
		const env = racyEnv();
		await Promise.all(Array.from({ length: 8 }, (_, i) => appendFeedback(env, "issue", `note ${i}`)));
		const items = await readFeedback(env, "issue", 100);
		expect(items).toHaveLength(8);
		expect(new Set(items.map((i) => i.text)).size).toBe(8);
	});

	it("returns a strictly incrementing total across serialized racing appends", async () => {
		const env = racyEnv();
		const totals = (await Promise.all(Array.from({ length: 5 }, () => appendFeedback(env, "suggest", "x")))).map((r) => r.total).sort((a, b) => a - b);
		expect(totals).toEqual([1, 2, 3, 4, 5]);
	});
});
