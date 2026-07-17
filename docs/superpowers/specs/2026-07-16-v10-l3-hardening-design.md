---
title: SuxOS v10 L3 — harden, correct, make mergeable
status: draft (pending owner review)
type: design
arc: v10 (L3 hardening — follows the Retrieval Plane spec)
owner: m@colinxs.com
updated: 2026-07-16
summary: "Turn the live-but-unsafe sux-compute L3 skeleton into something safe to run, honest about its limits, and mergeable without wedging the repo — merge-safety + CI (A), an auth gate (B), and a rootless-dind re-image (C). Egress cutover (D) and the L0 job substrate are explicitly out of scope."
---

# SuxOS v10 L3 — harden, correct, make mergeable

## 1. Why this exists

The v10 L3 walking skeleton (`compute/` — the `sux-compute` Worker + dind box + Workers-VPC
proof) shipped live the same day it was designed. A four-dimension audit (2026-07-16) plus
four platform-reality research runs found it is simultaneously **live, internet-exposed,
un-type-checkable, and un-mergeable** — because it is a second wrangler project inside an
auto-deploy repo with no CI, so a green `wrangler deploy` never had to prove auth,
types, or merge-safety. One finding (the unauthenticated public bridge into the home LAN)
was already closed with a reversible stopgap; this spec is the durable correction.

This is a **hardening + correction** arc, not a feature arc. It builds nothing on the
Retrieval Plane's F1–F15 roadmap. It makes the ground under L3 solid so the feature bursts
can stand on it.

## 2. Scope

**In scope — three parts, independently landable:**

- **A — Merge-safety + CI.** Stop `compute/` from wedging the repo's type-check/deploy, and
  give it its own gates so it is no longer an out-of-band manual deploy.
- **B — Auth gate.** Replace "no public URL" (the stopgap) with real, durable
  authentication so the Worker is reachable only by its intended callers.
- **C — Rootless dind experiment.** Re-image the box onto the only vendor-supported dind
  path, fix the correctness/observability defects, and label it honestly as an experiment.

**Explicitly out of scope (named, not forgotten):**

- **D — Egress cutover** (VPC ⇄ Tailscale transport swap, `proxy.ts`, `_vpc_selftest`,
  Funnel/HMAC deletion). Decisions D-egress are recorded in §8 but built in a later unit.
- **L0 job substrate (F7/F8)** — the queue→Workflow idempotency contract (audit BLOCKER-2)
  is the gate for the L0 burst, designed separately.
- **L2 AI Search / corpus (F13/F14)** — greenlit for v10, built in a later burst.

**Carried-forward architecture decisions (owner-directed 2026-07-16):** keep the full
Cloudflare edge stack — Workers + Workers VPC + Containers (Containers demoted to the
experiment of Part C); AI Search is in the v10 scope (later burst); persistent/privileged
Docker (D11) runs on the home router / OpenWRT node now, splitting to a dedicated box later.

## 3. Part A — Merge-safety + CI

### A1 — Un-wedge the root type-check (clears audit BLOCKER-1)
The root `tsconfig.json` has no `include` and only `exclude: ["research-tools"]`, so it
compiles `compute/src/index.ts` against `@cloudflare/containers` — a dep the root never
installs — failing `npm run type-check` (`TS2307`), the first required gate in both
`ci.yml` and `deploy.yml`. Merging as-is red-lines every open PR and blocks auto-deploy.

**Decision A1:** set root `tsconfig.json` `exclude: ["research-tools", "compute"]` — the
exact precedent already used for `research-tools` ("a separate Worker with its own build").
`gen:index` (scans `sux/src/fns`) and the `wrangler deploy --dry-run` (scoped to
`sux/wrangler.jsonc`) are unaffected — verified during the audit.

### A2 — Make `compute/` type-check on its own
`compute/tsconfig.json` declares `@cloudflare/workers-types` in `types` but the package is
undeclared/uninstalled (`TS2688`), and omits `skipLibCheck`, so the `@cloudflare/containers`
lib `.d.ts` clashes with workers-types (`TS2416`). The `index.ts` source is clean; the
config is not.

**Decision A2:** in `compute/`: add `@cloudflare/workers-types` to `devDependencies`; set
`"skipLibCheck": true` in `compute/tsconfig.json` (standard for Workers/Containers projects);
add `"type-check": "tsc --noEmit"` to `compute/package.json` scripts. Acceptance: `npm --prefix
compute ci && npm --prefix compute run type-check` exits 0.

### A3 — CI for `compute/`
**Decision A3:** a dedicated workflow `.github/workflows/compute-ci.yml`, triggered on
`pull_request`/`push` with `paths: ["compute/**"]`, running `npm ci` + `npm run type-check`
in `compute/`. It is **independent** of the main worker's `ci.yml` (separate project,
separate deps) and is **not** added to `main`'s required-check set, so it never gates the
core worker's merge queue.

