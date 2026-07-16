# MyChart — multi-org + durable-pull redesign

_Status: DRAFT for review · 2026-07-16 · supersedes the single-org pull path in `docs/proposals/archive/mychart.md`_

## 0. Verdict

The `mychart` conduit ships and is production-grade at the auth/PHI-pathing layer, but two things block real-PHI go-live, and they share one design pass because both touch the same conduit + fn surface:

1. **Single-org.** One `EPIC_FHIR_BASE` + one grant key (`sux:mychart:grant`) can't serve the operator's three health systems (UW Medicine, Providence Swedish, Bozeman Health). Connecting a second org silently overwrites the first's grant.
2. **The `pull` engine loses clinical data under load.** An 80-agent audit (`wf_89f63eb1`) confirmed 4 HIGH/MED findings that all cluster in `pull()`: it swallows Epic 429/5xx as clean end-of-data (silent partial sync), has no retry/backoff, has an unbounded DocumentReference→Binary fan-out, and no global subrequest/CPU budget — so on a rich patient history it either silently truncates a resource type or throws mid-loop, discarding all counts while partial PHI stays written to R2.

This spec parameterizes the conduit by org **and** moves `pull` onto the durable op-engine (`OpWorkflow`), which structurally closes all four audit findings by giving each step automatic retry/backoff and a configurable per-instance subrequest budget separate from the ~1,000/request fetch-handler limit.

## 1. Verified inputs (already grounded)

- **One client credential works across all three orgs** via Epic's Automatic Client-ID Distribution — the reason the original design deliberately stuck to USCDI-only scopes (no `Appointment`). So multi-org needs **no** additional Epic app registrations: the single production `EPIC_CLIENT_ID`/`EPIC_CLIENT_SECRET` already on the Worker authenticates against every org.
- **The three production FHIR R4 bases** (each verified live: active CapabilityStatement, `fhirVersion 4.0.1`):
  | Org id | Name | FHIR R4 base |
  |---|---|---|
  | `uwmedicine` | UW Medicine (WA) | `https://fhir.epic.medical.washington.edu/FHIR-Proxy/UWM/api/FHIR/R4` |
  | `swedish` | Providence Swedish (WA) | `https://haikuwa.providence.org/fhirproxy/api/FHIR/R4` |
  | `bozeman` | Bozeman Health (MT) | `https://revproxy.bh.bozemanhealth.org/Interconnect-Oauth2-PRD/api/FHIR/R4` |
- **Cloudflare Workflows semantics** (verified against current docs): every `step.do` retries automatically (default 5 attempts, exponential, 10s base), `retries.delay` accepts a **function of the error** (so a 429 can wait longer and honor `Retry-After`), each step has unlimited wall time (CPU-bounded per attempt), and `limits.subrequests` is configurable up to 10M per instance. The existing `interpretDurable` leaf case (`step.do(name, () => node.fn(input, caps))`) inherits all of this **iff the leaf throws on a transient failure** — which today's `pull` deliberately does not.

## 2. Part A — Multi-org parameterization

### A.1 Org registry
A code constant, not runtime config — the org set changes rarely and a constant stays unit-testable and reviewable:
```
MYCHART_ORGS: Record<string, { name: string; fhirBase: string }>
```
seeded with the three verified entries above. New orgs land via PR (a one-line addition + the FHIR base). `fhirBase(env, org)` and `mychartConfigured(env)` read from this map instead of the single `EPIC_FHIR_BASE` env var. **`EPIC_FHIR_BASE` is retired** as a secret once the map lands (the base URLs are public directory data, never secrets — only `CLIENT_ID`/`CLIENT_SECRET` stay in the Worker secret store).

### A.2 Per-org KV keys
Every per-connection key gains an `:${org}` suffix so grants never collide:
| Today | Multi-org |
|---|---|
| `sux:mychart:grant` | `sux:mychart:grant:${org}` |
| `sux:mychart:token` | `sux:mychart:token:${org}` |
| `sux:mychart:smartcfg` | `sux:mychart:smartcfg:${org}` |
| `sux:mychart:pkce:${state}` | unchanged (state already unique; now stores `{verifier, org}`) |

