// Lightweight usage metrics for the sux engine. Aggregated in a single KV key
// (read-modify-write, best-effort via ctx.waitUntil) — good enough for a
// dashboard at low/medium volume. NOT strongly consistent: concurrent writers
// can lose an increment. If precise counts ever matter, move to a Durable Object.

import { redactPII } from "./fns/redact";
import { drainRouteTally } from "./proxy";
import type { RtEnv } from "./registry";

// Legacy single-key aggregate — still READ (and merged) for back-compat, but no
// longer written. New writes fan out across SHARDS keys to cut the read-modify-
// write contention that lost increments under concurrency (a single hot key had
// every writer clobbering every other). Each writer touches one shard; readers
// merge all shards (+ the legacy key). Contention drops ~SHARDS×; a shard is
// still RMW, so this reduces — not eliminates — loss (a Durable Object would).
const KEY = "sux:metrics";
const SHARDS = 8;
const shardKey = (i: number): string => `sux:metrics:${i}`;
let writeSeq = 0;
const TTL = 60 * 60 * 24 * 30; // 30 days

export type ToolStat = { calls: number; errors: number; cache_hits: number; total_ms: number; last_error?: string };
export type LogEntry = { at: number; tool: string; ms: number; cache: boolean; error: boolean; err?: string; routes?: Record<string, number> };
export type Metrics = {
	since: number;
	total: number;
	cache_hits: number;
	errors: number;
	tools: Record<string, ToolStat>;
	// Lifetime fetch-route tally (proxied / direct / proxy_fallback / binary_refetch)
	// — answers "what fraction of fetches used the residential proxy".
	routes: Record<string, number>;
	recent: LogEntry[]; // rolling log (newest first), capped
};

const RECENT_CAP = 500;
const ERR_CAP = 200; // keep only the first ~200 chars of an error message
// Bound per-tool cardinality so the KV doc can't grow without limit if the tool
// set ever explodes (renames, ad-hoc names, a bug minting keys). The busiest
// TOOLS_CAP-1 tools keep their own series; everything else rolls up into one
// reserved OTHER bucket so lifetime totals stay exact. In steady state (~50 real
// tools) this never triggers — it's a safety valve, not a hot-path cost.
export const TOOLS_CAP = 100;
const OTHER_TOOL = "__other__";

export function emptyMetrics(now: number): Metrics {
	return { since: now, total: 0, cache_hits: 0, errors: 0, tools: {}, routes: {}, recent: [] };
}

/** Parse one KV metrics value, tolerating older records; null on absent/corrupt. */
function parseMetrics(raw: string | null): Metrics | null {
	if (!raw) return null;
	try {
		const m = JSON.parse(raw) as Metrics;
		if (!Array.isArray(m.recent)) m.recent = []; // migrate older records
		if (!m.routes) m.routes = {}; // migrate pre-route records
		return m;
	} catch {
		return null;
	}
}

/** Merge shard/legacy Metrics into one aggregate. Pure — easy to unit-test. */
export function mergeMetrics(parts: Metrics[]): Metrics {
	const out = emptyMetrics(Math.min(...parts.map((p) => p.since || Date.now())));
	for (const p of parts) {
		out.total += p.total || 0;
		out.cache_hits += p.cache_hits || 0;
		out.errors += p.errors || 0;
		for (const [name, t] of Object.entries(p.tools || {})) {
			const a = (out.tools[name] ??= { calls: 0, errors: 0, cache_hits: 0, total_ms: 0 });
			a.calls += t.calls || 0;
			a.errors += t.errors || 0;
			a.cache_hits += t.cache_hits || 0;
			a.total_ms += t.total_ms || 0;
			if (t.last_error) a.last_error = t.last_error;
		}
		for (const [r, n] of Object.entries(p.routes || {})) out.routes[r] = (out.routes[r] ?? 0) + n;
		out.recent.push(...(p.recent || []));
	}
	// Rolling log is global-newest-first across shards, capped to the same size.
	out.recent.sort((a, b) => b.at - a.at);
	if (out.recent.length > RECENT_CAP) out.recent.length = RECENT_CAP;
	return out;
}

