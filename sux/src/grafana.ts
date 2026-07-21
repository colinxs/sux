import { clipErr, type CallEvent, deriveMetrics, type Metrics, readMetrics, sloReport } from "./metrics";
import type { FetchRoute } from "./proxy";
import type { RtEnv } from "./registry";

// Only the Loki push secrets decide configured-or-not. A structural (all-optional)
// shape so a caller holding a narrower env than RtEnv — proxy.ts's TailscaleEnv,
// which at runtime is the same object and carries these secrets — can ship without
// importing the full RtEnv or forcing a cast.
type LokiEnv = Pick<RtEnv, "GRAFANA_LOKI_URL" | "GRAFANA_LOKI_USER" | "GRAFANA_LOKI_TOKEN">;

// Ship one tool-call event to Grafana Cloud Loki (the HTTP push API), fire-and-
// forget. This is the Worker-friendly path to observability: a single authed
// JSON POST per call, off the response path via ctx.waitUntil, so it never adds
// latency and never fails a request. No-op unless all three secrets are set
// (GRAFANA_LOKI_URL + GRAFANA_LOKI_USER + GRAFANA_LOKI_TOKEN), so it's inert until
// you configure it. From the shipped lines, Grafana derives rates/latencies/error
// ratios via LogQL (e.g. `quantile_over_time` on the unwrapped `ms`).
//
// Loki wants nanosecond string timestamps and low-cardinality stream labels, so
// the tool name is a label (≈78 values, fine) but ms/error/routes ride in the
// JSON log line, not as labels.
export function shipToLoki(env: RtEnv, ctx: { waitUntil(p: Promise<unknown>): void }, e: CallEvent): void {
	const url = env.GRAFANA_LOKI_URL;
	const user = env.GRAFANA_LOKI_USER;
	const token = env.GRAFANA_LOKI_TOKEN;
	if (!url || !user || !token) return;

	// Clip the raw upstream failure text to the same ~200-char cap metrics.ts and
	// the /logs view apply — an unbounded error (e.g. an echoed HTML error page)
	// must not ride verbatim to a third party or trip Loki's max-line-size drop.
	const err = clipErr(e.err);
	const line = JSON.stringify({
		tool: e.tool,
		ms: e.ms,
		cache: Boolean(e.cache),
		error: Boolean(e.error),
		...(err ? { err } : {}),
		...(e.routes ? { routes: e.routes } : {}),
	});
	const tsNanos = `${e.at ?? Date.now()}000000`;
	const body = JSON.stringify({
		streams: [
			{
				stream: { service: "sux", tool: e.tool, level: e.error ? "error" : "info" },
				values: [[tsNanos, line]],
			},
		],
	});
	const authorization = `Basic ${btoa(`${user}:${token}`)}`;

	ctx.waitUntil(
		fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization }, body })
			.then(async (r) => {
				if (!r.ok) console.warn(`grafana loki push HTTP ${r.status}: ${clipErr(await r.text())}`);
			})
			.catch((err) => console.warn(`grafana loki push failed: ${String((err as Error)?.message ?? err)}`)),
	);
}

// One egress-audit line per OUTBOUND fetch decision smartFetch makes: which host,
// which fetch-ladder rung it chose, whether it exited residential (via the proxy)
// or direct, and the resulting status — tagged with the tools/call correlation id
// so every outbound hop of one tool call can be grouped. This turns the Loki
// stream into egress forensics: it proves the SSRF guard fired (a blocked target
// never reaches here, so its absence is the signal) and shows the residential-vs-
// direct split per host.
//
// Same discipline as shipToLoki: no-op until all three Grafana secrets are set,
// fire-and-forget via ctx.waitUntil (never on the response path), and NEVER throws
// — a swallowed/omitted audit line must not fail a fetch. Ships ONLY the host, not
// the full URL, so query-string secrets/tokens can never leak into the log stream.
export type EgressEvent = {
	// Correlation id from the owning tools/call (grafana groups a call's fetches).
	reqId?: string;
	// Hostname only — NEVER the full URL (paths/queries can carry secrets).
	host: string;
	// The fetch-ladder rung actually taken (proxied / direct / proxy_fallback / binary_refetch).
	rung: FetchRoute;
	// True when the request exited through the residential proxy, false when direct.
	residential: boolean;
	// Resulting HTTP status, when a response was obtained.
	status?: number;
};

