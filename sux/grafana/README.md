# sux — Grafana dashboards & alerts (as code)

**Status (2026-07-15 audit): provisioned.** Both dashboards and all three alert
rules live in Grafana Cloud under the **`sux`** folder — `sux — resilience &
observability` (`sux-resilience-obs`) and `sux — metrics & SLO (Prometheus)`
(`sux-metrics-prom`), confirmed rendering real data (`sux_calls_total`,
`{service="sux"}` logs both flowing). These files remain the source of truth —
re-run the import/install steps below after editing them to update Grafana in
place (both dashboard UIDs and all three alert `uid`s are stable).

Dashboard-as-code for the sux Cloudflare Worker MCP server. Two complementary
halves, both shipped from `sux/src/grafana.ts` — nothing is scraped:

- **Loki (logs / per-event)** — the `{service="sux"}` log stream, one JSON line
  per tool call (`shipToLoki`) plus per-fetch egress lines (`shipEgress`). Rates,
  latencies and error ratios are derived from it via LogQL. This is the
  high-cardinality, short-retention half.
- **Prometheus (metrics snapshot / durable gauges)** — once per cron tick
  `shipMetricsSnapshot` pushes the KV-backed lifetime counters + the `/health`/SLO
  gauges as **Influx line protocol** to Grafana Cloud Prometheus (Mimir). This is
  the low-cardinality, long-retention half. It is **dormant until the two
  `GRAFANA_PROM_*` secrets are set** (see below).

Why Influx line protocol and not Prometheus `remote_write`: remote-write is
snappy-compressed protobuf, which is a lot of hand-rolled encoding to carry in a
dependency-free Worker. The Grafana Cloud Influx push endpoint lands in the same
Mimir store and shows up as the same `sux_*` Prometheus series, built with a plain
string join — the KISS choice, honestly a tradeoff of wire-format purity for zero
deps.

## The log line these queries read

Stream labels (low cardinality): `service="sux"`, `tool`, `level` (`info` |
`error`). The JSON log line carries the numeric/boolean fields:

```json
{ "tool": "fetch", "ms": 42, "cache": true, "error": false, "err": "…", "routes": {…} }
```

LogQL parses that with `| json`, so `ms` is available to `unwrap` and `error` /
`cache` become matchable label values (`error=\`true\``).

## Files

| File | What it is |
| --- | --- |
| `dashboard.json` | Importable Grafana dashboard, **Loki** datasource. Panels: call rate by tool, latency p50/p95/p99 (`quantile_over_time` on unwrapped `ms`), error ratio, cache-hit ratio, throughput-vs-errors, errors by tool. |
| `alerts.json` | Grafana-managed alert rule (Loki): **error ratio sustained above 5% for 10m**. |
| `prometheus-dashboard.json` | Importable Grafana dashboard, **Prometheus** datasource, over the cron-pushed `sux_*` snapshot. Panels: call/error rate, recent-window latency p50/p95, success / cache-hit / residential rates, SLO breaches (+ cron freshness), calls by tool, GitHub Actions minutes used/included + % used. |
| `prometheus-alerts.json` | Grafana-managed alert rules (Prometheus): **metrics snapshot stale for 15m** (cron stalled) and **any SLO target breached for 10m**. |

### The metric series (Prometheus half)

`shipMetricsSnapshot` pushes each series as one Influx line
`sux_<name>[,tag=v] value=<n> <ts_ns>` — e.g. `sux_calls_total value=42 …`,
`sux_tool_calls_total,tool=fetch value=10 …`, `sux_latency_ms,quantile=0.95 value=…`.
Counters (`*_total`) are lifetime cumulative — query them with `rate()`/`increase()`;
the rest (`sux_error_rate`, `sux_cache_hit_rate`, `sux_residential_ratio`,
`sux_success_rate`, `sux_latency_ms`, `sux_slo_breaches`) are point-in-time gauges.
Null rates (no sample) are omitted rather than emitted as `NaN`.

