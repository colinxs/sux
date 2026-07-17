---
title: SuxOS v10 — the Retrieval Plane
status: draft (pending owner review)
type: design
arc: v10 (follows v2/v2.1; named per the vX next-arc mechanism)
owner: m@colinxs.com
updated: 2026-07-16
summary: "One async search substrate over every source class — public web, vault, an ingested R2/Iceberg lake, and the private network — fanned out on Queues, synthesized by AI Search, cited into the vault. Built VPC-first."
---

# SuxOS v10 — the Retrieval Plane

## 1. Thesis

Every retrieval sux does today is synchronous: one MCP call, one blocking answer, bounded
by the Worker request lifetime, reaching only public sources (plus one fragile
residential hop). v10 replaces that ceiling with a **retrieval plane**: a single async
substrate that reaches **every source class** — public web → the vault/knowledge core →
an ingested data lake → **private services and databases** — fans work out over Queues,
synthesizes with AI Search, and lands cited results in the vault.

The composing primitives all shipped on Cloudflare within the last year and are verified
current (2026-07-16): **AI Search** (managed RAG over R2, AutoRAG renamed 2025-09),
**Workers VPC** (private-network bindings, beta 2025-11; WAN reach 2026-05), **Hyperdrive
over VPC** (private DBs, 2026-04), **Pipelines** (stream → SQL → R2 Iceberg, open beta),
plus Queues, Workflows, D1, Vectorize, Workers AI — and sux already carries `AI`, `R2`,
and `BROWSER` bindings. v10 is an assembly arc, not an invention arc.

**Relationship to the vX mechanism** ([.github: 2026-07-16-suxos-vx-next-arc.md]): v10 is
the next capability arc, owner-directed ahead of the §4 seven-day gate. Recorded, not
hidden: the v2 drain continues in parallel; v10 build issues enter the normal backlog
behind it; nothing here bypasses the pipeline.

## 2. Architecture

Five layers. Each is independently testable, communicates through a typed seam, and maps
to specific bindings. Build order is **L3 first** (hardest unknown, immediate production
value), then L0 → L1 → L2 → L4.

```
caller (MCP verb) ──sync──▶ fast path (existing fns, unchanged)
        │
        └─async─▶ L0 job substrate: Queues + op-engine runDurable
                      │  claim-check handle returned immediately
                      ▼
              search workers fan out per rung:
                direct fetch ──▶ public web
                RESIDENTIAL (Workers VPC binding) ──tunnel──▶ home node   [L3]
                BROWSER (Browser Run) ──▶ bot-walled render
                research/social/retail backends
                corpus (AI Search) ──▶ vault + lake                        [L2]
                      │
                      ▼
              L1 ingest: Pipelines stream ─SQL─▶ R2 Iceberg (lake)
                         bodies → R2 content-addressed; index/dedup → D1
                      │
                      ▼
              L2 AI Search continuous sync over R2 (lake + vault mirror)
                      │
                      ▼
              synthesis → cited report → vault; handle resolves            [L4]
```

## 3. Feature burst

Fifteen features, F1–F15, grouped by layer in build order. Each is decision-complete.

### L3 — private reach (build first)

