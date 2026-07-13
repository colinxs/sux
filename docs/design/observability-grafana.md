# owl-tegu observability → Grafana (logs + metrics)

Design + light prototype. Opinionated, KISS, gateway-SACRED. Complements — does not
duplicate — `docs/design/generalized-watchdog-debug.md` (the `/health` hub + dead-drop),
the sux Worker `/health`, and the recovery dead-drop.

## TL;DR / recommendation

**Grafana Cloud free tier, push-only. Zero query/storage/UI load on the box.**
The gateway ships metrics OUT (Prometheus `remote_write`) and logs OUT (Loki push) to
Grafana Cloud. Nothing to scrape, no local Prometheus, no local Loki, no local Grafana.
This is the only option that respects a 3.8 GB fanless gateway that is *also* about to run
a render container.

- **Metrics agent:** `prometheus-node-exporter-lua` (musl-native, per-scrape, ~single-digit
  MB) with the `hwmon`+`thermal`+`nat_traffic`+`netstat`+`nft-counters`+`textfile`
  collectors — **not** the `-ucode` variant (confirmed below: ucode is lighter but has **no
  thermal/hwmon collector**, and thermals are non-negotiable on a fanless Protectli + NVMe).
  Scraped locally by a tiny **Grafana Alloy** (or `vmagent`) shipper that `remote_write`s to
  Grafana Cloud. Alloy is the one Go binary we run; it is the push limb.
- **Logs agent:** the box already runs **rsyslog** (not busybox logd). Point rsyslog at
  Alloy's `loki.source.syslog` (or Alloy tails `/var/log/*` + the docker json logs) → Grafana
  Cloud Loki. No promtail/vector/omhttp needed (none are in the 25.12 feed anyway — see
  below).
- **One agent, one push:** a single Alloy process does *both* metrics `remote_write` and log
  push, so the resident footprint is one ~30–60 MB Go process, not a stack.

**Split of responsibilities (one observability story):**
| Plane | Owner | What |
|---|---|---|
| **Presence / state** ("is it up, what's armed") | sux Worker `/health` + `recovery:status:*` KV | booleans, last-seen, autonomy flags — already shipped |
| **Escalation / tickets** | GitHub Issues | one dedup'd queue for all three tiers — already shipped |
| **Downward commands** | recovery dead-drop | signed, allow-listed — already shipped |
| **Time-series metrics** (NEW) | Grafana Cloud Prometheus | CPU/mem/temp/net/conntrack/disk trends, alerting |
| **Log search** (NEW) | Grafana Cloud Loki | dnsmasq/ctrld/cloudflared/dockerd/ksmbd/suxproxy lines |

Grafana is the **history + trend + log-search** plane. `/health` stays the **is-it-alive
right-now** plane. They answer different questions; neither replaces the other.

## Ground truth (reproduced live on owl-tegu, 2026-07)

Reproduced against `root@100.98.238.70`, box left exactly as found (prototype removed).

| Fact | Value |
|---|---|
| OS | OpenWrt 25.12.3 r32912, kernel 6.12.85, x86_64 **musl** |
| Package manager | **apk** (not opkg) — feed has 11,521 pkgs |
| CPU | Intel Celeron **N5105 @ 2.0 GHz, 4c**; load avg **0.75** (~18%) |
| RAM | **3808 MB** total; **~320–460 MB used at rest**, ~3.2 GB available; **no swap** |
| Storage | `/` = 28.7 GB eMMC (1 GB used); **NVMe 233 GB at `/mnt/nvme` (2.9 GB used)**; docker root on eMMC `/opt/docker` |
| Thermals | `thermal_zone1` 51 °C; hwmon0 `acpitz`, hwmon1 **`nvme`**, hwmon2 **`coretemp`** |
| conntrack | 597 / 65536 |
| Roles running | dnsmasq, ctrld (Control D), tailscaled, cloudflared, kadnode, ksmbd (config present), dockerd (1 container up), uhttpd, suxproxy, unbound, sqm |
| DNS | **dnsmasq is the resolver, ctrld is upstream**; ctrld has **no** `metrics`/prometheus subcommand or config in this build |
| rsyslog | present + UCI-driven (`/etc/rsyslog.conf`), monolithic apk build |