### A4 — Deploy `compute/` through the pipeline, not by hand
The live `sux-compute` worker was shipped by a manual `wrangler deploy`; the pipeline can
neither redeploy nor roll it back.

**Decision A4:** a `.github/workflows/compute-deploy.yml` with `workflow_dispatch` (manual,
gated) as the initial trigger — Containers deploys build the image, which the GitHub-hosted
runner's Docker daemon supports. Auto-deploy on push-to-`main` under `paths: compute/**`
graduates in once A1–A3 are green for one cycle. Credentials: the existing
`CLOUDFLARE_API_TOKEN`/account secrets already used by `deploy.yml`. Until A4 lands, the live
worker is documented as unmanaged in `compute/README.md`.

## 4. Part B — Auth gate

The stopgap removed the public `workers.dev` URL (`workers_dev:false` + `preview_urls:false`,
committed). That is necessary but not the durable posture — it relies on there being no
route at all. Part B makes access **intentional and authenticated**, gating every request
**before** any container boot or VPC reach.

### B1 — Keep the public front door shut
**Decision B1:** `workers_dev:false` + `preview_urls:false` stay. No `route`/custom domain is
added unless an operator HTTP entry is needed (B3). Config-pinned so a redeploy cannot
silently re-open the subdomain (confirmed by the auth research: dashboard-only disabling
reverts on deploy).

### B2 — Worker→Worker via a Service Binding (no token on the hop)
**Decision B2:** the main `sux` Worker (and any other internal caller) reaches `sux-compute`
through a **Service Binding**, declared in the caller's `wrangler.jsonc`
(`services: [{ binding: "COMPUTE", service: "sux-compute" }]`), invoked as
`env.COMPUTE.fetch(...)`. Requests never traverse a public URL; the binding declaration *is*
the authorization (capability model — there is no URL an attacker can name). No per-request
secret is needed on this hop.

### B3 — Operator / human HTTP via Cloudflare Access + in-Worker JWT validation
For the rare case the operator needs direct HTTP (debugging), put a **Cloudflare Access**
application in front of a **custom route** (workers.dev stays off per B1), and — critically
— have the Worker **validate the injected `Cf-Access-Jwt-Assertion` JWT itself**. Enabling
Access without in-Worker verification leaves a spoofing/misrouting gap (auth research).

**Decision B3:** an `assertAccess(request, env)` guard validates the JWT: RS256 signature
against the JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (keyed by
`kid`), `iss` == the team domain, `aud` == the app's AUD tag. Team domain and AUD tag are
plain `vars` in `wrangler.jsonc` (non-secret). Validate the header, not the `CF_Authorization`
cookie. On failure: `403` before any handler logic. This path is **optional** — omit the
route entirely if service-binding access suffices.

### B4 — Gate ordering (defense in depth)
**Decision B4:** a single top-of-`fetch()` guard runs before routing: if the request arrived
via the service binding, allow; else require a valid Access JWT (B3); else `403`. Neither
`/box/:name` nor `/vpc` is reachable without passing the guard. Any future break-glass shared
secret uses `crypto.subtle.timingSafeEqual` / `.verify` (constant-time) — but the primary
design needs none.

## 5. Part C — Rootless dind experiment

Platform-reality research: **privileged `docker:dind` is unsupported on Cloudflare
Containers** (non-root, no `--privileged`); the only vendor path is `docker:dind-rootless`,
which itself needs an undocumented cgroup flag; a CF engineer called the breakage
unworkable and floated pulling the DinD docs; and **all disk is ephemeral** (a slept box
wakes blank). Owner decision: keep the box as an **at-risk experiment**, not the production
compute plane.

### C1 — Re-image to rootless
**Decision C1:** base `docker:dind-rootless`. dockerd starts with
`--iptables=false --ip6tables=false --exec-opt native.cgroupdriver=cgroupfs`. Inner Docker
commands run with `--network=host` (documented in `compute/README.md`). Accept: ephemeral
state (no persisted images/containers across sleep), at-risk vendor status.

### C2 — PID-1 reaping
**Decision C2:** `tini` is PID 1 (`ENTRYPOINT ["tini","--","/usr/local/bin/start.sh"]`), so
dockerd's exiting children are reaped instead of accumulating as zombies over the box's life.

### C3 — Health reflects dockerd
**Decision C3:** `/health` performs a cheap dockerd liveness check (socket ping / `docker
version`) and returns `503` when dockerd is down, so a box with dead docker no longer reports
healthy. The Container port check uses this.

### C4 — Upstream error handling
**Decision C4:** both `getContainer(...).fetch(request)` and `env.MAC_VPC.fetch(...)` are
wrapped in try/catch returning structured `502` JSON. The VPC call gets an
`AbortSignal.timeout(...)` and a byte-capped body read (not buffer-then-slice) — the VPC
research confirms a dropped connector makes `fetch()` *throw* ("Bad Upstream"), so this path
must fail cleanly, not hang or 5xx opaquely.

