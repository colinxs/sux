import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_PER_SWEEP, hasWatchSweep, lastWatchFindings, maxPerSweep, runWatchSweep, type WatchCheckResult, type WatchSweepDeps } from "./_watch_sweep";
import type { WatchIndexEntry } from "./watch";

// A single OAUTH_KV stub for the ledger — mirrors _consolidate.test.ts's fakeKV. The whole
// feature is exercised through injected deps: no real watch fn, no real fetch.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), ...flags }) as any;

const entry = (url: string, over: Partial<WatchIndexEntry> = {}): WatchIndexEntry => ({ keyId: url, url, lastChecked: "2026-07-01T00:00:00.000Z", ...over });

function mkDeps(entries: WatchIndexEntry[], results: Record<string, WatchCheckResult>): WatchSweepDeps & { checked: string[] } {
	const checked: string[] = [];
	return {
		checked,
		listWatches: async () => entries,
		checkWatch: async (_env, e) => {
			checked.push(e.url);
			const r = results[e.url];
			if (!r) throw new Error(`no fake result for ${e.url}`);
			return r;
		},
	};
}

const unchanged = (hash = "h"): WatchCheckResult => ({ changed: false, first_seen: false, hash });
const changed = (hash: string, previous: string): WatchCheckResult => ({ changed: true, first_seen: false, hash, previous_hash: previous });

describe("gate — fail-closed", () => {
	it("hasWatchSweep is off unless WATCH_SWEEP_ENABLED is truthy", () => {
		for (const v of [undefined, "", "0", "false", "no", "off"]) expect(hasWatchSweep({ WATCH_SWEEP_ENABLED: v } as any)).toBe(false);
		for (const v of ["1", "true", "on", "yes"]) expect(hasWatchSweep({ WATCH_SWEEP_ENABLED: v } as any)).toBe(true);
	});
});

describe("maxPerSweep", () => {
	it("defaults to DEFAULT_MAX_PER_SWEEP when unset or invalid", () => {
		expect(maxPerSweep(envWith())).toBe(DEFAULT_MAX_PER_SWEEP);
		expect(maxPerSweep(envWith({ WATCH_SWEEP_MAX: "not-a-number" }))).toBe(DEFAULT_MAX_PER_SWEEP);
		expect(maxPerSweep(envWith({ WATCH_SWEEP_MAX: "-3" }))).toBe(DEFAULT_MAX_PER_SWEEP);
	});
	it("honors a valid override, clamped to 50", () => {
		expect(maxPerSweep(envWith({ WATCH_SWEEP_MAX: "5" }))).toBe(5);
		expect(maxPerSweep(envWith({ WATCH_SWEEP_MAX: "500" }))).toBe(50);
	});
});

describe("runWatchSweep", () => {
	it("is a dormant no-op unless enabled — never lists or checks a watch", async () => {
		const deps = mkDeps([entry("https://a")], { "https://a": unchanged() });
		const report = await runWatchSweep(envWith(), {}, deps);
		expect(report.dormant).toBe(true);
		expect(deps.checked).toEqual([]);
	});

	it("reports no active watches without error when the directory is empty", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		const deps = mkDeps([], {});
		const report = await runWatchSweep(env, {}, deps);
		expect(report.checked).toBe(0);
		expect(report.total_watches).toBe(0);
		expect(report.changed).toEqual([]);
	});

	it("re-checks every watch when under the per-sweep cap, and surfaces only the changed ones", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		const deps = mkDeps(
			[entry("https://a"), entry("https://b", { label: "price" }), entry("https://c")],
			{ "https://a": unchanged(), "https://b": changed("new", "old"), "https://c": unchanged() },
		);
		const report = await runWatchSweep(env, {}, deps);
		expect(deps.checked.sort()).toEqual(["https://a", "https://b", "https://c"]);
		expect(report.changed).toEqual([{ url: "https://b", label: "price", hash: "new", previous_hash: "old", checked_at: expect.any(String) }]);
	});

	it("forwards each entry's threshold/thresholdPct (#1091) to checkWatch so a numeric-mode watch stays noise-filtered under the sweep", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		const seen: Array<{ url: string; threshold?: number; thresholdPct?: number }> = [];
		const deps: WatchSweepDeps = {
			listWatches: async () => [entry("https://price", { threshold: 10, thresholdPct: 5 })],
			checkWatch: async (_env, e) => {
				seen.push({ url: e.url, threshold: e.threshold, thresholdPct: e.thresholdPct });
				return unchanged();
			},
		};
		await runWatchSweep(env, {}, deps);
		expect(seen).toEqual([{ url: "https://price", threshold: 10, thresholdPct: 5 }]);
	});

	it("bounds the per-tick check count and rotates the window on the next tick", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		const entries = [entry("https://1"), entry("https://2"), entry("https://3")];
		const results = { "https://1": unchanged(), "https://2": unchanged(), "https://3": unchanged() };
		const first = await runWatchSweep(env, { max: 2 }, mkDeps(entries, results));
		expect(first.checked).toBe(2);
		expect(first.window_offset).toBe(0);
		expect(first.next_offset).toBe(2);

		const secondDeps = mkDeps(entries, results);
		const second = await runWatchSweep(env, { max: 2 }, secondDeps);
		expect(second.window_offset).toBe(2);
		// Wraps: offset 2 covers index 2, then wraps back to index 0.
		expect(secondDeps.checked.sort()).toEqual(["https://1", "https://3"]);
	});

	it("one unreachable watch is skipped, not fatal to the rest of the tick", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		const deps: WatchSweepDeps = {
			listWatches: async () => [entry("https://ok"), entry("https://down")],
			checkWatch: async (_e, en) => {
				if (en.url === "https://down") throw new Error("upstream down");
				return changed("h2", "h1");
			},
		};
		const report = await runWatchSweep(env, {}, deps);
		expect(report.changed).toEqual([{ url: "https://ok", hash: "h2", previous_hash: "h1", checked_at: expect.any(String) }]);
	});

	it("caches the sweep's findings for lastWatchFindings to read (the agenda loop's feed)", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		expect(await lastWatchFindings(env)).toBeNull();
		const deps = mkDeps([entry("https://a")], { "https://a": changed("new", "old") });
		await runWatchSweep(env, {}, deps);
		const findings = await lastWatchFindings(env);
		expect(findings?.changed_count).toBe(1);
		expect(findings?.changed[0]).toMatchObject({ url: "https://a", hash: "new", previous_hash: "old" });
	});

	it("surfaces a listWatches failure as an error report rather than throwing", async () => {
		const env = envWith({ WATCH_SWEEP_ENABLED: "1" });
		const deps: WatchSweepDeps = { listWatches: async () => { throw new Error("KV down"); }, checkWatch: vi.fn() };
		const report = await runWatchSweep(env, {}, deps);
		expect(report.error).toMatch(/KV down/);
	});
});
