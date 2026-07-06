import { describe, expect, it } from "vitest";
import { applyEvent, emptyMetrics, percentile, sloReport, toPrometheus } from "./metrics";

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

	it("renders Prometheus exposition with per-tool series", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "search", ms: 100 });
		const out = toPrometheus(m);
		expect(out).toContain("sux_calls_total 1");
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

	it("does not cry wolf below the sample threshold", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "t", ms: 5, error: true }); // 1 call, 100% error but < 20 sample
		expect(sloReport(m).breaches).toHaveLength(0);
	});
});