### Package availability (apk feed, confirmed present)
- **Metrics:** `prometheus-node-exporter-lua` (+ collectors: `hwmon`, `thermal`, `netstat`,
  `nat_traffic`, `nft-counters`, `textfile`, `openwrt`, `unbound`, `filesystem`, …),
  `prometheus-node-exporter-ucode` (+ `dnsmasq`, `netstat`, `openwrt`, `wifi`), all
  `collectd-mod-*`, `telegraf` / `telegraf-full`.
- **SMART/NVMe:** `nvme-cli 2.15`, `smartmontools 7.5` (+drivedb).
- **NOT in the feed:** Grafana Alloy, Loki, promtail, vector, grafana — **none packaged for
  OpenWrt**. Alloy/vmagent must be dropped in as a static musl binary (documented below), or
  logs go via rsyslog's built-in HTTP path. `rsyslog-mod-omhttp` is not a separate apk (rsyslog
  is monolithic; omhttp presence is uncertain — treat rsyslog→Loki as needing Alloy in front).

### Prototype run (light + reversible — done, then removed)
Installed `prometheus-node-exporter-ucode` + `-openwrt` + `-netstat`, confirmed it works,
then **fully removed it** (packages + UCI config; port closed; box back to as-found):
- Binds **loopback `127.0.0.1:9101`** by default (UCI `listen_interface 'loopback'`) — never
  WAN-exposed. Firewall untouched. 
- Served **353 `node_*` series**, **~22 KB** per scrape, via a tiny `uhttpd` (`~1.6 MB RSS`)
  spawned per request — no persistent daemon.
- **Memory delta: negligible** (used went 320 → 318 MB; within noise).
- **Key gap found:** the ucode variant exports **no thermal/hwmon** series — so it would miss
  CPU + NVMe temperature. That is why the recommendation is the **lua** variant (its `hwmon`
  collector reads hwmon1=nvme + hwmon2=coretemp directly). This is a reproduce-before-theorize
  correction: the "lightest" package would have silently dropped the single most important
  signal for a fanless box.

## 1. WHERE Grafana lives — decision

**(a) Grafana Cloud free tier, push-out. CHOSEN.**

Honest budget for the three options on *this* box (3.8 GB, no swap, render container incoming):

| Option | On-box RAM | On-box disk | On-box CPU | Verdict |
|---|---|---|---|---|
| **(a) Grafana Cloud push** | node-exporter-lua (per-scrape, ~5–8 MB transient) **+ one Alloy/vmagent ~30–60 MB resident** | ~0 (Alloy WAL buffer ≤ ~100 MB on NVMe) | negligible (<1% steady) | **✅ pick** |
| (b) Self-hosted Prom+Loki+Grafana in Docker | **~700 MB–1.5 GB resident** (Prom ~250 MB + Loki ~200 MB + Grafana ~150 MB + exporters) | 5–30 GB TSDB+chunks on NVMe (grows) | ongoing scrape+compact+index | ❌ too heavy — eats the render container's headroom, risks OOM on a swapless box |
| (c) Hybrid (local Prom short-retention → remote_write to Cloud) | ~300–400 MB resident | few GB | moderate | ⚠️ only if offline-buffering ever becomes a hard requirement; **not now** |

Free tier limits (ample for one box): **10k active metric series**, **50 GB logs/month**,
14-day metrics / 14-day logs retention, 3 users. node-exporter-lua emits well under 10k
series after dropping noisy collectors; box logs are far under 50 GB/mo.

Grafana Cloud free tier signup + the `remote_write`/Loki push credentials are a **Colin
action** (account + API token) — not automatable here, flagged in the rollout. Nothing is
pushed anywhere until those creds exist.