### A.3 Routes
- `/mychart/connect?org=<id>&token=<SUX_CRON_TOKEN>` — validates `org` against the registry (404 unknown), then the existing PKCE flow. The chosen `org` is persisted **inside the PKCE state blob** (`{verifier, org, created}`), so it survives the round-trip without a second query param on the callback.
- `/mychart/callback` — unchanged URL (Epic requires an exact redirect_uri match); reads `org` back out of the stored PKCE state and writes the grant under `:${org}`.
- The redirect_uri stays the single registered `https://suxos.net/mychart/callback`.

### A.4 fn surface (`fns/mychart.ts`)
- `status` (no org) → a summary array across **all** registry orgs: `[{org, name, connected, patient?, refreshTokenAgeSeconds?, lastPull?}]`. Never returns token material.
- `connect|pull|get` require an `org` arg (enum from the registry). If exactly one org is connected and `org` is omitted, default to it (ergonomic single-org case); otherwise `bad_input` listing valid orgs.
- `refreshMychartToken` cron → iterate every **connected** org, keep each warm independently.

### A.5 Secret-handling fix (audit LOW, cheap, fold in here)
Move the `/mychart/connect` gate off the query string. Today `?token=<SUX_CRON_TOKEN>` puts a reused admin secret into Cloudflare access logs. Switch to `Authorization: Bearer` (consistent with `/admin/tick` and `/apple-health`), or mint a dedicated single-use connect nonce. Same timing-safe compare.

## 3. Part B — Durable pull on the op-engine