### C5 — Honest framing + image hygiene
**Decision C5:** `compute/README.md` states plainly: this box is a rootless, at-risk
experiment; not the production compute plane; no v10 feature depends on it; persistent /
privileged Docker lives on the home router (D11). Pin the base image to a digest; drop apk
packages the workload doesn't use (`git`/`openssh-client` if unused); the box path regex and
sub-path forwarding are corrected so `/box/:name/health` reaches the box's `/health`.

## 6. Security posture (after this spec)

- The Worker is unreachable from the anonymous internet (B1) and every request is
  authenticated before any side effect (B4). The audit's CRITICAL and its H1/H2 (public
  `/vpc` bridge, unauthenticated box-boot DoS) are closed, not merely mitigated.
- The `sux-home` tunnel is inbound-safe by construction (cloudflared dials outbound-only).
- The box runs rootless (C1) inside a per-instance CF micro-VM; the VM boundary plus rootless
  Docker replace the privileged-box risk. No secrets are committed (only an SSH public key +
  resource UUIDs); `.gitignore` covers `node_modules/`/`.wrangler/`.

## 7. Testing & observability

- **CI (A2/A3):** `compute/` type-check is green and runs on every `compute/**` change.
- **Auth (B):** a unit test asserts `assertAccess` rejects a missing/expired/wrong-`aud` JWT
  and accepts a valid one (mock JWKS); an integration check asserts an unauthenticated public
  request gets `403`/no-route and a service-binding call succeeds.
- **Box (C):** `/health` returns `503` when dockerd is stopped and `200` when up; a rootless
  `docker run --network=host hello-world` succeeds inside the box with the cgroup flag set.
- **Regression:** an unauthenticated `GET /` and `GET /vpc` from the public internet return
  no data (the exact class the stopgap closed) — asserted, not assumed.

## 8. Decision table

| # | Decision |
|---|---|
| A1 | Root `tsconfig.json` excludes `compute` (mirrors `research-tools`) — clears the repo-wedge blocker. |
| A2 | `compute/` gets `workers-types` dep + `skipLibCheck:true` + a `type-check` script; source is already clean. |
| A3 | Dedicated `compute-ci.yml` on `paths: compute/**`; **not** a required check on `main`. |
| A4 | `compute-deploy.yml` (`workflow_dispatch` first, auto-on-main later) ends the out-of-band deploy. |
| B1 | Public `workers.dev` stays off (`workers_dev:false`+`preview_urls:false`), config-pinned. |
| B2 | Worker→Worker is a **Service Binding** — capability-based, no token, never public. |
| B3 | Operator HTTP (optional) = Cloudflare Access + **in-Worker JWT validation** (iss/aud/JWKS). |
| B4 | One top-of-`fetch()` guard; nothing side-effecting runs before auth; constant-time for any secret. |
| C1 | Re-image `docker:dind-rootless` + `--exec-opt native.cgroupdriver=cgroupfs`; inner `--network=host`. |
| C2 | `tini` as PID 1 to reap dockerd's children. |
| C3 | `/health` reflects real dockerd state (`503` when down). |
| C4 | try/catch + timeout + byte-cap on both container and VPC fetches (VPC throws on drop). |
| C5 | Box is a labeled at-risk experiment; digest-pinned image; corrected box sub-path routing. |
| D-egress (deferred) | VPC + Tailscale run **in parallel**; retire Tailscale only after the beta VPC path proves under real load — **not** the 7-day probe gate (amends Retrieval-Plane D2). Built in a later unit. |

## 9. Definition of done

- `npm run type-check` is green on a branch that includes `compute/` (A1), and
  `compute/` type-checks on its own (A2), enforced by `compute-ci.yml` (A3).
- The `sux-compute` worker is deployable/rollback-able via `compute-deploy.yml` (A4).
- An anonymous public request to the worker is refused; the `sux` worker reaches it via a
  service binding; the operator path (if enabled) requires a valid Access JWT (B).
- The box boots on `docker:dind-rootless`, runs `docker run --network=host hello-world`,
  reaps zombies (tini), and `/health` goes `503` when dockerd dies (C).
- `compute/README.md` states the experiment framing and the D11 home-router placement.

## 10. Out of scope / next

- **D — Egress cutover** (next hardening unit): the `proxy.ts` transport swap, `_vpc_selftest`
  probe, spine `transport` label, and the parallel-run→load-proven→retire-Tailscale sequence.
- **L0 (F7/F8)** — resolve the queue→Workflow idempotency contract (audit BLOCKER-2) before
  the async `research` substrate is built.
- **L2 AI Search (F13/F14)** — the corpus layer; greenlit, later burst. Note: AutoRAG
  generation bills via AI Gateway, not the sux request-gate governor — cap spend in the
  Gateway (audit M3).