**Why not self-host on the box:** a swapless 3.8 GB gateway that must stay green while also
hosting the render container cannot safely carry a ~1 GB observability stack. If the stack
OOMs, it can take the *gateway* with it — violating "telemetry must never destabilize the
gateway." If a local Grafana is ever wanted, it belongs on a *different* host (a cheap fixed-
price VPS per `[[persistent-listener-infra]]`), never on owl-tegu.

## 2. METRICS agent — `prometheus-node-exporter-lua`

One agent, loopback-bound, scraped locally by Alloy which `remote_write`s to Cloud.

**Install (phase 1):**
```
apk add prometheus-node-exporter-lua \
  prometheus-node-exporter-lua-hwmon \
  prometheus-node-exporter-lua-thermal \
  prometheus-node-exporter-lua-nat_traffic \
  prometheus-node-exporter-lua-netstat \
  prometheus-node-exporter-lua-nft-counters \
  prometheus-node-exporter-lua-textfile \
  prometheus-node-exporter-lua-openwrt
# UCI: keep listen_interface 'loopback', listen_port 9100 — NEVER expose on WAN
```

**What it collects, mapped to this box's roles:**
| Signal | Source | Collector |
|---|---|---|
| CPU load/util per core, context switches | `/proc` | base + `netstat` |
| Memory / buff-cache / (no swap) | `/proc/meminfo` | base |
| **CPU temp + NVMe temp** | hwmon2 coretemp, hwmon1 nvme | **`hwmon`** + `thermal` |
| Disk free/used (eMMC `/`, NVMe `/mnt/nvme`) | `/proc`, statvfs | `filesystem` |
| Net bytes/pkts/errors per iface (WAN/LAN/tailscale0) | `/proc/net/dev` | base |
| **conntrack count/max** (proxy + gateway load) | netfilter | **`nat_traffic`** |
| nftables rule counters (firewall/SQM) | nft | `nft-counters` |
| boot time / uptime | `/proc` | base |
| OpenWrt release/board labels | ubus | `openwrt` |

**Signals node-exporter can't get natively → `textfile` collector (one cron script,
`* * * * *` or every 5 min, writes `/var/lib/node-exporter/textfile/*.prom`):**
- **NVMe SMART** (wear %, media errors, power-on hours, temp): `nvme smart-log /dev/nvme0`
  (needs `nvme-cli`, confirmed available) → parse to `node_nvme_*` gauges.
- **DNS query rate / cache** (ctrld exposes no prometheus, dnsmasq is the resolver):
  `kill -USR1 $(pidof dnsmasq)` dumps cache stats (hits/misses/insertions/evictions) to
  syslog → parse the last line, or read dnsmasq's stats; emit `node_dnsmasq_*`. **Control D's
  own cloud dashboard remains the authoritative per-domain query analytics** — the textfile
  metric is just local rate/cache-hit, not a reimplementation.
- **tailscale**: `tailscale status --json` → peer count, tx/rx, last-handshake age.
- **ksmbd I/O**: sessions/open-files from `/sys/class/ksmbd` (or `ksmbd.control`) +
  NVMe `/mnt/nvme` throughput already covered by filesystem/diskstats.
- **docker/render**: `docker stats --no-stream` → per-container CPU/mem/net for the render
  container (cheap, one line per container).
- **cloudflared / suxproxy**: process up + RSS via a `pgrep`/`/proc` one-liner (liveness).

**Shipping:** local **Grafana Alloy** (`prometheus.scrape` → `prometheus.remote_write`) at
15–30 s scrape interval. `metric_relabel_configs` drop high-cardinality noise (per-CPU
softirq detail, unused netstat families) to stay well under the 10k-series free cap. Alloy
buffers to a WAL on NVMe so a WAN blip doesn't lose points and doesn't pressure RAM.

