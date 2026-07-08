import type { CallEvent } from "./metrics";
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
				.then((r) => {
					if (!r.ok) console.warn(`grafana egress push HTTP ${r.status}`);
				})
				.catch((err) => console.warn(`grafana egress push failed: ${String((err as Error)?.message ?? err)}`)),
		);
	} catch (err) {
		// Never let audit bookkeeping throw into the hot fetch path.
		console.warn(`grafana egress ship failed: ${String((err as Error)?.message ?? err)}`);
	}
}