export async function readMetrics(env: RtEnv): Promise<Metrics> {
	const keys = [KEY, ...Array.from({ length: SHARDS }, (_, i) => shardKey(i))];
	const parts = (await Promise.all(keys.map((k) => env.OAUTH_KV.get(k)))).map(parseMetrics).filter((m): m is Metrics => m !== null);
	return parts.length ? mergeMetrics(parts) : emptyMetrics(Date.now());
}

/** Caching-proxy effectiveness derived from the KV-backed metrics (presentation only).
 * Mirrors observability.ts: r4() 4-dp rounding, rate = hits/calls. Route counts are the
 * lifetime tally {proxied, direct, proxy_fallback, binary_refetch}; residential_ratio is
 * the fraction that actually egressed residentially. Rates are null when there's no sample
 * (guarded 0-denominators) so callers can render "—"/omit instead of NaN. */
export function deriveMetrics(m: Metrics): {
	calls: number;
	cache_hit_rate: number | null;
	residential_ratio: number | null;
	error_rate: number | null;
	proxied: number;
	route_total: number;
} {
	const r4 = (n: number) => Math.round(n * 10000) / 10000;
	const routeTotal = Object.values(m.routes ?? {}).reduce((a, b) => a + b, 0);
	const proxied = m.routes?.proxied ?? 0;
	return {
		calls: m.total,
		cache_hit_rate: m.total ? r4(m.cache_hits / m.total) : null,
		residential_ratio: routeTotal ? r4(proxied / routeTotal) : null,
		error_rate: m.total ? r4(m.errors / m.total) : null,
		proxied,
		route_total: routeTotal,
	};
}

export type CallEvent = { tool: string; ms: number; cache?: boolean; error?: boolean; err?: string; at?: number; routes?: Record<string, number> };

/** Truncate an error message to its first ~200 chars (undefined stays undefined/empty). */
export function clipErr(err?: string): string | undefined {
	if (!err) return undefined;
	// Redact PII/secret-shaped fragments BEFORE clipping: raw upstream error text
	// (echoed input, proxy error bodies) can carry emails/tokens/IPs, and this is
	// the one choke point shared by the KV-backed metrics, Workers Logs, and the
	// Loki/Grafana ship — none of which should ever see it unredacted.
	const redacted = redactPII(err).redacted;
	return redacted.length > ERR_CAP ? redacted.slice(0, ERR_CAP) : redacted;
}

/**
 * Bound a metrics doc's on-disk size in place: cap the rolling log to the last
 * RECENT_CAP entries and roll excess per-tool counters into a single OTHER
 * aggregate once tool cardinality exceeds TOOLS_CAP. Lifetime totals (m.total,
 * per-bucket sums) are preserved — nothing is lost, only re-bucketed. Pure over
 * its output shape; easy to unit-test. Runs on every write via applyEvent.
 */
export function rollupMetrics(m: Metrics): Metrics {
	if (m.recent.length > RECENT_CAP) m.recent.length = RECENT_CAP;
	const names = Object.keys(m.tools);
	if (names.length > TOOLS_CAP) {
		// Rank real tools by call volume; keep the busiest, fold the tail into OTHER
		// so the total key count lands at exactly TOOLS_CAP (kept + the one bucket).
		const ranked = names.filter((n) => n !== OTHER_TOOL).sort((a, b) => m.tools[b].calls - m.tools[a].calls);
		const bucket = m.tools[OTHER_TOOL] ?? { calls: 0, errors: 0, cache_hits: 0, total_ms: 0 };
		for (const n of ranked.slice(TOOLS_CAP - 1)) {
			const t = m.tools[n];
			bucket.calls += t.calls;
			bucket.errors += t.errors;
			bucket.cache_hits += t.cache_hits;
			bucket.total_ms += t.total_ms;
			if (t.last_error) bucket.last_error = t.last_error;
			delete m.tools[n];
		}
		m.tools[OTHER_TOOL] = bucket;
	}
	return m;
}

