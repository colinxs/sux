import { describe, expect, it } from "vitest";
import { applyEvent, clipErr, emptyMetrics, mergeMetrics, percentile, readMetrics, recordCall, sloReport, TOOLS_CAP, toPrometheus } from "./metrics";

describe("metrics", () => {
	it("folds events into per-tool + global aggregates", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "search", ms: 100 });
		applyEvent(m, { tool: "search", ms: 200, cache: true });
		applyEvent(m, { tool: "dns", ms: 50, error: true });

		expect(m.total).toBe(3);
		expect(m.cache_hits).toBe(1);
		expect(m.errors).toBe(1);
		expect(m.tools.search).toEqual({ calls: 2, errors: 0, cache_hits: 1, total_ms: 300 });
		expect(m.tools.dns).toEqual({ calls: 1, errors: 1, cache_hits: 0, total_ms: 50 });
	});

	it("records why calls fail: err in the log entry + last_error per tool", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "dns", ms: 50, error: true, err: "upstream 500" });
		expect(m.recent[0].err).toBe("upstream 500");
		expect(m.tools.dns.last_error).toBe("upstream 500");
		// success events don't carry err
		applyEvent(m, { tool: "dns", ms: 10 });
		expect(m.recent[0].err).toBeUndefined();
		expect(m.tools.dns.last_error).toBe("upstream 500"); // sticky until next error
	});

	it("clips error messages to ~200 chars", () => {
		expect(clipErr(undefined)).toBeUndefined();
		expect(clipErr("")).toBeUndefined();
		expect(clipErr("short")).toBe("short");
		expect(clipErr("x".repeat(500))).toHaveLength(200);
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "t", ms: 1, error: true, err: "y".repeat(500) });
		expect(m.recent[0].err).toHaveLength(200);
		expect(m.tools.t.last_error).toHaveLength(200);
	});

	it("caps the rolling log at 500", () => {
		const m = emptyMetrics(0);
		for (let i = 0; i < 510; i++) applyEvent(m, { tool: "t", ms: 1 });
		expect(m.recent).toHaveLength(500);
		expect(m.total).toBe(510); // lifetime counter unaffected by the cap
	});

	it("rolls up per-tool counters so the doc stays bounded, preserving totals", () => {
		const m = emptyMetrics(0);
		// A hot tool that must survive as its own series...
		for (let i = 0; i < 50; i++) applyEvent(m, { tool: "search", ms: 10, cache: true });
		// ...plus a flood of distinct one-off tool names that must be rolled up.
		for (let i = 0; i < 1000; i++) applyEvent(m, { tool: `oneoff-${i}`, ms: 2, error: i % 2 === 0, cache: i % 3 === 0 });

		const names = Object.keys(m.tools);
		// Cardinality is capped and the excess collapsed into the reserved bucket.
		expect(names.length).toBeLessThanOrEqual(TOOLS_CAP);
		expect(names).toContain("__other__");
		expect(m.tools.search.calls).toBe(50); // busy tool survives intact
		// Rolling log stays bounded regardless of how many events landed.
		expect(m.recent.length).toBeLessThanOrEqual(500);

		// Lifetime totals are exact: nothing lost, only re-bucketed.
		expect(m.total).toBe(1050);
		const sum = (pick: (t: { calls: number; errors: number; cache_hits: number; total_ms: number }) => number) => Object.values(m.tools).reduce((a, t) => a + pick(t), 0);
		expect(sum((t) => t.calls)).toBe(1050);
		expect(sum((t) => t.errors)).toBe(m.errors);
		expect(sum((t) => t.cache_hits)).toBe(m.cache_hits);
		// 50 hot (10ms) + 1000 oneoff (2ms) = 500 + 2000 = 2500ms of latency, all retained.
		expect(sum((t) => t.total_ms)).toBe(2500);
	});

	it("keeps rolling up idempotently across further writes once at the cap", () => {
		const m = emptyMetrics(0);
		for (let i = 0; i < 1000; i++) applyEvent(m, { tool: `t${i}`, ms: 1 });
		expect(Object.keys(m.tools).length).toBeLessThanOrEqual(TOOLS_CAP);
		// More distinct tools after the cap is reached: still bounded, still exact.
		for (let i = 1000; i < 1200; i++) applyEvent(m, { tool: `t${i}`, ms: 1 });
		expect(Object.keys(m.tools).length).toBeLessThanOrEqual(TOOLS_CAP);
		expect(m.total).toBe(1200);
		expect(Object.values(m.tools).reduce((a, t) => a + t.calls, 0)).toBe(1200);
	});

	it("folds per-route fetch tallies into the aggregate and the log entry", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "fetch", ms: 100, routes: { proxied: 2, direct: 1 } });
		applyEvent(m, { tool: "fetch", ms: 50, routes: { proxied: 1, proxy_fallback: 1 } });
		applyEvent(m, { tool: "calc", ms: 5 }); // no fetches → no routes
		expect(m.routes).toEqual({ proxied: 3, direct: 1, proxy_fallback: 1 });
		expect(m.recent[2].routes).toEqual({ proxied: 2, direct: 1 });
		expect(m.recent[0].routes).toBeUndefined();
	});

	it("tolerates pre-route Metrics records (no routes field)", () => {
		const m = emptyMetrics(0);
		// biome-ignore lint/suspicious/noExplicitAny: simulate an old KV record
		(m as any).routes = undefined;
		applyEvent(m, { tool: "fetch", ms: 10, routes: { direct: 1 } });
		expect(m.routes).toEqual({ direct: 1 });
	});

	it("renders Prometheus exposition with per-tool series", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "search", ms: 100 });
		applyEvent(m, { tool: "fetch", ms: 20, routes: { proxied: 2, direct: 1 } });
		const out = toPrometheus(m);
		expect(out).toContain("sux_calls_total 2");
		expect(out).toContain('sux_fetch_route_total{route="proxied"} 2');
		expect(out).toContain('sux_fetch_route_total{route="direct"} 1');
		expect(out).toContain('sux_tool_calls_total{tool="search"} 1');
		expect(out).toContain('sux_tool_latency_ms_avg{tool="search"} 100');
	});

	it("computes nearest-rank percentiles", () => {
		expect(percentile([], 95)).toBe(0);
		expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
		expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
	});

	it("reports SLO latency percentiles and rates from the window", () => {
		const m = emptyMetrics(0);
		for (let i = 0; i < 10; i++) applyEvent(m, { tool: "t", ms: (i + 1) * 10, cache: i < 5 });
		const slo = sloReport(m);
		expect(slo.window_calls).toBe(10);
		expect(slo.latency_ms.p50).toBeGreaterThan(0);
		expect(slo.cache_hit_rate).toBe(0.5);
		expect(slo.success_rate).toBe(1);
	});

	it("flags breaches once there is enough sample", () => {
		const m = emptyMetrics(0);
		// 25 calls, 10 errors -> 60% success (< 98%), 0% cache (< 40%).
		for (let i = 0; i < 25; i++) applyEvent(m, { tool: "t", ms: 5, error: i < 10 });
		const slo = sloReport(m);
		expect(slo.breaches.some((b) => b.includes("success_rate"))).toBe(true);
		expect(slo.breaches.some((b) => b.includes("cache_hit_rate"))).toBe(true);
	});

	it("computes SLO rates from the recent window, not lifetime totals", () => {
		const m = emptyMetrics(0);
		// Simulate a bad past that has scrolled out of the window: lifetime says
		// 100 errors, but the window only holds the last 500 (all fresh successes).
		m.total = 1000;
		m.errors = 100;
		m.cache_hits = 0;
		for (let i = 0; i < 30; i++) applyEvent(m, { tool: "t", ms: 5, cache: true });
		const slo = sloReport(m);
		expect(slo.window_calls).toBe(30);
		expect(slo.success_rate).toBe(1); // window-based, ignores the lifetime errors
		expect(slo.cache_hit_rate).toBe(1);
		expect(slo.error_rate).toBe(0);
		expect(slo.breaches).toHaveLength(0);
		expect(m.total).toBe(1030); // lifetime counters keep counting
	});

	it("does not cry wolf below the sample threshold", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "t", ms: 5, error: true }); // 1 call, 100% error but < 20 sample
		expect(sloReport(m).breaches).toHaveLength(0);
	});

	it("merges shard + legacy metrics into one aggregate (counters, tools, routes, newest-first log)", () => {
		const a = emptyMetrics(100);
		applyEvent(a, { tool: "search", ms: 100, at: 5 });
		applyEvent(a, { tool: "search", ms: 200, cache: true, at: 6, routes: { proxied: 1 } });
		const b = emptyMetrics(50);
		applyEvent(b, { tool: "dns", ms: 50, error: true, err: "boom", at: 7 });
		applyEvent(b, { tool: "search", ms: 10, at: 8, routes: { direct: 2 } });

		const m = mergeMetrics([a, b]);
		expect(m.total).toBe(4);
		expect(m.cache_hits).toBe(1);
		expect(m.errors).toBe(1);
		expect(m.tools.search).toMatchObject({ calls: 3, cache_hits: 1, total_ms: 310 });
		expect(m.tools.dns).toMatchObject({ calls: 1, errors: 1, last_error: "boom" });
		expect(m.routes).toEqual({ proxied: 1, direct: 2 });
		expect(m.since).toBe(50); // earliest wins
		expect(m.recent.map((r) => r.at)).toEqual([8, 7, 6, 5]); // global newest-first
	});

	it("readMetrics merges across shard keys AND the legacy key", async () => {
		const store = new Map<string, string>();
		for (const [k, at] of [["sux:metrics:0", 1], ["sux:metrics:3", 2], ["sux:metrics", 3]] as const) {
			const m = emptyMetrics(0);
			applyEvent(m, { tool: "t", ms: 1, at });
			store.set(k, JSON.stringify(m));
		}
		const env = { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null } } as any;
		const merged = await readMetrics(env);
		expect(merged.total).toBe(3);
		expect(merged.tools.t.calls).toBe(3);
	});

	it("recordCall fans writes across shards; readMetrics reads them all back without loss", async () => {
		const store = new Map<string, string>();
		const env = { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as any;
		// Serial: await each write before the next so the round-trip is deterministic.
		for (let i = 0; i < 20; i++) {
			const tasks: Promise<unknown>[] = [];
			recordCall(env, { waitUntil: (p) => tasks.push(p) }, { tool: "t", ms: 1 });
			await Promise.all(tasks);
		}
		const m = await readMetrics(env);
		expect(m.total).toBe(20);
		expect([...store.keys()].filter((k) => k.startsWith("sux:metrics:")).length).toBeGreaterThan(1); // used >1 shard
		expect(store.has("sux:metrics")).toBe(false); // legacy key no longer written
	});
});
