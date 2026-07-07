import type { CallEvent } from "./metrics";
import type { RtEnv } from "./registry";

// Ship one tool-call event to Grafana Cloud Loki (the HTTP push API), fire-and-
// forget. This is the Worker-friendly path to observability: a single authed
// JSON POST per call, off the response path via ctx.waitUntil, so it never adds
// latency and never fails a request. No-op unless all three secrets are set
// (GRAFANA_LOKI_URL + GRAFANA_LOKI_USER + GRAFANA_API_TOKEN), so it's inert until
// you configure it. From the shipped lines, Grafana derives rates/latencies/error
// ratios via LogQL (e.g. `quantile_over_time` on the unwrapped `ms`).
//
// Loki wants nanosecond string timestamps and low-cardinality stream labels, so
// the tool name is a label (≈78 values, fine) but ms/error/routes ride in the
// JSON log line, not as labels.
export function shipToLoki(env: RtEnv, ctx: { waitUntil(p: Promise<unknown>): void }, e: CallEvent): void {
	const url = env.GRAFANA_LOKI_URL;
	const user = env.GRAFANA_LOKI_USER;
	const token = env.GRAFANA_API_TOKEN;
	if (!url || !user || !token) return;

	const line = JSON.stringify({
		tool: e.tool,
		ms: e.ms,
		cache: Boolean(e.cache),
		error: Boolean(e.error),
		...(e.err ? { err: e.err } : {}),
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
			.then((r) => {
				if (!r.ok) console.warn(`grafana loki push HTTP ${r.status}`);
			})
			.catch((err) => console.warn(`grafana loki push failed: ${String((err as Error)?.message ?? err)}`)),
	);
}
