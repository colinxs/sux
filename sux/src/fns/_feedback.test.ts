import { describe, expect, it } from "vitest";
import { appendFeedback, readFeedback, resolveFeedback } from "./_feedback";

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

describe("resolveFeedback", () => {
	it("marks the matching unresolved entry resolved and stamps tracked_by", async () => {
		const env = racyEnv();
		await appendFeedback(env, "issue", "note a");
		await appendFeedback(env, "issue", "note b");
		const [newer] = await readFeedback(env, "issue", 10);
		expect(await resolveFeedback(env, "issue", newer.at, "https://github.com/x/y/issues/1")).toBe(true);

		const all = await readFeedback(env, "issue", 10);
		const resolved = all.find((i) => i.at === newer.at)!;
		expect(resolved.resolved).toBe(true);
		expect(resolved.tracked_by).toBe("https://github.com/x/y/issues/1");
		// the other entry is untouched
		expect(all.find((i) => i.at !== newer.at)!.resolved).toBeUndefined();
	});

	it("returns false for an already-resolved or nonexistent entry, and is a no-op write", async () => {
		const env = racyEnv();
		await appendFeedback(env, "issue", "note a");
		const [entry] = await readFeedback(env, "issue", 10);
		expect(await resolveFeedback(env, "issue", entry.at)).toBe(true);
		expect(await resolveFeedback(env, "issue", entry.at)).toBe(false); // already resolved
		expect(await resolveFeedback(env, "issue", 999999)).toBe(false); // no such entry
	});

	it("readFeedback's unresolvedOnly filters out resolved entries", async () => {
		const env = racyEnv();
		await appendFeedback(env, "issue", "note a");
		await appendFeedback(env, "issue", "note b");
		const [newer] = await readFeedback(env, "issue", 10);
		await resolveFeedback(env, "issue", newer.at);

		const unresolved = await readFeedback(env, "issue", 10, undefined, { unresolvedOnly: true });
		expect(unresolved).toHaveLength(1);
		expect(unresolved[0].at).not.toBe(newer.at);

		// default (unresolvedOnly omitted) still returns everything — a display concern only.
		expect(await readFeedback(env, "issue", 10)).toHaveLength(2);
	});
});