/** Fold one tool call into the aggregate + rolling log. Pure — easy to unit-test. */
export function applyEvent(m: Metrics, e: CallEvent): Metrics {
	const t = (m.tools[e.tool] ??= { calls: 0, errors: 0, cache_hits: 0, total_ms: 0 });
	m.total++;
	t.calls++;
	t.total_ms += e.ms || 0;
	if (e.cache) {
		m.cache_hits++;
		t.cache_hits++;
	}
	const err = clipErr(e.err);
	if (e.error) {
		m.errors++;
		t.errors++;
		if (err) t.last_error = err;
	}
	const routes = e.routes && Object.keys(e.routes).length ? e.routes : undefined;
	if (routes) {
		m.routes ??= {}; // pre-route records read straight from KV
		for (const [r, n] of Object.entries(routes)) m.routes[r] = (m.routes[r] ?? 0) + n;
	}
	m.recent.unshift({ at: e.at ?? 0, tool: e.tool, ms: e.ms || 0, cache: Boolean(e.cache), error: Boolean(e.error), ...(err ? { err } : {}), ...(routes ? { routes } : {}) });
	return rollupMetrics(m);
}

/**
 * Record a call: emits a structured log line (Workers Logs) AND folds it into the
 * KV-backed metrics/rolling-log — all best-effort, off the response path.
 */
export function recordCall(env: RtEnv, ctx: { waitUntil(p: Promise<unknown>): void }, e: CallEvent): void {
	const at = Date.now();
	// Fetch-route tally accumulated by smartFetch since the last drain — attributes
	// proxied/direct/fallback decisions to this call (best-effort under concurrency).
	const routes = drainRouteTally();
	const hasRoutes = Object.keys(routes).length > 0;
	// The single structured log line (queryable in Workers Logs / wrangler tail).
	console.log(
		`sux ${JSON.stringify({ tool: e.tool, ms: e.ms, cache: Boolean(e.cache), error: Boolean(e.error), ...(e.err ? { err: clipErr(e.err) } : {}), ...(hasRoutes ? { routes } : {}), at })}`,
	);
	// Fan out across shards to spread contention: mix the wall-clock with a
	// per-isolate sequence so concurrent writers (same or different isolates) land
	// on different shards rather than all clobbering one key. Read-modify-write of
	// the CHOSEN shard only — never the merged view (that would re-collapse every
	// shard into one).
	const key = shardKey((at + writeSeq++) % SHARDS);
	ctx.waitUntil(
		(async () => {
			const m = applyEvent(parseMetrics(await env.OAUTH_KV.get(key)) ?? emptyMetrics(at), { ...e, at, ...(hasRoutes ? { routes } : {}) });
			await env.OAUTH_KV.put(key, JSON.stringify(m), { expirationTtl: TTL });
		})().catch(() => {}),
	);
}