`shipGithubBillingSnapshot` pushes two more series once per daily maintenance tick:
`gh_actions_minutes_used_total` and `gh_actions_minutes_included`. Despite the
`_total` name these are **point-in-time gauges for the current GitHub billing
cycle** (GitHub resets them monthly), not lifetime counters — query them directly,
not through `rate()`/`increase()`. Dormant (no push) until `GITHUB_TOKEN` and both
`GRAFANA_PROM_*` secrets are set.

> **Metric naming note:** some Grafana Cloud Influx receivers name the resulting
> Prometheus series `<measurement>_value` (i.e. `sux_calls_total_value`). If the
> `prometheus-dashboard.json` panels show "No data", check your instance's
> influx-write naming and add the `_value` suffix to the queries.

## Prerequisites

**Loki (logs)** — the worker must be shipping logs; set the three secrets and
redeploy:

```sh
npm run secret:sux GRAFANA_LOKI_URL     # the …/loki/api/v1/push endpoint
npm run secret:sux GRAFANA_LOKI_USER    # numeric instance / user id
npm run secret:sux GRAFANA_LOKI_TOKEN   # Access Policy token, scope logs:write
```

Until all three are set, `shipToLoki` is inert and no data reaches Loki.

**Prometheus (metrics snapshot)** — set the two additional secrets and redeploy.
The token is **reused** from the Loki triplet (one Access Policy token can carry
both `logs:write` and `metrics:write` — scope it accordingly), so there is no
second token to mint:

```sh
npm run secret:sux GRAFANA_PROM_URL     # the …/api/v1/push/influx/write endpoint
npm run secret:sux GRAFANA_PROM_USER    # numeric Prometheus/Mimir instance id (basic-auth user)
# token: reuse GRAFANA_LOKI_TOKEN — scope it +metrics:write in Grafana
```

Until both `GRAFANA_PROM_URL` and `GRAFANA_PROM_USER` are set, `shipMetricsSnapshot`
is a pure no-op (no KV read, no push) and no metrics reach Prometheus. Force a push
during setup with the manual ops trigger (bearer = `SUX_CRON_TOKEN`):

```sh
curl -sS -X POST "$SUX_URL/admin/tick?job=maintenance" -H "authorization: Bearer $SUX_CRON_TOKEN"
```

## Import the dashboard

**UI:** Grafana → *Dashboards → New → Import → Upload JSON file* → pick
`dashboard.json`. When prompted for the `DS_LOKI` input, select your Loki
datasource. Save.

**API:** wrap the file in an import payload (the `__inputs` block lets Grafana
bind the datasource):

```sh
curl -sS -X POST "$GRAFANA_URL/api/dashboards/import" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  --data @<(jq -n --slurpfile d dashboard.json \
      '{dashboard: $d[0], overwrite: true,
        inputs: [{name:"DS_LOKI", type:"datasource", pluginId:"loki", value: env.LOKI_DS_UID}]}')
```

The dashboard `uid` is `sux-resilience-obs`, so re-imports update in place.

## Install the alert rule

**API (recommended):** substitute your Loki datasource UID for `${DS_LOKI}` and
POST the group to the provisioning endpoint:

```sh
sed "s/\${DS_LOKI}/$LOKI_DS_UID/g" alerts.json \
  | curl -sS -X POST "$GRAFANA_URL/api/v1/provisioning/alert-rules" \
      -H "Authorization: Bearer $GRAFANA_TOKEN" \
      -H "Content-Type: application/json" --data @-
```

(For Grafana OSS/file provisioning, drop `alerts.json` — with `${DS_LOKI}`
replaced — into a `provisioning/alerting/` file mount instead.) Attach a
contact point / notification policy that matches `service=sux` to route it.

## Tuning

- **Error-ratio threshold / window** — `alerts.json`: `evaluator.params` (0.05)
  and the rule `for` (`10m`). The dashboard error-ratio stat mirrors these with
  yellow at 2% and red at 5%.
- **Cache-hit expectations** — dashboard panel `id: 4` thresholds (red < 30%,
  green ≥ 60%).
- **Time range / refresh** — dashboard defaults to `now-6h` and a 1m refresh.
