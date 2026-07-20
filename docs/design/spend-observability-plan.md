---
title: Spend observability plan (GitHub Actions minutes + Claude/API credit usage)
status: draft (plumbing step 1 shipped — see #1061)
---

# Spend observability plan

Track E of `docs/knowledge/master-plan.md` calls for "Grafana billing dashboards —
make 'efficient' a gauge you watch (spend + free-credit-usage visible)." This is a
design note, not a shipped dashboard: the underlying data isn't wired up yet, and a
dashboard with panels pointing at nothing would be worse than no dashboard.

## What already exists (don't reinvent)

`sux/src/metrics.ts` + `sux/grafana/` already give per-tool-call observability for
the sux Worker itself:

- **Loki** (`sux/grafana/dashboard.json`, `dashboard uid: sux-resilience-obs`) —
  one JSON log line per tool call (`shipToLoki`) and per-fetch egress
  (`shipEgress`). Panels: call rate by tool, latency p50/p95/p99, error ratio,
  cache-hit ratio, throughput-vs-errors, errors by tool.
- **Prometheus/Mimir** (`sux/grafana/prometheus-dashboard.json`) — once per cron
  tick, `shipMetricsSnapshot` pushes the KV-backed lifetime counters (`sux_*`
  series) as Influx line protocol to Grafana Cloud. Dormant until
  `GRAFANA_PROM_*` secrets are set.
- **Alerts** (`alerts.json`, `prometheus-alerts.json`) — error-ratio-above-5%-for-
  10m today.

None of this touches **billing**. It measures sux's own request volume/latency/
errors, not GitHub Actions minutes consumed or Claude/API credit spend. There is
currently **no metric anywhere in the repo for either of those two things** — I
grepped `sux/src` for `billing`, `actions.*minutes`, `credit`, `usage.*api` and
found nothing beyond the tool-call metrics above.

## What's missing, concretely

1. **GitHub Actions minutes usage** — GitHub bills Actions minutes against the
   owning account, not an individual repo, so there is no repo-scoped billing
   endpoint. GitHub exposes this via `GET /orgs/{org}/settings/billing/actions`
   (or the `/users/{user}/...`/`/enterprises/{enterprise}/...` equivalents),
   returning `total_minutes_used`, `included_minutes`, and a per-runner-OS
   breakdown for the current billing cycle. Nothing today calls this endpoint or
   stores its result anywhere Grafana can query.
2. **Claude/API credit usage** — Anthropic's usage/cost is visible in the
   console, not pushed anywhere programmatically from this repo. No script polls
   it, no metric represents it.
3. **A time-series home for both** — the existing pattern (`shipMetricsSnapshot`
   → Influx line protocol → Grafana Cloud Prometheus) is the natural place to add
   these as new low-cardinality gauges (e.g. `gh_actions_minutes_used_total`,
   `gh_actions_minutes_included`, `claude_credit_used_usd`), but nothing currently
   populates them.

## Proposed plumbing (before any dashboard is built)

1. **GitHub Actions minutes** — SHIPPED (#1061), fixed to the real org-scoped
   endpoint in #1098: `sux/src/grafana.ts`'s `shipGithubBillingSnapshot` polls
   `GET /orgs/{org}/settings/billing/actions` (org from `GH_BILLING_OWNER`, default
   `SuxOS`) using the existing `GITHUB_TOKEN`, and
   pushes `gh_actions_minutes_used_total` / `gh_actions_minutes_included` via the same
   Influx-line-protocol transport `shipMetricsSnapshot` uses (same `GRAFANA_PROM_*`
   secrets + shared `GRAFANA_LOKI_TOKEN` bearer — no new credential to mint). Rides the
   daily maintenance cron as the `gh_actions_billing` sub-job (heartbeat-tracked like the
   rest of `CRON_JOBS`); dormant until GITHUB_TOKEN + both Prometheus secrets are set.
   The dashboard panel itself is still unbuilt — see "Next step" below.
2. **Claude/API credit usage**: Anthropic doesn't currently expose a usage/cost
   API for this to poll (console-only as of this writing) — confirm before
   building; if none exists, this half stays manual/console-only until Anthropic
   ships one, and the dashboard should say so rather than fake a panel.
3. **Budget-remaining indicator**: once (1) lands, a "days until Actions minutes
   reset" or "% of included minutes used this cycle" gauge is a simple derived
   panel (`included - used`, reset date known from the billing cycle anchor) —
   no additional data needed beyond (1).

## Why this note instead of a dashboard right now

- Grafana Cloud MCP tools in this environment require an OAuth authorization
  this non-interactive session can't complete (`plugin:grafana-cloud-mcp` and
  `plugin:sux:sux` both show as unauthenticated) — no dashboard could actually be
  created here even if the data existed.
- Per the task's own guidance: don't ship a panel pointing at nothing. GH Actions
  minutes and Claude credit usage have zero data plumbing today, so a dashboard
  now would be two of three requested panels either fabricated or empty.

## Next step

Once (1) is built (a Worker cron route or scheduled GH Action pushing
`gh_actions_minutes_used` to Grafana Cloud Prometheus), come back to this note,
build the actual dashboard (reusing `sux/grafana/prometheus-dashboard.json` as
the template — same `__inputs`/import pattern), and update `sux/grafana/README.md`
with the new panel set. Claude/credit usage panel gets added if/when Anthropic
exposes a programmatic usage endpoint.