*(Alternative if we refuse a Go binary entirely: `telegraf` can both scrape and remote_write,
but it is heavier (~40–80 MB) and more than we need; `vmagent` is a lighter remote_write-only
option than Alloy but then logs need a separate path. Alloy = one process for both, so it
wins on total footprint.)*

## 3. LOGS agent — rsyslog → Alloy → Grafana Cloud Loki

The box already runs **rsyslog** (musl, present, UCI-driven) — do not add promtail/vector
(neither is packaged for OpenWrt 25.12; both would be foreign static binaries).

**Path (lightest that works on musl):**
```
service logs (syslog: dnsmasq, ctrld, cloudflared, dockerd, ksmbd, suxproxy, kernel)
      │  rsyslog forwards RFC5424 over TCP to localhost
      ▼
Alloy  loki.source.syslog (listen 127.0.0.1)  →  loki.write → Grafana Cloud Loki
      │  + loki.source.file for /mnt/nvme/... docker json logs the render container writes
      ▼
Grafana Cloud Loki  (labels: host=owl-tegu, service=<unit>, level=<sev>)
```
- **rsyslog config (UCI, additive):** add one `omfwd` action to ship to `127.0.0.1:<alloy>`;
  keep the existing local `/var/log` writes untouched. rsyslog already normalizes per-service
  facilities, so `service` and `level` labels fall out for free.
- **Docker/render logs:** dockerd's json-file driver writes under `/opt/docker`; point Alloy's
  `loki.source.file` at the container log path (or set the container's log driver to `syslog`
  so it flows through the same rsyslog pipe — preferred, one path).