**F1 — `sux-home` tunnel.** `cloudflared` runs on the home LAN: on the OpenWRT node
itself (cloudflared is in the OpenWRT packages feed) or, if its footprint doesn't fit the
router, on any always-on LAN box. Provisioning folds into the existing
`node/openwrt/provision-node.sh` flow (install, procd/systemd service, tunnel token
stored alongside the node's existing secrets). One tunnel, named `sux-home`, carries all
private reach — HTTP now, TCP registrations later (F6).

**F2 — VPC Service `residential-fetch`.** The node's local fetch service is registered as
a Workers **VPC Service** (host:port on the LAN). VPC *Services* over VPC *Networks* is a
security decision, not a convenience: sux fetches attacker-influenced URLs, and a Service
binding can only reach its one pre-registered target — SSRF containment at the platform
layer (D1).

**F3 — `RESIDENTIAL` binding + transport swap.** `wrangler.jsonc` gains
`vpc_services: [{ binding: "RESIDENTIAL", service_id: <sux-home/residential-fetch> }]`
(exact key syntax re-verified against wrangler docs at build time — the product is beta).
`proxy.ts`'s transport half swaps from Funnel-URL-plus-HMAC to
`env.RESIDENTIAL.fetch(...)`. Cutover is flag-atomic: `EGRESS_RESIDENTIAL_TRANSPORT =
"funnel" (default) | "vpc"`. Shadow comparison runs **only** in the `_vpc_selftest` probe
(F5) — never dual-fires live traffic (side effects, node cost). After 7 green probe days
the default flips to `vpc`; the funnel path, the HMAC code, `TAILSCALE_PROXY_URL/SECRET`
secrets, and the node's Funnel exposure are then **deleted** (D2). Tailscale itself stays
— as the operator's admin plane, not the Worker's transport.

**F4 — typed egress contract.** The seam prose becomes code: `EgressRequest` /
`EgressResponse` types extracted from today's `ProxiedResponse`, owned in one module,
with a conformance test both sides run in CI. The contract asserts the invariants the
2026-07 incidents taught: a 200 MUST carry a non-empty body unless the upstream response
was legitimately empty (explicit `emptyOk` marker from the node), and binary bodies MUST
declare `bodyEncoding:"base64"`. The 200+empty class becomes a contract violation with a
named error, not a mystery. This closes the seeded vX slice-6 issue ("egress contract:
typed, conformance-checked interface") — same work, don't file twice.

**F5 — `_vpc_selftest` + spine signal.** A `_vpc_selftest` fn (naming per
`_web_search_selftest`) fetches a known-good bot-walled URL through both transports while
both exist, compares status/body-shape, and ships the verdict. `shipEgress` (grafana.ts)
gains a `transport: "direct" | "funnel" | "vpc"` label; the fabric-health dashboard gains
an egress-transport panel and a `suxos_egress_vpc_up` probe signal. The new seam is
observable from day 1; the burn-in flip (F3) is decided by this panel, not by vibes.

**F6 — Hyperdrive socket (documented, deliberately not built).** The same `sux-home`
tunnel accepts TCP service registrations. When a real private database exists, the whole
path is:
`npx wrangler hyperdrive create <name> --service-id <vpc-service> --database ... --scheme postgresql`
plus one binding stanza. **No database is provisioned in v10** — there is no real private
DB today and standing one up to test the tech is fabricated work (D3). Triggers that
un-park this: the lake hot-index outgrows D1, or the institutional-VPN rung lands a
DB-shaped source.

### L0 — job substrate (the queues)

**F7 — `search-jobs` queue + DLQ.** Producer binding `JOBS` on sux; consumer with
`max_retries: 3`, `dead_letter_queue: "search-jobs-dlq"`. Job envelope (versioned):
`{ v: 1, job_id, verb, args, requested_at, budget: { fetches, tokens, deadline_s } }`.
DLQ depth ships to the spine (`suxos_search_jobs_dlq_depth`) and alerts — a dead job is
an incident signal, not silent loss.

**F8 — `research` async verb.** The flagship caller surface.
`research(query, backends?, depth?)` validates, enqueues, and returns a claim-check
handle **immediately** (<2s): `{ job_id, status: "queued", poll: "job_status" }`. The
consumer runs the job as an op-engine **durable op** (`runDurable` — Workflows), reusing
the shipped graduation rule: inline for interactive work, durable for jobs. The op is the
deep-research shape as edge infrastructure: plan → fan out rungs (respecting the F3/F5
ladder) → fetch/extract → adversarially verify claims → synthesize → **write the cited
report to the vault** via the existing vault write path (base_sha + bounded retry,
sux#667/#670).

**F9 — job registry in D1.** New D1 database `sux-retrieval`, table `jobs(job_id, verb,
status: queued|running|done|error, created_at, updated_at, cost_spent, result_ref,
error)`. `job_status(job_id)` reads it; results are **pointers** (vault path or R2 key),
never bodies (D7). Terminal rows expire after 30 days (scheduled sweep). This is the
cheap-read surface that keeps polling off the Workflows API.

### L1 — ingest + lake

**F10 — Pipelines stream → Iceberg.** Pipelines stream `search-results` (Worker binding,
no public HTTP ingest endpoint); minimal SQL pass-through pipeline; sink = R2 Data
Catalog Iceberg table `retrieval.results`. Row schema: `{ job_id, url, backend, kind,
title, snippet, content_r2_key, fetched_at, meta (json) }`. Every async-job fetch result
lands here as a durable, queryable record — the lake is the plane's memory of everything
it has ever retrieved.

**F11 — content-addressed bodies + dedup.** Full bodies go to R2 under
`retrieval/blob/<sha256>` (extends the existing blob-by-hash doctrine); lake rows carry
`content_r2_key` pointers. D1 table `fetch_cache(url_hash, etag, last_fetched,
content_r2_key)` gives workers deterministic dedup — a URL fetched by job A is not
re-fetched by job B inside the freshness window. Deterministic-beats-LLM applies to
retrieval too.

**F12 — R2 SQL + retention.** The warehouse is queryable via `wrangler r2 sql` and any
Iceberg engine. Retention: lake rows and blobs expire at **180 days** (D4) via catalog
partition expiry + R2 lifecycle rule on the blob prefix; the vault holds what deserves to
outlive the lake.

### L2 — AI retrieval

**F13 — AI Search instance `sux-corpus`.** One AI Search (AutoRAG) instance over the
**vault mirror prefix only** (F14). Research-job reports land in the vault (F8), so job
outputs enter the index transitively; raw lake blobs are **not** indexed in v10 — they
are noisy HTML at blob granularity, and the lake already has its own query surface (R2
SQL). Trigger to widen: recall demonstrably missing answers that exist only in
un-synthesized lake rows. Embeddings: Workers AI default
embed model. Generation: Anthropic via the AI Gateway hook. Sux reaches it through the
**existing `AI` binding** — `env.AI.autorag("sux-corpus").search(...)` /
`.aiSearch(...)` — no new binding. Surface: a `corpus` backend inside `recall`/`oracle`
(semantic recall with citations and metadata folder filters), replacing nothing —
augmenting the existing git-grep recall with semantic retrieval.

**F14 — vault mirror to R2.** A scheduled sync job mirrors the vault's markdown (git) to
`r2://sux-mcp/corpus/vault/` so AI Search's continuous indexing covers it. Sync is
one-way (git remains the single writable truth; the mirror is derived data), delta-based
off git SHAs, and stamps `indexed_at` metadata so recall answers can carry a freshness
watermark.

### L4 — the unified verb

**F15 — unpark `search.md`.** The parked proposal (`docs/proposals/search.md`) ships as
frozen — its 12 resolved decisions stand (string WHERE-DSL, anyOf backends schema,
per-backend fetch ceilings, cache/fresh semantics) — with three v10 amendments: (a) new
`corpus` backend = F13; (b) rung-aware dispatch — backends whose reachability requires
the residential rung route through the F3 binding automatically; (c) an `async: true`
arg for wide fan-outs, which enqueues via F7/F8 and returns a claim-check handle instead
of blocking. Fallback-order note from the proposal's 2026-07-14 reality check applies
(Exa free tier over Brave). This lands last; everything below it must be green first.

## 4. Worked flow

`research("field reliability of cold-climate heat pumps", backends: "all", depth: "deep")`

1. `research` validates, writes `jobs` row (`queued`), enqueues envelope, returns
   `{ job_id, status: "queued" }` in <2s. MCP call is done.
2. Queue consumer claims it, flips status to `running`, starts the durable op.
3. Plan step decomposes into sub-queries; fan-out honors the ladder: direct where
   possible, `RESIDENTIAL` VPC binding for residential-required hosts, `BROWSER` for
   render-walled, research backends for papers, `corpus` for what the vault already
   knows.
4. Every fetch: `fetch_cache` dedup check → fetch → body to `retrieval/blob/<sha256>` →
   row to the `search-results` stream → Iceberg.
5. Verify step re-fetches contested claims through independent backends (adversarial
   verification per the deep-research shape).
6. Synthesis writes a cited report to the vault (base_sha write path); `jobs` row flips
   to `done` with `result_ref` = vault path.
7. Caller (or a later session) reads `job_status(job_id)` → opens the vault note. The
   lake retains every underlying source row, queryable via R2 SQL, for 180 days.

## 5. Error handling

- **VPC down** (tunnel offline): residential rung degrades to direct with
  `meta.errors code:"vpc_down"`; partial envelopes carrying transient codes are
  **noCache** (existing invariant, search.md D6). The spine panel goes red; jobs continue
  on remaining rungs.
- **Contract violation** (empty-200, undeclared binary): named error at the F4 seam,
  counted on the spine; the fetch retries once through the next rung, then records a
  per-source error in `meta.errors`.
- **Queue failure**: 3 retries → DLQ → spine alert. Jobs are idempotent by design —
  `fetch_cache` + content-addressed blobs make a re-run cheap and duplicate-free; the
  vault write path is base_sha-guarded against clobbering.
- **Budget/deadline**: the envelope's `budget` is enforced by the op via the governor
  primitives (suxlib slice-5); exhaustion produces a **partial report** clearly stamped
  `meta.errors code:"deadline"` in the vault note header — never a silent truncation.
- **AI Search lag**: `corpus` answers carry the F14 `indexed_at` watermark so staleness
  is visible, not silent.

## 6. Security posture

- VPC **Services** (single pre-registered target) over Networks — platform-level SSRF
  containment for a system that fetches attacker-influenced URLs (D1).
- The home node leaves the public internet entirely: Funnel URL and shared-secret HMAC
  deleted after burn-in (D2). Binding identity replaces bearer secrets.
- Fetched content is data, never instructions — existing scrape sanitization applies
  unchanged to lake rows and synthesis inputs.
- Private-reach results stay in the account's own R2/vault; nothing on the plane
  publishes outward.

## 7. Testing & observability

- **Contract**: F4 conformance suite runs in both sux CI and the node's check (mock
  transport) — the seam cannot drift silently.
- **Live seam**: `_vpc_selftest` scheduled probe; shadow-compares transports during
  burn-in (F5).
- **E2E**: one test in the existing e2e-worker: enqueue a tiny `research` job with a
  stubbed backend → assert claim-check, lake row, D1 status transitions, vault note.
- **AI Search smoke**: `corpus` query returns a known vault doc with citation.
- **Spine**: `suxos_egress_vpc_up`, egress-by-transport panel, `suxos_search_jobs_depth`,
  `suxos_search_jobs_dlq_depth`, `suxos_lake_ingest_rate` — added to fabric-health with
  the features they observe, not after.

## 8. Build order & pipeline integration

1. **L3 burst** (F1–F6) — private-reach skeleton; immediate production win.
2. **L0** (F7–F9) — `research` async skeleton, web-only rungs acceptable.
3. **L1** (F10–F12) — results land in the lake.
4. **L2** (F13–F14) — corpus recall over vault + lake.
5. **L4** (F15) — unified verb capstone.

Each burst is seeded as pipeline issues per the normal flow (issue-build → green-merge →
red-rebase); implementation-plan docs per burst follow this spec. Gate note (D8): the vX
§4 gate is owner-overridden for *design and seeding*; the v2 drain retains priority in
the queue.

## 9. Cost

Workers VPC: free in beta. Pipelines: beta, R2 costs only. Queues/Workflows/D1: pennies
at personal scale. AI Search: underlying Workers AI embeddings + Vectorize + generation —
small at personal-corpus scale, and generation rides the budget governor like every other
model call (budget-and-cadence.md). No new egress cost: the residential node's traffic
shape is unchanged, only its transport.

## 10. Decision table

| # | Decision |
|---|---|
| D1 | VPC **Services**, not Networks — SSRF containment beats reach; Networks re-opens runtime-URL-picks-destination. |
| D2 | Funnel + HMAC + `TAILSCALE_PROXY_*` are **deleted** after 7 green probe days; Tailscale remains admin-only. |
| D3 | Hyperdrive: socket documented (F6), **not provisioned** — no real private DB exists; triggers recorded. |
| D4 | Lake retention 180 days (rows + blobs); the vault is the long-lived tier. |
| D5 | `search.md` ships frozen + three amendments (corpus backend, rung-aware dispatch, `async`); last in build order. |
| D6 | D1 = job registry + fetch dedup only; the lake (Iceberg) is the analytical store. Hot/analytical split is deliberate. |
| D7 | Results are pointers (vault path / R2 key) end-to-end; bodies live once, content-addressed. |
| D8 | vX §4 gate: owner-directed override for design+seeding recorded here; v2 drain keeps queue priority. |
| D9 | Shadow comparison probe-only, never on live traffic (side effects, node cost). |
| D10 | Vault mirror is one-way derived data; git stays the single writable truth. |
| D11 | **No external cloud provider.** The compute plane is Cloudflare Containers (dind pet boxes — each a Linux VM running dockerd); pet-persistent workloads (a real Postgres) go on home-LAN hardware over the same `sux-home` tunnel when needed. Owner decision 2026-07-16. |
| D12 | The `sux-home` tunnel's first connector runs on the operator's Mac as the proof rig; migrating the connector to the OpenWRT node (always-on) is the F1 build item, purely mechanical — same token, same tunnel ID. |

## 11. Definition of done

- A bot-walled page returns through the home residential IP via `env.RESIDENTIAL` —
  Funnel deleted, panel green 7 days.
- `research(...)` returns a handle in <2s and lands a cited, budget-stamped report in
  the vault unattended.
- `recall`/`oracle` answer from the vault semantically via `corpus`, with citations and
  freshness watermark.
- Every async fetch is a lake row queryable via R2 SQL; dedup demonstrably prevents
  re-fetch inside the window.
- Every §7 spine signal and panel lives on fabric-health; DLQ empty in steady state.
- `search(...)` (F15) serves group/named/mixed backends with the WHERE-DSL, sync and
  async.

## 12. Non-goals (parked with triggers)

- **Hyperdrive + private DB** — trigger: a real DB-shaped need (F6).
- **VPC Networks / whole-LAN reach** — trigger: >3 distinct private services on the
  tunnel make per-service registration a real burden.
- **Institutional-VPN egress rung** (UW) — composes with the same ladder later; nothing
  in F3–F5 precludes a fourth rung.
- **Standing watches / continuous queries** — natural v10.1 on top of F7–F9 (a cron that
  enqueues); not in this arc.
- **Multi-tenant/requester ACLs** — single-operator system; revisit only if that changes.

## 13. Shipped while designing (2026-07-16)

The L3 walking skeleton went live the same day this spec was written — verified, not
aspirational. All under `compute/` in this repo:

- **`sux-compute` worker** — `https://sux-compute.colinxs.workers.dev`, container app
  `sux-compute-suxbox` (`a034a320-2ff6-47a5-af1a-3bc55f96f7bf`).
- **Dind pet boxes** (`SuxBox` Container class, `standard-1`, `sleepAfter: 30m`):
  `GET /box/:name/` boots a per-name Linux VM running dockerd inside Cloudflare.
  Verified: `docker_version 28.5.2`, `docker run hello-world` executed inside the box.
- **SSH into the box** from the operator's Mac (key `~/.ssh/sux-compute_ed25519`):
  `ssh -o ProxyCommand="npx wrangler containers ssh %h" -i ~/.ssh/sux-compute_ed25519 cloudchamber@<INSTANCE_ID>`
  (instance IDs via `npx wrangler containers instances sux-compute-suxbox`).
- **Workers VPC end-to-end** — tunnel `sux-home` (`4b6065ca-e326-40c0-aeb6-65745467ecb7`),
  VPC Service `sux-mac-test` (`019f6db5-01d1-7992-98c8-d678f37496d7`, http →
  127.0.0.1:18080), binding `MAC_VPC`. Verified: `GET /vpc` returns the Mac-local marker
  through edge → tunnel → laptop. This is the F1/F2/F3 pattern proven; the
  `residential-fetch` service is the next registration on the same tunnel.
- **Cost shape:** Workers VPC free (beta); the box bills only while awake
  (standard-1, scale-to-zero after 30m idle); tunnel free.