### B.1 Register a `mychart-pull` op
```
"mychart-pull": () =>
  pipe(
    op("plan", planFn, { kind: "pure" }),                 // {org,patient,types,since} -> PlanItem[]
    map(op("pull-type", pullTypeFn, { kind: "effect", retries: … }),
        { concurrency: aimd({ start: 3, max: 8 }) }),     // one leaf per resource type
    op("reconcile-pull", reconcileFn, { kind: "pure" }),  // PlanResult[] -> PullResult (+errors map)
    sink("phi-manifest"),                                 // write the run manifest under phi/
  )
```
- **`plan` leaf** builds the per-type search plan (today's `resourcePlan`), pure and deterministic — so the durable tree shape stays replay-stable.
- **`pull-type` leaf** (one per resource type, fanned out under `aimd`): pages that type sequentially, writing each page to `phi/mychart/${org}/${patient}/...` via caps. It **throws on transient (429/5xx)** so Workflows retries the whole step with backoff; a `retries.delay` function reads the error/`Retry-After`. On **terminal** 404 ("org doesn't support this type") it returns `{label, count, status:'unsupported'}` — never throws. On retry-exhaustion it **catches internally** and returns `{label, count, status:'throttled', truncated:true}` so one bad type never sinks the pull. Binary fan-out inside this leaf is bounded by `MAX_BINARIES_PER_TYPE` + its own `aimd`.
- **`reconcile-pull`** merges the per-type results into the new `PullResult` shape (below), including a first-class `errors`/`status` map so a throttled or partial type is **never** reported as complete.

### B.2 Op-engine changes (two, both small)
1. **Caps health effect.** `Op` leaves receive `(input, caps)` — no `env`, so a leaf can't reach Epic today. Extend `Caps` with a health effect, wired **only** in the Worker's `caps.ts` (suxlib stays Epic-agnostic):
   ```
   caps.health = {
     fetch(org, url): Promise<Response>,   // closure over mychartFetch(env, url) with per-org token
     putPhi(org, key, body, type): Promise<string>,
   }
   ```
   Plus a `phi-manifest` sink target that writes the run summary under the existing `phi/` prefix — so the `/s/` fence (observability.ts:76) and `store`'s fence apply with zero new code.
2. **Thread `StepConfig` through the interpreter.** Today `interpretDurable`'s leaf case calls `step.do(name, () => node.fn(...))` with **no config**, so it already inherits Workflows' default retry (5 attempts, exponential, 10s) — that alone gives the `pull-type` leaf real backoff the instant it throws. To additionally honor Epic's `Retry-After` on a 429, the interpreter must pass a `StepConfig` with a `retries.delay` **function** derived from `node.opts` (the `LeafOpts.retries` field already exists but is currently ignored). This is a small, general op-engine improvement — not mychart-specific — and benefits every future effect leaf.

### B.3 Dispatch + budget
- `mychart op:"pull"` → `env.OP_WORKFLOW.create({ params: { opId: "mychart-pull", input: {org, patient, types?, since?} } })`, returns `{instanceId}`. The bulk sync is no longer bound to the MCP request's timeout or the ~1,000-subrequest fetch-handler limit.
- `wrangler.jsonc`: add `limits.subrequests` (raise from default toward the workload) and confirm the `OP_WORKFLOW` binding's step limit covers `~17 types × pages`.
- `status op:"pull-status" {instanceId}` (or `mychart op:"status"` folding in the last run) polls instance status so the operator can see truncation/errors.

### B.4 New `PullResult` shape
```
{ org, patient, counts: Record<label,number>, pages, binaries, keys,
  errors: Record<label, string>,   // label -> "HTTP 429" | "unsupported" | ... (empty = clean)
  truncated: boolean }
```
`errors` non-empty ⇒ the caller KNOWS the sync was partial. Closes the silent-partial-completeness gap directly.

## 4. Error handling (the crux)

| Condition | Old behavior | New behavior |
|---|---|---|
| Epic 429 mid-pagination | `break`, silent, no flag | leaf throws → Workflow retries w/ backoff honoring `Retry-After`; if exhausted, `errors[label]="HTTP 429"` + `truncated` |
| Epic 5xx | same silent `break` | same transient-retry path |
| 404 unsupported type | silent `break` (ok) | `status:'unsupported'` recorded, not an error |
| Subrequest/CPU limit | throw → all counts lost | per-instance budget (10M ceiling) + step memoization ⇒ resumable; partial results still returned |
| Empty searchset | count 0 (ambiguous vs error) | distinguished: valid Bundle w/ `entry=[]` ⇒ genuine 0, not an error |

## 5. Testing

- **Multi-org isolation:** connect two orgs (mocked grants), assert each grant/token lives under its own `:${org}` key and a pull for org A never reads org B's grant.
- **Per-type error surfacing:** mock a 429 on page 2 of one type → assert `errors[label]` set, `truncated` true, other types unaffected, and the result is NOT reported as clean.
- **Binary budget:** mock a DocumentReference page with >`MAX_BINARIES_PER_TYPE` attachments → assert the cap flips `truncated`, not an unbounded fan-out.
- **SSRF per-org:** assert `isUnderFhirBase` still refuses an off-base `next`/`get` path for each org's base.
- **`refreshMychartToken` across orgs:** the 4 cases (unconfigured, no grant, cached-token short-circuit, mint-once) × per-org — closes the audit's zero-coverage finding.
- **`resolveBinaries` regex** (audit LOW): a `Binary/x?_format=json` URL must resolve, not be dropped.
- **Durable interpreter:** a `mychart-pull` replay returns memoized step results (no double-write to `phi/`).

## 6. Out of scope (explicit)

- No new Epic registrations (auto client-id distribution covers all three orgs).
- No change to the Apple Health ingest path (`/apple-health` is orthogonal; its own audit LOW fixes — `payloadPeriodDate` fallback + tests — batch separately).
- Not touching the auth core, PKCE, PHI-pathing, or `get`/`status` semantics beyond the `org` param.

## 7. Build order

1. **Part A** (multi-org) — registry + per-org KV keys + routes + fn `org` param + connect Bearer-gate + cron loop. Green + tested. Ship as its own PR (single-org still works: default org).
2. **Part B** (durable pull) — caps `health` effect + `phi` sink + `mychart-pull` op + `pull` fn dispatch to `OP_WORKFLOW` + new `PullResult` + `wrangler.jsonc` limits. Green + tested. Its own PR.
3. Each lands via PR → `/code-review ultra` → merge (per repo convention).
4. Operator: 3× `/mychart/connect?org=<id>` logins; verify a real per-org `pull`; close #329.
