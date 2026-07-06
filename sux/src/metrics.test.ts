import { describe, expect, it } from "vitest";
import { applyEvent, clipErr, emptyMetrics, percentile, sloReport, toPrometheus } from "./metrics";

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
});
