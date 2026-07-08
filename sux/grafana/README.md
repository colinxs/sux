# sux — Grafana dashboard & alert (as code)

Dashboard-as-code for the sux Cloudflare Worker MCP server. Everything here is
derived from the `{service="sux"}` log stream that `sux/src/grafana.ts` ships to
Grafana Cloud Loki (fire-and-forget, one JSON line per tool call). Nothing is
scraped; there is no Prometheus dependency.

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
| `dashboard.json` | Importable Grafana dashboard, Loki datasource. Panels: call rate by tool, latency p50/p95/p99 (`quantile_over_time` on unwrapped `ms`), error ratio, cache-hit ratio, throughput-vs-errors, errors by tool. |
| `alerts.json` | Grafana-managed alert rule: **error ratio sustained above 5% for 10m**. |

## Prerequisites

The worker must be shipping logs — set the three secrets and redeploy:

```sh
npm run secret:sux GRAFANA_LOKI_URL     # the …/loki/api/v1/push endpoint
npm run secret:sux GRAFANA_LOKI_USER    # numeric instance / user id
npm run secret:sux GRAFANA_LOKI_TOKEN   # Access Policy token, scope logs:write
```

Until all three are set, `shipToLoki` is inert and no data reaches Loki.

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