export function shipEgress(env: LokiEnv, ctx: { waitUntil(p: Promise<unknown>): void }, e: EgressEvent): void {
	const url = env.GRAFANA_LOKI_URL;
	const user = env.GRAFANA_LOKI_USER;
	const token = env.GRAFANA_LOKI_TOKEN;
	if (!url || !user || !token) return;

	try {
		const line = JSON.stringify({
			host: e.host,
			rung: e.rung,
			residential: e.residential,
			...(e.status != null ? { status: e.status } : {}),
			...(e.reqId ? { reqId: e.reqId } : {}),
		});
		const tsNanos = `${Date.now()}000000`;
		// Low-cardinality labels only: a fixed kind + the residential boolean. Host,
		// rung, status and reqId ride in the JSON line, not as labels.
		const body = JSON.stringify({
			streams: [
				{
					stream: { service: "sux", kind: "egress", residential: String(e.residential) },
					values: [[tsNanos, line]],
				},
			],
		});
		const authorization = `Basic ${btoa(`${user}:${token}`)}`;

		ctx.waitUntil(
			fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization }, body })
				.then(async (r) => {
					if (!r.ok) console.warn(`grafana egress push HTTP ${r.status}: ${clipErr(await r.text())}`);
				})
				.catch((err) => console.warn(`grafana egress push failed: ${String((err as Error)?.message ?? err)}`)),
		);
	} catch (err) {
		// Never let audit bookkeeping throw into the hot fetch path.
		console.warn(`grafana egress ship failed: ${String((err as Error)?.message ?? err)}`);
	}
}

// Escape an Influx line-protocol tag value: commas, spaces and equals signs must
// be backslash-escaped (measurement/field names here are fixed constants, so only
// tag values — tool names, routes, quantiles — need it).
function escapeTag(v: string): string {
	return v.replace(/([,= ])/g, "\\$1");
}

// Build the once-per-tick Prometheus snapshot as Influx line protocol — one line
// per series, `measurement[,tags] value=n <ts_ns>`. Pure over its inputs (easy to
// unit-test), and it reuses the ALREADY-COMPUTED derivations verbatim: the raw KV
// counters, deriveMetrics() rates, and the SLO/latency view. Null rates (no sample)
// are OMITTED, never emitted — Influx rejects NaN, same discipline as the /health
// "—" rendering. Non-finite values are dropped for the same reason.
export function buildInfluxSnapshot(m: Metrics, atMs: number): string {
	const ts = `${atMs}000000`; // Influx wants nanosecond timestamps.
	const lines: string[] = [];
	const push = (name: string, value: number, tags?: Record<string, string>): void => {
		if (!Number.isFinite(value)) return;
		const tagStr =
			tags && Object.keys(tags).length ? `,${Object.entries(tags).map(([k, v]) => `${k}=${escapeTag(v)}`).join(",")}` : "";
		lines.push(`${name}${tagStr} value=${value} ${ts}`);
	};

	push("sux_calls_total", m.total);
	push("sux_errors_total", m.errors);
	push("sux_cache_hits_total", m.cache_hits);
	for (const [tool, t] of Object.entries(m.tools)) {
		push("sux_tool_calls_total", t.calls, { tool });
		push("sux_tool_errors_total", t.errors, { tool });
		push("sux_tool_latency_ms_avg", t.calls ? Math.round(t.total_ms / t.calls) : 0, { tool });
	}
	for (const [route, n] of Object.entries(m.routes ?? {})) push("sux_fetch_route_total", n, { route });

	const d = deriveMetrics(m);
	if (d.error_rate != null) push("sux_error_rate", d.error_rate);
	if (d.cache_hit_rate != null) push("sux_cache_hit_rate", d.cache_hit_rate);
	if (d.residential_ratio != null) push("sux_residential_ratio", d.residential_ratio);

	const slo = sloReport(m);
	push("sux_latency_ms", slo.latency_ms.p50, { quantile: "0.5" });
	push("sux_latency_ms", slo.latency_ms.p95, { quantile: "0.95" });
	push("sux_success_rate", slo.success_rate);
	push("sux_slo_breaches", slo.breaches.length);

	return lines.join("\n");
}

// Push the pre-aggregated metrics snapshot to Grafana Cloud Prometheus once per
// cron tick. The KISS split from shipToLoki: high-cardinality per-event data rides
// the Loki stream (already built); the low-cardinality, long-retention counters +
// /health/SLO gauges go to Prometheus here — via Influx line protocol, NOT snappy-
// protobuf remote-write (no deps, mirrors how toPrometheus builds text).
//
// Same secret-gate + fire-and-forget shape as shipToLoki: a pure no-op (no KV read,
// no throw, no log noise) unless GRAFANA_PROM_URL + GRAFANA_PROM_USER are set. The
// bearer is the SHARED Grafana access-policy token GRAFANA_LOKI_TOKEN (scope it
// +metrics:write) — no second key to mint. Given GRAFANA_LOKI_* is already live,
// shipping this leaves Prometheus dormant until Colin sets the two new secrets.
export async function shipMetricsSnapshot(env: RtEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
	const url = env.GRAFANA_PROM_URL;
	const user = env.GRAFANA_PROM_USER;
	const token = env.GRAFANA_LOKI_TOKEN;
	if (!url || !user || !token) return;

	const m = await readMetrics(env);
	const body = buildInfluxSnapshot(m, Date.now());
	if (!body) return; // nothing to ship (cold start, all rates null) — skip the POST.
	const authorization = `Basic ${btoa(`${user}:${token}`)}`;

	ctx.waitUntil(
		fetch(url, { method: "POST", headers: { "content-type": "text/plain", authorization }, body })
			.then(async (r) => {
				if (!r.ok) console.warn(`grafana metrics push HTTP ${r.status}: ${clipErr(await r.text())}`);
			})
			.catch((err) => console.warn(`grafana metrics push failed: ${String((err as Error)?.message ?? err)}`)),
	);
}

