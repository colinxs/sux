---
title: Generalized cross-tier watchdog + debug + auto-remediation
status: designed
cluster: infrastructure
type: design
summary: "Design for a cross-tier (router/host/Worker) watchdog + debug + auto-remediation plane that reasserts known-good state in the safe/reversible direction; ~80% rides the already-shipped /health hub + dead-drop rather than a new orchestration framework."
tags: [sux, infrastructure, watchdog, observability]
updated: 2026-07-12
---

# Generalized cross-tier watchdog + debug + auto-remediation

Design only — no code changes. Opinionated, buildable, KISS.

## TL;DR

The three tiers are **not** three silos that need a new orchestration framework — the
unifying plane is **80% already shipped**. The Worker's `/health` page already
aggregates the router (via Tailscale `nodeStatus` **and** the recovery dead-drop KV),
the Worker's own bindings/metrics/cron heartbeats, and the recovery command channel;
GitHub Issues is already the bots' ticket queue (`health.yml`, `audit.yml` open/update
issues). This design **wires the three existing signal sources into one status view and
one escalation queue**, adds three thin missing edges, and stops there. Per
[[sux-design-verdict-2026-07]]: no event framework, no Queues, no rule-DSL, no new
control plane. The build is "connect what exists," not "invent the moon."

## The one-line architecture

> **Worker `/health` is the health HUB (read plane). GitHub Issues is the escalation
> QUEUE (write/ticket plane). The recovery dead-drop is the ONLY downward command
> channel. Each tier self-heals only in the attention-increasing/reversible direction;
> everything else opens an issue and waits for a human or an agent.**

```
        TIER 1: GitHub bots              TIER 2: router (owl-tegu)         TIER 3: sux Worker
        mail-triage / self-improve       watchdog / self-heal              ~95 fns / KV / D1 / R2
        security-gate / drift-audit      gateway·DNS·TS·proxy              CF observability
              │                                   │                                │
              │ workflow status,                  │ signed dead-drop               │ heartbeats,
              │ open/update Issues                │ POST /recovery/checkin         │ binding probes,
              │                                   │ (health up, cmds down)         │ metrics, SLO
              ▼                                   ▼                                ▼
        ┌──────────────┐                   ┌──────────────────────┐        ┌──────────────────┐
        │ GitHub Issues│◄──────────────────│  recovery:status:*   │        │  cron heartbeats │
        │  (TICKETS)   │   escalation      │  KV (last-seen health)│───────►│  gatherHealth()  │
        └──────┬───────┘                   └──────────┬───────────┘        └────────┬─────────┘
               │                                      │  commands vended            │
               │                        recovery:queue:* KV ◄── /recovery/enqueue   │
               │                                                                    │
               └──────────────────────► Worker GET /health  ◄──────────────────────┘
                                        (THE HUB: one JSON, one page)
                                                   │
                                                   ▼
                                   operator (Colin) OR an agent
                                   reads /health, files/reads Issues,
                                   enqueues signed recovery commands
```

## Common health model

One shape, emitted by every tier, aggregated at `/health`. This is the contract — it
already half-exists in `gatherHealth()`; formalize it.

```
Component = {
  tier:      "github" | "router" | "worker",
  name:      string,                 // "mail_triage", "owl-tegu:dns", "kv"
  status:    "ok" | "degraded" | "down" | "stale" | "unknown",
  seen:      boolean,                // has it ever reported?
  at:        number,                 // unix ms of last report
  detail?:   string,                 // one-line human reason
  reversible_selfheal?: string[],    // actions this component may auto-take (safe direction)
}
```

Rules:
- **`status` is derived, never trusted.** Staleness is computed at read time against a
  per-component budget (cron: `CRON_STALE_MS` 26h already; router checkin: ~2× its
  timer). A component that stops reporting goes `stale`, not silently `ok` —
  observability's whole job is catching the *absence* of a signal.
- **`unknown` ≠ `down`.** A binding present-but-unprobed (AI/IMAGES/BROWSER, cost money
  to roundtrip) is `unknown`, exactly as `probeBindings` does today. Don't spend to
  probe on a public endpoint.
- **No secret values, ever.** `autonomy_status` and `redactPublicHealth` already encode
  this; every new field is a boolean/enum/timestamp, never a secret.

### Where it aggregates — Worker as hub, KV as store, no new DB

- **Store:** KV, keyed by convention. Already in use: `sux:cron:heartbeat:*`,
  `recovery:status:<node>`. Add nothing but keys. **Do NOT introduce D1 for this** —
  it's last-write-wins presence state, KV is exactly right (per
  [[sux-engineering-taste]]). D1 stays for the things that need relational queries.