- **Cardinality discipline:** labels stay low-cardinality (`host`, `service`, `level`); the
  log *line* carries the detail. No per-request/IP labels (that blows the 50 GB/mo cap and
  Loki's index).
- **Volume guard:** drop `debug` at rsyslog before forwarding; ctrld/dnsmasq per-query logging
  stays OFF (Control D's dashboard already has query analytics) — we ship service/error logs,
  not a full DNS query firehose.

**Why not rsyslog-omhttp direct to Loki:** omhttp isn't a confirmed separate module in this
apk build, and going through Alloy gives one uniform push limb (retries, batching, WAL) for
both logs and metrics. If a future need is truly agentless, rsyslog→Loki HTTP is the fallback.

## 4. DASHBOARDS — the panels that matter for THIS box

Three Grafana dashboards (import as JSON; the node-exporter-lua community dashboard is the
base, trimmed to this box). Grafana Cloud hosts them — zero box cost.

**A. Gateway / host health (the SACRED-box overview)**
- CPU load1/5/15 vs 4 cores; per-core util; context-switch rate.
- Memory used / buff-cache / **available** (swapless — an available-headroom panel with a
  threshold alert is the OOM early-warning, esp. once the render container lands).
- **Thermals:** CPU coretemp + NVMe temp on one time-series, threshold bands (throttle
  warning) — the fanless-Protectli panel that matters most.
- Uptime / boot-time; unexpected-reboot annotation.
- WAN iface tx/rx + errors/drops; SQM/nft drop counters.

**B. DNS + network services**
- dnsmasq query rate, cache hit ratio, insertions/evictions (from textfile).
- Control D upstream reachability (ctrld process up + resolve-latency probe) — link out to
  Control D's cloud dashboard for per-domain analytics (single source of truth there).
- conntrack count vs max (proxy saturation early-warning).
- tailscale peers up / tx-rx / handshake-age; cloudflared tunnel up + throughput
  (render data-plane); suxproxy process up + conn count.

**C. Storage / NAS / render**
- NVMe `/mnt/nvme` free/used trend; eMMC `/` free (docker root — small, watch it).
- **NVMe SMART:** wear-leveling %, media/integrity errors, power-on hours, temp (textfile) —
  the NVMe-health early-warning for the NAS + render workloads.
- ksmbd sessions / open files / throughput (via NVMe diskstats).
- Docker/render container CPU/mem/net (`docker stats` textfile); OOM-kill annotation.

**Watchdog / recovery signals (a row, not a 4th dashboard — it ties into `/health`):**
- A single-stat / annotation row pulling the **recovery dead-drop last-checkin age** and the
  **`/health` component states** (see §6). These stay *presence* signals surfaced *alongside*
  the metrics for correlation ("temp spiked → then checkin went stale"), **not** re-stored as
  time series. Grafana reads them via a JSON/Infinity datasource hitting the Worker's public
  `/health` JSON — read-only, no new store.

**Alerts (Grafana Cloud alerting, free):** memory-available < 300 MB; CPU temp > 85 °C;
NVMe temp > 70 °C or SMART media-errors rising; NVMe/eMMC free < 10%; conntrack > 80% of max;
WAN iface down. Alert *notification* = open/annotate — route to the **same GitHub Issues
queue** (§6) so there is still one ticket plane, not a second pager.

## 5. RESOURCE BUDGET (concrete, on-box)

Steady-state added load with the CHOSEN option (a), measured/estimated against the live box's
~320–460 MB-used / 3.2 GB-available baseline:

| Component | RAM (resident) | CPU | Disk | Notes |
|---|---|---|---|---|
| node-exporter-lua | ~5–8 MB **transient** per scrape (fork lua, exits) | <1% at 15–30 s | 0 | no persistent daemon; uhttpd-fronted |
| textfile cron (nvme/dns/docker/ts) | ~0 (short-lived shells) | negligible, every 1–5 min | few KB `.prom` files | keep interval ≥ 60 s |
| **Grafana Alloy** (scrape+remote_write+Loki push+syslog recv) | **~30–60 MB resident** | 1–2% | WAL buffer ≤ ~100 MB on **NVMe** | the one persistent Go process |
| rsyslog omfwd action | ~0 extra (already running) | negligible | 0 (reuses existing) | additive UCI action |
| **Total added** | **~35–70 MB resident** | **~1–3%** | **≤ ~100 MB NVMe** | comfortably fits; render container keeps its headroom |

Baseline load avg is 0.75/4 cores — abundant CPU. The only scarce resource is **RAM (no
swap)**; option (a) adds < 70 MB resident, vs option (b)'s ~1 GB. **On a swapless 3.8 GB box
that must also run the render container, self-hosting Grafana/Prom/Loki is not safe — option
(a) is the honest choice.**

## 6. TIE-IN — one observability story

Grafana **complements** the shipped `[[generalized-watchdog-debug]]` plane; it does not
duplicate it. The mental model:

```
        Grafana Cloud (NEW: history plane)          Worker /health (state plane, shipped)
        ├─ Prometheus: metric trends + alerting      ├─ config/tailscale/upstream/metrics/
        └─ Loki: service log search                  │  cron/bindings component states
              ▲  push (Alloy)                         ├─ recovery:status:* (router checkin)
              │                                       └─ autonomy_status (armed flags)
        owl-tegu ──────────────────────────────────────────► GitHub Issues (ticket plane, shipped)
        node-exporter-lua + rsyslog + Alloy              one dedup'd queue for all tiers
                                     │
                                     └── recovery dead-drop (command plane, shipped)
```

- **`/health` vs Grafana:** `/health` answers *"is it alive and what's armed, right now"*
  (booleans, last-seen, redacted, pull-based, external-CI-canaried). Grafana answers *"what
  has the trend been, and let me search the logs"* (time series + log lines). A failure is
  triaged with **both**: `/health` says *down/stale*, Grafana says *why* (temp climbed, mem
  ran out, error log spiked). This is exactly the debug runbook step 3 in the watchdog design
  ("Grafana = Loki logs + Prom metrics") — this doc is the concrete build of that line.
- **Dead-drop stays the router's uplink:** when the box is WAN-wedged, Alloy can't push and
  Grafana goes stale — that *absence* is itself a signal, and the **dead-drop checkin +
  `/health` staleness** (not Grafana) remains the authoritative "is the box reachable" path.
  Grafana never becomes a reachability dependency. Telemetry loss ≠ box down; poll+sweep and
  the checkin still guarantee state (`[[persistent-listener-infra]]` principle).
- **One ticket queue:** Grafana Cloud alerts route to **GitHub Issues** (webhook/contact
  point), reusing the dedup-by-title convention — no second pager, no PagerDuty. Metrics
  alerting becomes another *producer* into the existing single queue.
- **No new store, no committed artifacts:** Grafana holds the metrics/log history (per the
  watchdog design's explicit "Grafana holds the metrics history; KV holds presence; no D1
  time-series table"). Nothing about this writes a status file into git — dashboards are JSON
  imported into Grafana Cloud, not tracked per-run.

## Phased rollout (cheapest-first, each step reversible)

**Phase 0 — Colin action (blocks push):** create Grafana Cloud free account; generate the
Prometheus `remote_write` endpoint+token and the Loki push endpoint+token. Store in the sux
secret model (`docs/secrets.md` / 1Password), delivered to the box like other box secrets.
*Nothing ships until this exists.*

**Phase 1 — metrics, local only (no creds needed, fully reversible):**
`apk add prometheus-node-exporter-lua` + hwmon/thermal/nat_traffic/textfile/netstat/openwrt;
keep loopback-bound; confirm `curl 127.0.0.1:9100/metrics` shows thermals + NVMe temp.
(This session already proved the mechanism with the ucode variant and removed it.)

**Phase 2 — ship metrics:** drop in Alloy (static musl binary under `/mnt/nvme`, an init.d
service); configure `prometheus.scrape` → `remote_write` with the Phase-0 creds + relabel
drops; verify series land in Grafana Cloud under 10k cap.

**Phase 3 — textfile enrichers:** cron script for NVMe SMART (`nvme-cli`), dnsmasq
cache stats, tailscale, docker stats, ksmbd → `.prom` textfiles.

**Phase 4 — logs:** add rsyslog `omfwd` → Alloy `loki.source.syslog` → Loki; set the render
container's log driver to syslog so it joins the same pipe.

**Phase 5 — dashboards + alerts:** import the three trimmed dashboards; wire Grafana alerts →
GitHub Issues contact point; add the `/health` JSON datasource row for the presence tie-in.

Land each phase, confirm green, and confirm the gateway is unbothered before the next. Any
phase reverts with `apk del` / removing the init.d service / dropping the UCI action.

## What NOT to run on the gateway (explicit)

- **No local Grafana, Prometheus, or Loki.** ~1 GB stack on a swapless 3.8 GB box that also
  runs the gateway + render container. If a self-hosted Grafana is ever wanted, it goes on a
  separate fixed-price VPS (`[[persistent-listener-infra]]`), never owl-tegu.
- **No telegraf-full / heavy collectors.** node-exporter-lua + one Alloy covers it at a
  fraction of the RAM.
- **No WAN-exposed exporter.** Keep node-exporter on **loopback** (its default, confirmed);
  scraping is local by Alloy only. Never open 9100/9101 on the WAN firewall zone.
- **No per-DNS-query / per-request log firehose to Loki.** Ship service + error logs; Control
  D's dashboard is the per-domain query analytics. Debug ≠ debug-level-everything-to-cloud.
- **No second ticket/pager plane.** Alerts fan into the existing GitHub Issues queue.
- **No new D1 / KV time-series table, no committed status file.** Grafana Cloud is the history
  store; presence stays in the existing KV + `/health`.
- **No making Grafana a reachability dependency.** The dead-drop + `/health` staleness remain
  the authoritative "is the box up" signal; telemetry loss is a symptom, not the monitor.

---

*Verified live, box left as-found. Grafana Cloud push = the KISS, gateway-safe answer:
the box ships metrics + logs OUT through one small agent, and the existing `/health` +
dead-drop + Issues planes stay the state/command/ticket story they already are.*
