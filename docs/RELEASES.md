# SuxOS Release Ledger

Authoritative version index. **GitHub issues are the durable record** of scope — this file is
a thin index (version → theme → tracking issue), not a duplicate of the plans. The current
shipped version is defined by `package.json` (`sux` is the anchor package).

Convention: `vMAJOR.MINOR`. A minor is a coherent themed release; a patch (`vX.Y.Z`) is cut
only for fixes to a shipped minor. One minor is planned/optimized per release-planning pass.

## Shipped

### v1.0.0 — 2026-07-22
First cut. 7 package releases (sux, suxlib, suxrouter, claude-config, suxos-net, nix, suxdash);
`sux` tag `v1.0.0`. Cut PR #1345.

### v1.1.0 — 2026-07-22
Retrieval + reliability drive. Cut PR #1374. `sux` = `1.1.0`.

## In progress

### v1.2 — "Wire It Up: solidify the deterministic foundation"
Arc: **#1420**. The foundation below the capabilities arc — get the deterministic pieces solid
and shipping so the 1.3 control plane has clean inputs. **Zero new infrastructure** (KISS):
every item improves or simplifies a system that already exists.

**Must-have**
- suxos-net: wire `/api/*` from stubs to real suxvault data — suxos-net#41
- suxos-net: QA thin-proxy to oracle `ask`; delete the dead in-repo Vectorize path — #1419
- mail sieve v3: converge 3 tagging lineages, fix 6 confirmed defects (also the future router
  tier-0) — #1417
- recall relevance-feedback loop (also feeds the future decay `strength_S`) — #1430
- this release ledger + a `v1.2` issue label (release-tracking hygiene)

**Should-have** — JMAP push #1408 · FHIR→agenda #1286 · suxdash Life panel #25 · MyChart bug fixes.

**Deferred out of 1.2** — the D1 control plane / router / graduated-trust (→ 1.3, introduced
where it is *used*, not pre-staged); box-resident tiers (→ 1.4).

## Roadmap

### v1.3 — "Edge control plane" (the wedge)
Arc: **#1444**. Edge-resident content-router + graduated-trust + memory-hygiene. Rides the
existing Vectorize index + a new D1 store; needs nothing from the home box.

### v1.4 — "Box-resident upgrades"
Arc: **#1444** (later phases). Best-effort box tiers: heavier vector/graph store, real-time
daemon, voice→draft capture, synthesis engine + specialist lenses.

## Decisions recorded here so they are not re-derived

**Edge → home-box reachability (researched 2026-07-24).** A Cloudflare Worker CANNOT reach a
home Postgres via Hyperdrive-over-Tunnel (fails: Cloudflare error 2015 / HTTP 530). The working,
lowest-complexity path is an **HTTP/REST shim** on the box behind cloudflared's HTTP ingress
(Cloudflare publishes a reference implementation; the Worker just `fetch()`es it) — structurally
immune to that failure class. Hyperdrive-over-Workers-VPC (GA 2026-04-29) is a fast-follow to
prototype, not a ship-blocker. This is why box tiers are 1.4, not 1.2, and why the 1.3 wedge is
edge-only.

**Router storage substrate for 1.3 (researched 2026-07-24).** A D1 database is backed by a
single Durable Object, so its write-serialization domain is the whole database, not the row —
naive per-decision `UPDATE`s on trust counters contend a shared write queue. The
Cloudflare-native pattern (no new vendors) is **D1 (append-only audit log + decay-sweep table)
plus a Durable-Object-per-route aggregation layer** for the hot counters. D1 read-replication
(Sessions API) helps the read path but does not solve the counter race. Design 1.3's storage as
D1+DO from the start; do not ship a naive raw-D1 ledger.

---
_Last updated 2026-07-24. Edit this alongside the tracking issues, never instead of them._