- **Read plane:** `GET /health` (already the browsable page + JSON) is the hub. Extend
  `gatherHealth()` with a `bots` section (GitHub workflow/issue state) and surface the
  existing `recovery:status:*` router health that today only `/recovery/status` shows.
- **Machine read for agents:** the same JSON already exists — an agent diagnosing a
  failure fetches `/health` (public, redacted) or calls the `autonomy_status` fn (armed
  surfaces). No new fn needed for the common case.

## Signal flow

| Edge | Mechanism | Status |
|---|---|---|
| router → Worker | signed `POST /recovery/checkin` (HMAC, replay-guarded) persists `recovery:status:<node>` | **shipped** (recovery.ts, PR #151) |
| router health → hub | Worker Tailscale `nodeStatus()` in `gatherHealth` (liveness) + the checkin KV (self-reported detail) | liveness shipped; **checkin KV → /health is the gap** |
| Worker → operator/agent | `GET /health` page + JSON; `autonomy_status` fn | **shipped** |
| Worker/CI → ticket queue | `health.yml` daily canary opens/updates an Issue; `audit.yml` drift auditor | **shipped** |
| bots → hub | workflow conclusions + open Issues; **not yet reflected in /health** | **gap (thin)** |
| operator/agent → router | `POST /recovery/enqueue` signs a command; box pulls, verifies, acts | **shipped** |
| Worker → operator (push) | none by design — pull-based. Optional: one issue on hub-detected `down` | optional |

### Escalation flow (unified)

```
detect (any tier)
   │
   ├─ safe-direction + reversible?  ── yes ─► auto-remediate in-tier, stamp heartbeat/checkin, done
   │                                          (attention-increasing: retry, restart, add-label, open-ssh)
   │
   └─ no (destructive / attention-reducing / ambiguous / repeated failure)
          │
          ▼
     open/update ONE GitHub Issue  ── the single ticket queue for all three tiers
          │   (dedup by title, like health.yml already does)
          ▼
     operator OR agent triages:
          reads /health (state) + Issue (context) + `wrangler tail` / CF observability (logs)
          │
          ├─ router fix ─► POST /recovery/enqueue (signed, TTL'd, allow-listed action)
          ├─ Worker fix ─► branch → PR → CI gate → merge (git is the undo)
          └─ bot fix    ─► branch → PR → CI gate → merge
```

**Key unification:** every tier's "I can't fix this myself" lands in the **same** place —
a GitHub Issue — so there is one queue to watch, one dedup convention, one place an agent
polls. The router can't open a GitHub Issue directly (it may be WAN-wedged), so its
escalation path is: checkin reports `down` → Worker `/health` shows it stale/down → the
existing `health.yml` canary (or a small extension of it) opens the issue on the router's
behalf. **The Worker is the router's uplink to the ticket queue.**

## Per-tier remediation policy (the safe-direction rule, applied)

Directional test from [[safe-direction-autonomy]]: **reversible AND attention-increasing
→ auto; reversible-but-attention-reducing, or irreversible → gate.**

### Tier 1 — GitHub bots
- **Auto (safe):** open/update an Issue (adds attention), add labels, open a PR labeled
  `self-improve` (never merges), auto-merge a **green + bug/security-labelled** PR
  (per [[autonomy-config-defaults]]), rebase/branch-update to unblock the gate.
- **Gated:** merging features/security-behavior/`.github`-auth-diff changes (the
  security gate fails **closed** on those), auto-authoring content, anything that
  removes attention.
- **Watchdog role:** `health.yml` + `audit.yml` already are the bot-tier watchdog —
  they canary tests, smoke-check the live Worker, and open issues on drift. Extend
  `audit.yml`/`health.yml` to also assert the autonomy invariant (branch protection +
  required checks still on — the "silently flipped off once" risk from
  [[autonomous-pipeline-lessons]] #4 and the verdict's step 3).

### Tier 2 — router (owl-tegu)
- **Auto (safe / attention-increasing / self-restoring):** `restart-tailscale`,
  `restart-dns`, `restore-config` (to last-good), retry connectivity, **`open-wan-ssh`
  as a self-heal to restore operator reachability** (it *adds* an access path when the
  box is isolated — attention-increasing). These are exactly the box-local
  `RECOVERY_ACTIONS`, and the box already executes them only under HMAC verification.
- **Gated / operator-enqueued only:** `reboot` (drops all state/connectivity — the box
  may self-heal softer first, but a reboot as remediation is operator-enqueued),
  `close-wan-ssh` (removes an access path — attention-reducing), any config change that
  narrows access. These come **down the dead-drop** as a signed, TTL'd, allow-listed
  command — never self-initiated for the attention-reducing ones.
- **Invariant already structural:** the dead-drop allow-list (`RECOVERY_ACTIONS`) is the
  defense-in-depth carrier — the box will only ever act on those 7 strings, signed. Keep
  the allow-list tiny; that *is* the safety.

### Tier 3 — Worker
- **Auto (safe):** retry/degrade-open (rate-limiter fails open, heartbeat swallows KV
  errors — already the idiom), serve last-good, stamp heartbeats. Deploy of a **fix**
  merges+deploys autonomously (per [[sux-deploy-autonomy-policy]]).
- **Gated:** feature/security PRs (human merge), Mode-B Dropbox writes (dormant until
  `DROPBOX_FULL_*`), mail-triage act (reversible allow-list only:
  label-add/unarchive/undelete — never delete/send, per the memory). All already gated
  in-Worker via `autonomy_status`'s mirrored flags.

## Reuse map — build on these, do NOT rebuild

| Need | Existing piece | Action |
|---|---|---|
| Health hub (read) | `github-handler.ts` `gatherHealth()` + `/health` page | **extend** — add `bots` + `router` sections |
| Health store | KV (`sux:cron:heartbeat:*`, `recovery:status:*`) | **reuse** — add keys only, no D1 |
| Cron/subsystem liveness | `cron-heartbeat.ts` (`recordHeartbeat`/`readHeartbeats`, `CRON_STALE_MS`) | **reuse** as-is; it's the model to copy |
| Binding health | `probeBindings()` / `bindingsOk()` | **reuse** as-is |
| Router uplink + command channel | `recovery.ts` dead-drop + `recovery-checkin.sh` (PR #151) | **reuse** — surface its KV in /health |
| Armed-surface mirror | `autonomy_status` fn | **reuse** — the machine-readable autonomy view |
| Metrics / SLO | `metrics.ts`, `observability.ts` (`/metrics`,`/logs`,`/feedback`), Grafana (Loki+Prom) | **reuse** — debug logs live here |
| Ticket queue | GitHub Issues via `health.yml` + `audit.yml` (dedup-by-title pattern) | **reuse + extend** — one issue convention for all tiers |
| CI regression canary + live smoke | `health.yml` (daily test + 401 smoke) | **reuse + extend** — add autonomy-invariant assert |
| Redaction for public endpoint | `redactPublicHealth()` | **reuse** as-is |
| Debug logs | `wrangler tail`, CF observability MCP, `/logs`, Grafana | **reuse** — no new logging plane |

## Debug affordances (operator OR agent)

A cross-tier failure is diagnosed with tools that **already exist** — the design just
names the runbook:

1. **State:** `GET /health` (one JSON: all three tiers' component statuses) →
   `autonomy_status` fn (what's armed).
2. **Router state when unreachable inbound:** `GET /recovery/status?node_id=owl-tegu`
   (last signed checkin health) — the dead-drop *is* the debug channel for a WAN-wedged
   box. Enqueue `noop` to confirm the pull loop is alive.
3. **Logs:** `wrangler tail` / CF observability MCP (`query_worker_observability`) for
   the Worker; `/logs` rolling call log; Grafana (Loki=logs, Prom=metrics — keep both,
   the verdict said don't kill them); the router ships its own health in the checkin
   body.
4. **Tickets/history:** GitHub Issues (open = active incident, dedup by title) + the
   workflow run logs linked from each auto-opened issue.
5. **Downward action:** `POST /recovery/enqueue` (signed, allow-listed, TTL'd) for the
   router; PR→CI→merge for Worker/bots.

An agent doing this needs no new tools: it fetches `/health`, reads/greps Issues via
`gh`, tails via the CF observability MCP, and enqueues via the admin-bearer recovery
route.

## Failure modes + guards

- **Silent absence of signal** — a stalled loop reports nothing. *Guard:* staleness is
  derived at read time (already for cron); apply the same to the router checkin and bot
  workflows. Absence → `stale`, not `ok`.
- **The watchdog itself dies** — if the Worker is down, `/health` is down and nothing
  aggregates. *Guard:* the external CI canary (`health.yml`, GitHub-hosted, independent
  of CF) smoke-checks the live Worker daily and opens an issue — the watchdog-of-the-
  watchdog is deliberately in a *different* failure domain.
- **Autonomy invariant flips off** ([[autonomous-pipeline-lessons]] #4: private-repo
  branch protection silently dropped) — *Guard:* extend `health.yml`/`audit.yml` to
  API-assert `required_status_checks` + auto-merge rule daily, open an issue on drift
  (verdict step 3). This is the highest-leverage add.
- **Dead-drop replay / stale command fires late** — already guarded: nonce single-use,
  timestamp window, per-command TTL, deliver-and-consume.
- **Escalation storm** — every tick opens a duplicate issue. *Guard:* the existing
  dedup-by-title pattern in `health.yml` (find open issue by title → comment, not new).
  Reuse it for every tier's escalations.
- **Committed-generated-artifact merge treadmill** ([[autonomous-pipeline-lessons]] #1)
  — a watchdog that commits a status file per run would re-create the exact treadmill we
  removed. *Guard:* status lives in **KV, never git**. No status file is committed.
- **Router auto-heals in the wrong direction** — e.g. auto-`close-wan-ssh` locks the
  operator out. *Guard:* the allow-list split — attention-reducing actions are
  operator-enqueued only, never box-self-initiated.
- **False `down` from a probe that costs money** — *Guard:* pay-per-call bindings stay
  presence-only (`unknown`), never roundtripped on the public endpoint.

## NOT building (explicit)

Per [[sux-design-verdict-2026-07]] and [[sux-engineering-taste]] — these are the
temptations this design deliberately refuses:

- **A dedicated status/dashboard service or new Worker.** `/health` + Grafana already
  are the dashboard. No new UI plane, no third Grafana, no status-page SaaS.
- **A new D1 "incidents" / time-series health table.** KV presence-state is enough;
  Grafana holds the metrics history. No relational store for last-seen booleans.
- **Cloudflare Queues / Workflows / Durable Objects / an event bus** to move health
  events. Pull-based `/health` + cron heartbeats + the dead-drop cover it. (Workflows'
  `waitForEvent` stays reserved for the *propose-PR→await-Colin* shape only, later,
  gated.)
- **A rule-DSL / policy engine** for remediation. The policy is ~20 lines of
  allow-lists + the safe-direction test, inline. No engine.
- **A push-notification / paging integration** (PagerDuty, webhooks, SMS). One
  GitHub Issue is the notification; Colin/an agent polls. Add real paging only if a
  genuine always-on SLA appears (it doesn't for one user).
- **A generalized cross-tier "agent orchestrator"** that watches and auto-drives fixes
  across tiers. The operator/agent-in-the-loop reading `/health` + Issues is the
  orchestrator. Don't build a meta-controller.
- **Bidirectional command channel for Worker or bots.** Only the router needs a
  dead-drop (it's the one that goes unreachable-inbound). The Worker and bots are
  reached normally (HTTPS / git / gh). One command channel, not three.
- **A new secret store or auth scheme.** Reuse the recovery HMAC/bearer tiers and the
  existing op→Worker/GitHub secret model (`docs/secrets.md`).

## Phased build order

**Done (shipped) — the plane already stands:**
- Worker `/health` hub with config/tailscale/upstream/metrics/cron/bindings aggregation.
- Cron heartbeat model (`cron-heartbeat.ts`) with derived staleness.
- Recovery dead-drop: signed checkin (router→Worker health), signed enqueue
  (operator→router commands), allow-listed box-local actions (PR #151).
- `autonomy_status` armed-surface mirror; `redactPublicHealth`.
- CI watchdog: `health.yml` daily canary + smoke check + dedup-issue-on-failure;
  `audit.yml` drift auditor; the "no-dumb-shit" security gate.

**Next (the three thin missing edges — one PR each, land green):**
1. **Surface the router's dead-drop health in `/health`.** `gatherHealth()` reads
   `recovery:status:<node>` for each known node and emits a `router` component (with
   derived staleness vs the checkin timer). Today it's only visible via the
   admin-authed `/recovery/status`; the hub should show it. *(Small, reuses everything.)*
2. **Assert the autonomy invariant daily** (highest leverage). Extend `health.yml` (or
   `audit.yml`) to API-check `required_status_checks` + the auto-merge rule are still on,
   open/update an issue on drift. Closes the "[[autonomous-pipeline-lessons]] #4 flipped
   off silently" hole — verdict step 3.
3. **Reflect bot health in `/health`.** A `bots` section derived from recent workflow
   conclusions + count of open watchdog-opened issues, so all three tiers read from one
   page. *(Cheap: `gh`/GitHub API read, cached briefly like the health snapshot.)*

**Optional (only if a real need appears — resist by default):**
- Router escalation-to-issue *via the Worker*: when `/health` sees a router node
  `down`/`stale`, the CI canary opens an issue on its behalf (the router's uplink to the
  ticket queue). Do this only once the router daemon is live and actually goes dark.
- A single machine-readable `watchdog_status` fn that unifies `/health` + `autonomy_status`
  + open-issue count into one agent-facing call — only if agents find fetching the three
  separately annoying. Rule-of-3 before generalizing.
- Push paging — only if an always-on SLA ever materializes for more than one user.

---

*Design principle throughout: git is the undo, CI is the gate, the dead-drop is the
lifeline, and GitHub Issues is the one queue. Connect what exists; refuse the framework.*