const DEFAULT_BILLING_OWNER = "SuxOS";

// The subset of GitHub's `GET /orgs/{org}/settings/billing/actions` response this cares
// about — the endpoint also returns a per-runner-OS `minutes_used_breakdown`, which isn't
// shipped (it would multiply cardinality for a number nobody's asked to watch yet).
type GithubBillingUsage = { total_minutes_used?: number; included_minutes?: number };

/** Build the GH Actions billing gauges as Influx line protocol — pure over its input (easy
 * to unit-test), same shape as buildInfluxSnapshot. Missing/non-finite fields are omitted,
 * never emitted as 0 or NaN (Influx rejects NaN; a 0 would misreport as "zero minutes used"). */
export function buildGithubBillingSnapshot(usage: GithubBillingUsage, atMs: number): string {
	const ts = `${atMs}000000`;
	const lines: string[] = [];
	if (Number.isFinite(usage.total_minutes_used)) lines.push(`gh_actions_minutes_used_total value=${usage.total_minutes_used} ${ts}`);
	if (Number.isFinite(usage.included_minutes)) lines.push(`gh_actions_minutes_included value=${usage.included_minutes} ${ts}`);
	return lines.join("\n");
}

// scripts/billing-check.mjs's githubActionsMeter() independently fetches this same
// /settings/billing/actions endpoint (with a different GH_BILLING_OWNER default,
// "colinxs" there vs "SuxOS" here) — see that file before assuming this is the only
// caller, and consider consolidating if you touch either (#1101).
//
// Poll GitHub Actions billing usage and push it as a Prometheus gauge, once per daily
// maintenance tick (spend-observability-plan.md's plumbing step 1). Reuses the SAME
// Influx-line-protocol transport as shipMetricsSnapshot — same secrets, same shared bearer
// — so there's no new credential to mint beyond the GITHUB_TOKEN self-improve already needs.
// No-op (returns {dormant:true}) unless both the Prometheus secrets AND GITHUB_TOKEN are
// set; never throws — a billing-poll hiccup must not sink the rest of the daily tick.
export async function shipGithubBillingSnapshot(
	env: RtEnv,
	ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<{ dormant: true } | { ok: true; total_minutes_used?: number; included_minutes?: number } | { error: string }> {
	const url = env.GRAFANA_PROM_URL;
	const user = env.GRAFANA_PROM_USER;
	const token = env.GRAFANA_LOKI_TOKEN;
	const ghToken = env.GITHUB_TOKEN;
	if (!url || !user || !token || !ghToken) return { dormant: true };

	const owner = String(env.GH_BILLING_OWNER ?? "").trim() || DEFAULT_BILLING_OWNER;
	try {
		// GitHub has no repo-scoped Actions-billing endpoint — minutes are billed against the
		// owning account, not an individual repo (#1098). This is the org (or user) login, not
		// an owner/repo pair; the equivalent for a personal-account owner is /users/{owner}/....
		const res = await fetch(`https://api.github.com/orgs/${owner}/settings/billing/actions`, {
			headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
		});
		if (!res.ok) return { error: `GitHub billing API HTTP ${res.status}: ${clipErr(await res.text())}` };
		const usage = (await res.json()) as GithubBillingUsage;

		const body = buildGithubBillingSnapshot(usage, Date.now());
		if (!body) return { error: "GitHub billing API returned no usable minutes fields" };
		const authorization = `Basic ${btoa(`${user}:${token}`)}`;
		ctx.waitUntil(
			fetch(url, { method: "POST", headers: { "content-type": "text/plain", authorization }, body })
				.then(async (r) => {
					if (!r.ok) console.warn(`grafana gh-billing push HTTP ${r.status}: ${clipErr(await r.text())}`);
				})
				.catch((err) => console.warn(`grafana gh-billing push failed: ${String((err as Error)?.message ?? err)}`)),
		);
		return { ok: true, total_minutes_used: usage.total_minutes_used, included_minutes: usage.included_minutes };
	} catch (err) {
		return { error: String((err as Error)?.message ?? err) };
	}
}