/** Nearest-rank percentile of a numeric list (0 for empty). */
export function percentile(values: number[], p: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

export type Slo = {
	window_calls: number;
	latency_ms: { p50: number; p95: number; avg: number };
	success_rate: number;
	cache_hit_rate: number;
	error_rate: number;
	targets: { success_rate: number; cache_hit_rate: number; p95_ms: number };
	breaches: string[];
};

// Health/SLO view over the north-star budgets. Latency percentiles AND
// success/cache rates come from the rolling `recent` window (last ≤500 calls) so
// the report reflects current behavior, not lifetime history; lifetime totals
// remain in the counters. Breaches are only flagged once there's a meaningful
// sample (≥20) so we don't cry wolf at startup.
export function sloReport(m: Metrics): Slo {
	const lats = m.recent.map((e) => e.ms);
	const p50 = percentile(lats, 50);
	const p95 = percentile(lats, 95);
	const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
	const window = m.recent.length;
	const winErrors = m.recent.filter((e) => e.error).length;
	const winHits = m.recent.filter((e) => e.cache).length;
	const success_rate = window ? (window - winErrors) / window : 1;
	const cache_hit_rate = window ? winHits / window : 0;
	const error_rate = window ? winErrors / window : 0;
	const targets = { success_rate: 0.98, cache_hit_rate: 0.4, p95_ms: 2000 };
	const breaches: string[] = [];
	const enough = window >= 20;
	if (enough && success_rate < targets.success_rate) breaches.push(`success_rate ${(success_rate * 100).toFixed(1)}% < ${targets.success_rate * 100}%`);
	if (enough && cache_hit_rate < targets.cache_hit_rate) breaches.push(`cache_hit_rate ${(cache_hit_rate * 100).toFixed(1)}% < ${targets.cache_hit_rate * 100}%`);
	if (m.recent.length >= 20 && p95 > targets.p95_ms) breaches.push(`p95 ${p95}ms > ${targets.p95_ms}ms`);
	const r4 = (n: number) => Math.round(n * 10000) / 10000;
	return { window_calls: window, latency_ms: { p50, p95, avg }, success_rate: r4(success_rate), cache_hit_rate: r4(cache_hit_rate), error_rate: r4(error_rate), targets, breaches };
}

/** Prometheus text exposition (text/plain; version=0.0.4). */
export function toPrometheus(m: Metrics): string {
	const lines: string[] = [
		"# HELP sux_calls_total Total tool calls.",
		"# TYPE sux_calls_total counter",
		`sux_calls_total ${m.total}`,
		"# HELP sux_cache_hits_total Total cache hits.",
		"# TYPE sux_cache_hits_total counter",
		`sux_cache_hits_total ${m.cache_hits}`,
		"# HELP sux_errors_total Total tool errors.",
		"# TYPE sux_errors_total counter",
		`sux_errors_total ${m.errors}`,
		"# HELP sux_tool_calls_total Per-tool call count.",
		"# TYPE sux_tool_calls_total counter",
	];
	for (const [name, t] of Object.entries(m.tools)) {
		lines.push(`sux_tool_calls_total{tool="${name}"} ${t.calls}`);
	}
	lines.push("# HELP sux_tool_errors_total Per-tool error count.", "# TYPE sux_tool_errors_total counter");
	for (const [name, t] of Object.entries(m.tools)) {
		lines.push(`sux_tool_errors_total{tool="${name}"} ${t.errors}`);
	}
	lines.push("# HELP sux_fetch_route_total Per-route fetch count (proxied/direct/proxy_fallback/binary_refetch).", "# TYPE sux_fetch_route_total counter");
	for (const [route, n] of Object.entries(m.routes ?? {})) {
		lines.push(`sux_fetch_route_total{route="${route}"} ${n}`);
	}
	lines.push("# HELP sux_tool_latency_ms_avg Per-tool average latency (ms).", "# TYPE sux_tool_latency_ms_avg gauge");
	for (const [name, t] of Object.entries(m.tools)) {
		lines.push(`sux_tool_latency_ms_avg{tool="${name}"} ${t.calls ? Math.round(t.total_ms / t.calls) : 0}`);
	}
	// SLO view: recent-window latency quantiles + breach count.
	const slo = sloReport(m);
	lines.push(
		"# HELP sux_latency_ms Recent-window request latency quantiles (ms).",
		"# TYPE sux_latency_ms gauge",
		`sux_latency_ms{quantile="0.5"} ${slo.latency_ms.p50}`,
		`sux_latency_ms{quantile="0.95"} ${slo.latency_ms.p95}`,
		"# HELP sux_success_rate Recent-window tool-call success rate.",
		"# TYPE sux_success_rate gauge",
		`sux_success_rate ${slo.success_rate}`,
		"# HELP sux_cache_hit_rate Recent-window cache hit rate.",
		"# TYPE sux_cache_hit_rate gauge",
		`sux_cache_hit_rate ${slo.cache_hit_rate}`,
		"# HELP sux_slo_breaches Count of SLO targets currently breached.",
		"# TYPE sux_slo_breaches gauge",
		`sux_slo_breaches ${slo.breaches.length}`,
	);
	return `${lines.join("\n")}\n`;
}
