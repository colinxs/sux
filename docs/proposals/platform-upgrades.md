---
title: Platform upgrades
status: superseded
cluster: infrastructure
type: proposal
summary: "Five infra upgrades as one substrate — notify/diff/job (scheduler + cron drain), mac-LLM tier, browse, Cloudflare Workflows, entity resolution."
tags: [sux, infrastructure, parked, superseded]
updated: 2026-07-09
superseded: "2026-07-23, 1.4 brainstorm reconciliation — see pointer below"
---

> [!warning] SUPERSEDED (2026-07-23) — three of five pillars overtaken, don't revive
> Reconciled against Colin's 2026-07-23 "1.4 synthesis" brainstorm (unified content-router +
> synthesis engine + three-tier compute topology; session-memory record, not an in-repo doc):
> - **D4 mac-LLM tier** (warm Ollama on the render Mac, behind `llm()`) is doubly dead — the
>   render Mac node was deleted (sux#742), and 1.4 assigns always-on heavy compute to
>   metal/elk-newt (a three-tier topology: edge/metal/Mac-on-open, Mac is a local-data
>   scheduler only) with a frontier-model **multi-model relay in sux** occupying the
>   "think harder" slot instead of a local model.
> - **Notify/diff/job scheduler** sections describe a design that was built differently in
>   practice: the op-engine (`OP_WORKFLOW`), `cron-heartbeat.ts`, and the propose→gated-act
>   kernel own this territory now; the watch/routine/timer/milestone taxonomy (2026-07-23)
>   owns standing schedules.
> - **D8** retrofits onto teach/ask, itself already `status: superseded` (see that doc).
>
> **Still live, not superseded:** the `browse` DSL section and the `_entity.ts` /
> person-entity-extraction sections — those designs survive independent of the above.
> Read this doc for historical context on the *reasoning*, not as current architecture.

# Platform upgrades — the infrastructure under the feature verbs (FINAL)

Five infrastructure upgrades that sit *beneath* the sux feature verbs (`search`, `teach`/`ask`, `style`/`edit`, `shop`, `travel`, `algebra`) rather than beside them. They are the plumbing those verbs stand on: a way to be **proactive** (notice + push), a way to think **harder** (a stronger local model), a way to **operate** a page (not just read it), a way to **outlast** the request (durable execution), and a way to know **when two records are the same thing** (identity). Each is designed to deploy half-built and inert — every new capability is gated on an optional secret or binding and no-ops when unset, exactly like `grafana.ts`'s `shipToLoki` — so the whole set lands one-change-per-cycle without a flag day.

Two hard facts from the runtime govern every decision here, and every section states how it lives inside them:

- **The 60s wall.** Every `fn.run` is raced by `withDeadline(name, FN_DEADLINE_MS=60_000, fn.run(env, args))` at `sux/src/index.ts:41,252`. On a fired deadline `withDeadline` **resolves a clean `isError` result and *abandons* the run promise — it does not cancel it** (`index.ts:52-58`). Anything that must run longer than ~55s cannot do it inside one `tools/call`; it must move off the request path (a cron drain, or a Cloudflare Workflow) and hand the caller a handle.
- **The 24h stale-grace.** The response cache is stale-while-revalidate with `CACHE_STALE_GRACE_SECONDS = 86_400` (`sux/src/mcp-util.ts:58,119`); `deferCacheWrite` caches **any** result that is not `isError` and not `noCache` (`mcp-util.ts:110`), and `index.ts:285-290` serves a soft-expired hit immediately. A "success-shaped" result built from an all-failed run gets frozen onto the key for a day. So every side-effectful or stateful surface here is `cacheable:false` or self-`noCache`s, and diff/job never cache a mutation. **The one read-only surface this does not cover is the scheduled recheck target:** the §1.4 schedulable allowlist is deliberately all-*cacheable* read-only fns (`scrape`, `render`, `shop`, …), yet a change gate reading those through the 24h grace would compare a frozen value against a frozen value and never fire. So `job`/`diff` read their targets through a **cache-bypassing live re-fetch** (§1.5 step 2, §1.2) — the allowlist being all-cacheable is intentional and the bypass is what makes scheduling it safe — while still never *writing* the tick's fetch onto the shared `cache:<sha256>` key.

These upgrades also **share one another's parts on purpose.** The single largest synthesis in this document: the proactive layer's scheduler fn and the Workflows layer's durable-job handle fn are **the same `job` fn over the same `sux:job:` KV registry** — `source` discriminates a scheduled recheck from a durable Workflow run from a cron enqueue. The caller learns one polling verb. And the cron-enqueued Workflow's "results rot with no poller" problem is closed by the proactive layer's `notify` egress firing on completion. They are not five islands; they are one substrate.

Travel is **not** covered here beyond this pointer: its authoritative design is `docs/proposals/travel.md`. Where a long travel job needs durable execution it adopts the Workflows pattern below as a consumer.

---

## Reality check — 2026-07-14 (external-research pass)

The scheduler-drain primitive below (`job`, §1/§4) should be built on **Durable Object Alarms**, not Workers Cron Triggers. Cloudflare's own recommendation for this exact shape — one DO per scheduled request, isolated storage + its own alarm — is DO Alarms: programmatic `setAlarm(msSinceEpoch)` (ms granularity), guaranteed at-least-once execution with automatic exponential-backoff retry (2s initial, up to 6 retries), and **unlimited per account**. Workers Cron Triggers, by contrast, cap out at **3 per Worker**, are only configurable via dashboard/API (not programmatically), and are limited to 1-minute granularity — a poor fit for a per-schedule-record drain.
**Caveat:** alarm auto-retry gives up after 6 attempts — for indefinite reliability the `alarm()` handler must catch its own errors and reschedule itself.
Refs: [DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Building a scheduling system with Workers + DOs](https://blog.cloudflare.com/building-scheduling-system-with-workers-and-durable-objects/).

---

## Resolved decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **`notify` egress is ntfy.sh (keyless HTTP push), direct Worker→public. NOT the Mac / iMessage.** | An alert channel must be *more* available than what it watches. ntfy is a direct edge `fetch` with zero dependency on the residential Mac being awake; routing alerts through the Funnel'd Mac couples "did the price drop?" to the flakiest box in the stack. Mirrors `shipToLoki` verbatim (fire-and-forget, secret-gated, never throws). |
| D2 | **`watch` / `diff` / `job` are three fns, not one.** | Different state, different cost class. `watch` stores one hash (cheap boolean gate, no AI). `diff` stores full prior snapshots (semantic explainer, 1 LLM). `job` stores a schedule record (the pairer). Absorbing `watch` into `diff` would force every cheap check to pay snapshot storage + an LLM pass. The job tick uses a watch-style hash as the gate and escalates to diff only when the hash moved AND the job wants a semantic payload. |
| D3 | **One unified `job` fn over one source-partitioned job registry** (`sux:sched:` schedules + `sux:job:` terminal history, D10) serves scheduler records (proactive) AND durable-Workflow handles (workflows) AND cron enqueues. | Both proposals independently needed `sux:`-prefixed job state; `kv_put` refuses the `sux:` prefix (`kv_put.ts:7`), so a single owning fn is mandatory anyway. `source: "schedule"|"workflow"|"cron"` discriminates, and D10 partitions the keyspace by source for complete, cheap schedule enumeration. `source` is a **real `enqueueJob` parameter, never a hardcoded literal** — a hardcoded `source:"workflow"` mis-routes a cron enqueue into the terminal keyspace and defeats discrimination — and the `source:"cron"` path re-mints its content-hash dedup id per scheduled fire from `(scheduleId ?? "-", tickBucket)` (§4.2) so a nightly job whose `(fn,args)` never changes still recurs instead of returning its 7d-retained `complete` record (D10). **`source` discriminating is necessary but not sufficient to keep the two flagship durable features apart:** the standalone nightly cron (§4.5) and the durable-dispatched daily-watch escalation (§1.5) are **both** `source:"cron"` and, on a shared `daily shop store:"*"`, compute an identical `(fn,args,tickBucket)` — so it is `scheduleId` **presence** (the parent `sux:sched:` id vs `"-"`) folded into the dedup key, not `source`, that distinguishes the durable-dispatched schedule (`gateBackToSchedule` finalizer, change gate) from the fire-and-forget cron (`finishNotify` finalizer); omitting it silently coalesces them onto one Workflow and one finalizer (§4.2). **The two halves cohere for heavy targets by construction, not by hope:** a scheduled target too heavy for the inline drain budget (`shop store:"*"`, deep `crawl` — §1.4 args gate) is not enrolled inline to error every tick; the schedule is flagged `durable:true` and its fire **escalates to a `source:"cron"` enqueue into `SuxWorkflow`** (§1.5), so the schedule surface can never enroll a target the schedule executor cannot run. `source` discriminating a scheduled recheck from a durable run is thus also the seam along which a heavy schedule crosses from the inline surface to the durable one. **Crossing that seam obligates one further invariant: a durable-dispatched schedule's runtime must be reconciled against its cadence.** A heavy durable fire (`shop store:"*"` ≈ minutes) can outlast its own `15m`/`hourly` period, and the escalation dedup key `(scheduleId, tickBucket)` (§4.2) is deliberately time-varying to give recurrence — so nothing in the dedup path stops the next tick from spawning a *second* overlapping Workflow while the first is still solving. The design closes this with an **in-flight latch** on the `sux:sched:` parent (`inflight_since`, set before escalation, consulted in due-selection, cleared by `gateBackToSchedule` on completion, staleness-capped by `DURABLE_FIRE_MAX_MS`; §1.3/§1.5/§4.5) — recommended over the alternative of rejecting a heavy-durable target on a cadence shorter than its worst-case runtime at create time. Without it, overlapping fires leak Workflows unbounded onto the concurrency-1 solver (D6/§4.7) and race duplicate `gateBackToSchedule` writebacks/pushes on one parent. Net new fn is +1, not +2. |
| D4 | **The Mac LLM tier is pure infra behind `llm()` — zero new fns.** Escalate to a warm Ollama model on the render Mac via a `/llm` route; any miss silently degrades to Workers-AI. | The strong tier is best-effort like Kagi→Workers-AI (`summarize.ts`) and `macRender` (`{ok:false}` + breaker). With `MAC_LLM_URL` unset it is byte-identical to today, so callers flip to strong before the Mac exists. |
| D5 | **`browse` is one new fn, the top rung above `render`, driven by a closed action-script DSL** (no `eval`/`script`/`route` verb) with an **ephemeral per-call browser context**, its **own node semaphore**, DNS-resolved SSRF, and screenshots disabled when a vaulted secret is in play. | The DSL's no-arbitrary-JS property is the load-bearing security control. Everything else (SSRF, credentials, submit-blocking, replay, isolation) is defense the design must add because the endpoint is now side-effectful. |
| D6 | **Cloudflare Workflows is the answer to the 60s deadline for the three genuinely-unbounded, must-complete jobs** (whole-site teach, deep crawl, shop-all-retailers). A long fn returns a handle in <1s; `job op:"get"` polls. | `batch` and single-shot fns that merely *sometimes* brush 60s get disciplined partial-return instead — cheaper, no binding, ships first. Do not wrap a 3-second call in a durable-execution engine. |
| D7 | **`entity` is a pure shared module `_entity.ts` + a thin (non-raw) `entity` fn.** | Identity resolution is CPU-only compute over already-fetched records — it belongs inline in the caller's 60s budget sharing the caller's in-memory records, not dispatched by registry name. **`shop`'s `_compare` and `teach`'s dedup are the intended consumers, but this is a one-directional OFFER this doc makes — not a co-signed contract**: shop.md defines its own `clusterProducts`/`extractModelKeys` and teach-ask.md its own content-hash dedup, neither importing `_entity.ts` today. Adopting `_entity` is a proposed later integration (a co-signed edit to those docs), not a dependency they already ratify; `entity` ships and stands alone regardless. |
| D8 | **All "oracle" retrofits re-point at `teach`/`ask`.** oracle is deleted/absorbed into the teach-ask pair (`docs/proposals/teach-ask.md`): storage is `_kb.ts` v3 (`KbSource[]`, kind-scoped keys), model calls are teach distill 700 / consolidate 1800 / ask answer 1024. `loadKb` already dual-reads legacy `sux:oracle:` keys. | The entity/mac-llm drafts referenced `oracle.ts`; that fn is gone. No back-compat break because `_kb` already carries content hashes and a legacy read path. |
| D9 | **Net fn-count delta across all five upgrades: +5** — `notify`, `diff`, `job`, `browse`, `entity`. mac-llm is +0 (infra); Workflows is +0 additional (its `job` unifies with D3). Against today's 89-fn registry: **89 → 94.** | Sibling proposals (teach/ask, style/edit, shop, travel) independently move the baseline; the delta *attributable to these five* is +5 regardless of merge order. |
| D10 | **Schedules and terminal history live in DISJOINT keyspaces; `sux:job:` retention is per-`source`, never uniform.** `source:"schedule"` records live under their own `sux:sched:<id>` prefix (bare-id-addressable, no pointer, **no `expirationTtl`** — lifecycle owned by `enable`/`disable`/`delete`), enumerable **completely** in one cheap `KV.list({prefix:"sux:sched:"})` bounded by `MAX_JOBS=100`. `source:"workflow"`/`"cron"` terminal records live under the chronological `sux:job:<invertedTs>:<id>` keyspace (+`sux:jobidx:<id>` pointer, both carrying `expirationTtl = JOB_RESULT_TTL` 604_800 s / 7 d set on the **terminal** write only; `invertedTs` from immutable `created` → idempotent rewrites). So all three schedule-enumeration paths — the drain's due-selection (§1.5), the `MAX_JOBS` cap (§1.4), the schedule-first `list` (§4.3) — scan the **complete, bounded** `sux:sched:` prefix; only terminal history is paginated newest-first. | A uniform TTL is fatal to one source class (a fixed TTL deletes the flagship `daily` watch after its window; a rolling TTL deletes any `disable`d schedule the moment it stops ticking; no TTL leaks terminal records unbounded and exhausts the cap with dead history) — AND a single commingled keyspace is fatal to schedule *enumeration*: prefixed by immutable `created`, an indefinitely-lived `daily` schedule sinks monotonically below the 7d-retained terminal records piling above it until §4.3's cost-capped bounded-page `list` can no longer contain it — the drain never reads it, never runs it, and the flagship watch stops firing silently (the exact D10 failure, reintroduced via a page-window path). Terminal records GC at 7d so their keyspace stays bounded; only indefinitely-lived schedules must not sit in a keyspace whose page window they can sink out of. Splitting BOTH keyspace and retention by `source` is the only policy that enumerates schedules completely and cheaply while capping history growth. The same 7d terminal retention that bounds history is also what a recurring `source:"cron"` enqueue's content-hash dedup would collide with — night 1's `complete` record is still live on nights 2–7 — so the cron path re-mints its dedup id per fire from `(scheduleId ?? "-", tickBucket)` (§4.2) and `source` must be a **real `enqueueJob` parameter, never a hardcoded literal**, or a cron enqueue lands in the terminal keyspace as a `workflow` and the nightly refresh never recurs. The `scheduleId` component of that key is separately load-bearing: two distinct-intent `source:"cron"` enqueues on the identical `(fn,args,tickBucket)` — the standalone nightly cron (§4.5) and the durable-dispatched watch escalation (§1.5) — otherwise collide onto one Workflow and one finalizer despite sharing `source` (§4.2/D3). |
| D11 | **Notify firing spans two disjoint status vocabularies — one mapping table (§1.5), source-scoped `on`-values.** `runJob` step 5 owns the *schedule* vocabulary inline (`changed`→`change`\|`always`, `unchanged`/`ok`→`always`, `errored`→`error`\|`always`); `finishNotify` owns *workflow/cron* only (`complete`→`complete`\|`always`, `errored`→`error`\|`always`) and never sees a schedule record. The one bridge — a durable-dispatched heavy watch (§1.4/§1.5) — runs on the durable engine but keeps the schedule vocabulary via `gateBackToSchedule` (feeds its result back through the parent `sux:sched:` change gate on completion), **not** `finishNotify`, so the vocabularies never merge. `create`/`enqueueJob` reject a `notify.on` that cannot fire for the target's `source` (and the escalated cron enqueue carries `notify: undefined`, dodging that rejection entirely). | There is no single "shared finalizer both paths call": a schedule recheck never emits `complete`/`errored`-then-`finishNotify` and `finishNotify` has no `changed`→`change` branch, so consolidating scheduled notification onto it silently kills every `notify.on:"change"` watch — the flagship proactive feature. `complete` is meaningless for a schedule and `change` for a durable job; only `always`/`error` fire on both, so an un-guarded shared enum lets an LLM configure a silently-inert job. |
| D12 | **`job op:"get"`'s null-read classification derives from the ECHOED handle timestamp, never the unreadable record.** The enqueue/create handle returns `created`; the caller echoes it back on `get`; a null read is `provisioning` (`<60s`), `gone` (`>JOB_RESULT_TTL`), or — with no echoed anchor — `unknown`, never `provisioning`-forever. | A bare content-hash `id` has no time component and a null read has no record, so the reader has no `created` to compare against — the §4.2 "null within 60s of `created` = provisioning" guard is unimplementable from the reader's side. §4.4 hardened the *writer* (`mark` reseeds from `event.payload`); the reader's only free durable anchor is the handle it is already polling. Without it, a hallucinated `job_id` polls `provisioning` forever and a silently-GC'd 7d result is indistinguishable from a fresh enqueue. A `sux:jobtomb:<id>` tombstone outliving the record is the anchorless backstop. |

---

## 1. Proactive layer — `notify`, `diff`, `job` + the cron drain

Ships three fns and one non-fn module (`sux/src/jobs.ts`, shared with Workflows §4). `watch` is kept (D2). All new env is optional and gated like `grafana.ts`. **+3 fns** (`notify`, `diff`, `job`).

### 1.1 `notify` — the output channel

**Transport:** keyless `ntfy.sh` HTTP push, direct Worker→public egress (D1). Env (all optional, `registry.ts` `RtEnv`):

```ts
NTFY_BASE_URL?: string;
NTFY_TOPIC?: string;
NTFY_TOKEN?: string;
NOTIFY_WEBHOOK_URL?: string;
```

`sux/src/fns/notify.ts`:

```ts
export type NotifySpec = {
	title?: string;
	message: string;
	priority?: 1 | 2 | 3 | 4 | 5;
	tags?: string[];
	url?: string;
	channel?: "ntfy" | "webhook";
};

export async function sendNotify(env: RtEnv, spec: NotifySpec): Promise<{ ok: boolean; error?: string }>;
```

`sendNotify` is the shared primitive both `notify.run` and the job/Workflow completion paths call. ntfy request:

```
POST `${NTFY_BASE_URL ?? "https://ntfy.sh"}/${NTFY_TOPIC}`
Authorization: Bearer <NTFY_TOKEN>?
body: JSON { message, title?, priority?, tags?, click? }   // page-derived text lives HERE, never in headers
AbortSignal.timeout(10_000)
```

**Header-injection fix (folded):** the earlier draft put `Title`/`Priority`/`Tags`/`Click` in HTTP request *headers* and claimed "no CRLF surface." That is wrong for any value derived from page content. **All page-derived text goes in the ntfy JSON POST body**; only owner-controlled constants may ride headers, and every header value is control-char-stripped before `fetch`. `notify.run` awaits and maps non-2xx → `failWith("upstream_error")`, unconfigured → `failWith("not_configured")`. Completion paths call `sendNotify` deferred and swallow the result (best-effort, never fails a job).

**Exfiltration posture (folded):** notify bodies can carry LLM output over untrusted scraped pages — a prompt-injectable channel to a *public* third party. The unguessable random `NTFY_TOPIC` is the only confidentiality control; the docs state this and recommend `NTFY_TOKEN`-protected or self-hosted ntfy for anything sensitive. `notify`'s destination is **pinned to `NTFY_TOPIC`** — it never accepts a caller-supplied destination host, so it cannot be turned into an arbitrary-URL exfil primitive by injection through a content-ingesting fn.

Schema: `required:["message"]`; `priority` int 1–5; `tags` string[]; `channel` enum `["ntfy","webhook"]`; `additionalProperties:false`. `Fn`: `cost:1`, `cacheable:false`, not `raw`.

**Deferred secondary (documented, not built):** `channel:"mac_imessage"` needs a `/notify` AppleScript route on the render node + a `macNotify()` Worker clone; ntfy covers the need and has no Mac dependency. `NOTIFY_WEBHOOK_URL` (Discord/Slack/Pushover generic JSON POST) is a third channel for free.

**60s:** a single 10s-timeout POST; trivially inside budget.

### 1.2 `diff` — semantic change report + price-trend primitive

Composed: `store`/`scrape` → `declutter` → hash gate → LLM compare (Workers-AI, or Mac tier when available) → structured report. `sux/src/fns/diff.ts`:

```ts
export type DiffReport = {
	changed: boolean;
	first_seen: boolean;
	summary: string;
	added?: string[];
	removed?: string[];
	numeric_deltas?: Array<{ label: string; from: number; to: number; pct: number }>;
	hash: string;
	previous_hash?: string;
	checked_at: string;
};

export async function computeDiff(env: RtEnv, args: DiffArgs): Promise<DiffReport>;
```

Two modes: **pure** `diff({a,b})` (stateless, `cacheable:true`) and **baseline** `diff({url|handle, id?, selector?, fetch?, mode?, tier?})` — fetch current, reduce to `selector` (reuse `watch`'s `reduce → select`), **`declutter`**, hash. Load prior snapshot from `sux:diff:<id>` (id defaults to `sha256(url\nselector)`). No prior → `first_seen`, store, no LLM. Hash unchanged → `changed:false`, no LLM. Changed → run the compare pass, store new snapshot, set `noCache:true`.

**Declutter-before-hash (folded major):** the change-gate **must** declutter/reduce and strip volatile fields (`checked_at`, request IDs, non-deterministic ordering) *before* hashing. Raw-text hashing fires on noise — shop/web_search/places results differ every run even when nothing material changed, producing constant false-positive pushes and defeating the "cheap gate" premise. For URL-content this reuses `watch`'s reduce+declutter pipeline exactly.

**Live fetch of "current" (folded blocker, shared with §1.5):** baseline mode's `store`/`scrape` fetch of the *current* state **must bypass the response cache** — a soft-expired hit under `CACHE_STALE_GRACE_SECONDS=86_400` (hard fact #2) would let `diff` compare a 24h-stale "current" against the stored prior and report `changed:false` for a live page that has already moved, and since the response cache key is `sha256(args)` shared across every caller, a human's manual `scrape url:X` can freeze the very value `diff` reads. **Fix:** `diff` fetches the current state **live** (the same `refresh`/`bypassCache` dispatch path §1.5 threads), never the stale-grace hit; only the *prior* snapshot legitimately comes from `sux:diff:<id>`. The baseline write still self-`noCache`s (below), so a diff tick never freezes its own fetch onto the shared key either.

**`tier:"mac"` gating (folded blocker):** the mac tier points at the mac-llm infra (§2), which does not exist until that upgrade lands. `tier:"mac"` is therefore **available only when `MAC_LLM_URL` is set, and silently falls back to Workers-AI otherwise** (the `macRender` `{ok:false}` contract). Default is always Workers-AI (`@cf/meta/llama-3.2-3b-instruct`). `numeric` mode is regex-only (no LLM) and always populates `numeric_deltas` — the price-trend core `shop`/`travel` consume.

`sux:diff:<id>` → `{ text, hash, at }`; decluttered text stored bounded, overflow → R2 CAS ref. Enumerable via `KV.list({prefix:"sux:diff:"})`. `Fn`: `cost:3`, `cacheable:true` (pure mode 1h), baseline mode returns `noCache:true` (self-guard like `watch.ts:77`), not `raw`.

**60s:** the LLM pass is one bounded call (Workers-AI sub-few-seconds, or the mac route under its own tight `timeout_ms` + breaker). Well inside budget.

### 1.3 `job` — the unified scheduler + durable-handle surface

One fn writes/reads the `sux:job:` space (D3). Serves proactive schedules, Workflow handles (§4), and cron enqueues. `sux/src/fns/job.ts`, `cost:1`, `cacheable:false`, `raw:true`:

```jsonc
{
  "type": "object", "additionalProperties": false, "required": ["action"],
  "properties": {
    "action": { "type": "string",
      "enum": ["create","list","get","delete","enable","disable","run","cancel"] },
    "id":       { "type": "string" },
    "created":  { "type": "integer", "description": "Echoed from the enqueue/create handle (§4.2) so get can classify a null read under KV lag: <60s→provisioning, >JOB_RESULT_TTL→gone. Omit and a bare-id null read is 'unknown', never eternal 'provisioning'." },
    "fn":       { "type": "string", "description": "Registry fn name to schedule, or \"pipe\". Must be schedulable (§1.4); a heavy arg shape (e.g. shop store:\"*\", deep crawl) is accepted only if the fn has a durable runner and then dispatches durably per fire (§1.5), else create rejects with bad_request." },
    "args":     { "type": "object", "additionalProperties": true },
    "schedule": { "type": "string", "enum": ["15m","hourly","6h","daily"] },
    "semantic": { "type": "boolean", "description": "On change, run diff for a 'what changed' payload (else boolean only)." },
    "status":   { "type": "string", "enum": ["queued","running","paused","complete","errored","canceled","ok","changed","unchanged"], "description": "list filter" },
    "limit":    { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
    "notify":   { "type": "object", "additionalProperties": false,
      "properties": {
        "on":       { "type": "string", "enum": ["change","always","error","complete"], "description": "'change' fires only for source:\"schedule\" watches; 'complete' only for durable source:\"workflow\"/\"cron\" jobs; 'always'/'error' fire on both. create rejects an on-value that cannot fire for the target's source (§1.5)." },
        "title":    { "type": "string" },
        "priority": { "type": "integer", "minimum": 1, "maximum": 5 } } }
  }
}
```

- `create` (scheduled recheck) → validate `fn` against the allowlist **and its args against the 18s inline budget** (§1.4): a cheap shape schedules inline; a heavy shape on a durable-runner fn is flagged `durable:true` (escalates per fire, §1.5); anything else `failWith("bad_request")` → `{id}`.
- `list` → newest-first (see §4.3 ordering fix), optional `status` filter.
- `get` → the full `JobRecord` incl. `progress`/`partial`/`result`/`last_error` (this is where partial-return-while-running lands). A **null** read is classified from the **echoed `created`** (§4.2), never the unreadable record: `<60s`→`provisioning`, `>JOB_RESULT_TTL`→`gone`, and with **no echoed anchor**→`unknown` (never eternal `provisioning`).
- `run` → run a scheduled job **now**; see the nested-deadline fix in §1.5.
- `delete`/`enable`/`disable` → scheduled-job lifecycle.
- `cancel` → durable-Workflow cancel (cooperative, §4.4).

The unified `JobRecord` (in `sux/src/jobs.ts`):

```ts
export type JobSource = "schedule" | "workflow" | "cron";
export type JobStatus = "queued" | "running" | "paused" | "complete" | "errored" | "canceled" | "ok" | "changed" | "unchanged";

export type JobRecord = {
	id: string;
	source: JobSource;
	status: JobStatus;
	created: number;
	updated: number;
	// scheduled-recheck fields
	fn?: string;
	args?: Record<string, unknown>;
	schedule?: "15m" | "hourly" | "6h" | "daily";
	notify?: { on: "change" | "always" | "error" | "complete"; title?: string; priority?: number };
	semantic?: boolean;
	enabled?: boolean;
	durable?: boolean;
	inflight_since?: number;
	inflight_instance?: string;
	last_run?: number;
	last_hash?: string;
	last_snapshot?: string;
	last_error?: string;
	// durable-workflow fields
	kind?: string;
	scheduleId?: string;
	progress?: { done: number; total?: number; note?: string };
	partial?: unknown;
	result?: ToolResult;
	pollAfterMs?: number;
	attempt?: number;
};
```

**Prior-snapshot fix (folded blocker):** the draft persisted only `last_hash`, so `semantic:true` could never say *what* changed for any target fn other than `diff` itself — `computeDiff` pure mode needs both old and new text. **Fix:** for a `semantic` job the record carries `last_snapshot` — the prior decluttered result text (or a `sux:diff:` ref when large) — and `runJob` passes old+new into `computeDiff` pure mode. `last_hash` stays the cheap gate; the snapshot is the explainer. Equivalently a `semantic` job may target `fn:"diff"` and let diff own its own snapshot store; both compose.

**Storage split & retention by `source` (folded blocker):** the three unified sources have irreconcilable lifetimes **and** irreconcilable enumeration needs, so they split across two keyspaces, and the `JobRecord` contract fixes each explicitly rather than leaving `expirationTtl` (or the keyspace) to an implementer's guess (any single uniform choice silently breaks one source class — see D10). **`source:"schedule"` records live under their own `sux:sched:<id>` prefix** (bare-id-addressable, no `sux:jobidx` pointer) and **carry NO `expirationTtl`** — their lifetime is owned entirely by `enable`/`disable`/`delete` (§1.3 actions), never by expiry — so a `daily` recheck persists indefinitely and a `disable`d schedule survives paused until an explicit `delete`. This keyspace is disjoint from terminal history by construction, so the live-schedule set is enumerated **completely** by one `KV.list({prefix:"sux:sched:"})` (bounded ≤`MAX_JOBS`): the drain (§1.5), the cap (§1.4), and the schedule-first `list` (§4.3) never depend on terminal-record volume, and an indefinitely-lived schedule can never sink out of a bounded page the way it would in a commingled `created`-prefixed keyspace (D10). A rolling TTL refreshed by the 15m `last_run` writeback is **forbidden**: it would keep active schedules alive via their own ticks but silently delete any paused job the moment it stops ticking, contradicting the documented pause/resume lifecycle. **`source:"workflow"`/`source:"cron"` records live under the chronological `sux:job:<invertedTs>:<id>` keyspace and carry a bounded `expirationTtl = JOB_RESULT_TTL` (604_800s / 7d) set on the TERMINAL write only** (`complete`/`errored`), so a completed nightly job's result survives its poll+notify window then GCs instead of accumulating forever; in-flight writes (`queued`/`running`) carry no TTL so a slow job can never expire mid-flight. This is the concrete referent for "expire at its TTL unseen" (§4.5) — it is a workflow/cron property, never a schedule property. §1.5 states the `writeJob` mechanics and the pointer's matching expiry; §1.4 reconciles the cap; §4.3 reconciles `list` order.

**In-flight latch for durable-dispatched schedules (folded major — re-entrancy across ticks):** a `durable:true` schedule (§1.4) whose durable fire outlasts its own cadence is the *expected* case, not a corner — `shop store:"*"` is ~8 serialized concurrency-1 mac solves (minutes; D6/§4.7), trivially longer than a `15m` tick and plausibly longer than `hourly` under solver backoff/retries. Nothing in the tick loop latches "a fire for this schedule is already running": `last_run` is written **before** dispatch (§1.5) so the schedule reads due again on the next heartbeat, and the escalation dedup key is `(scheduleId, tickBucket)` with a **time-varying** `tickBucket` (§4.2) — the very property that gives cross-tick recurrence — so the next tick computes a *different* `baseId`, misses the still-in-flight prior Workflow, and spawns a fresh one. Left unguarded this leaks overlapping Workflows unbounded (each solving on `solver_sem` size 1 → an ever-growing serialized backlog, the exact single-solver backpressure D6/§4.7 exist to protect) and races two `gateBackToSchedule` writebacks on the one `sux:sched:<id>` parent (duplicate `notify.on:"change"` pushes for one logical change, RMW-fought `last_hash`/`last_snapshot`). **Fix — an in-flight latch on the parent `sux:sched:` record:** the `JobRecord` carries `inflight_since?: number` (+ optional `inflight_instance?`); `runJob`'s durable short-circuit **skips the fire** if `parent.inflight_since` is set AND younger than a documented `DURABLE_FIRE_MAX_MS` staleness cap (so a Workflow that died without finalizing cannot wedge the schedule forever), otherwise sets `inflight_since = Date.now()` on the parent **before** escalating (§1.5); `gateBackToSchedule` **clears `inflight_since`** on completion (both `complete` and `errored`) in the same writeback that advances `last_run`/`last_hash`/`last_snapshot`, and that writeback **refuses to regress a newer `inflight_since`** (the RMW guard). The latch is cleared on completion, so the next period's tick re-fires — recurrence is preserved, overlap is forbidden, and a crashed Workflow self-heals past `DURABLE_FIRE_MAX_MS`. This is a distinct axis from §4.2's `(scheduleId,tickBucket)` dedup (which separates *distinct-intent* enqueues within/across buckets) and from the §1.5 deadline/finalizer split: those guard *which* Workflow a fire coalesces onto; the latch guards whether a *new* fire is allowed at all while the schedule's prior durable run is still in flight.

### 1.4 Schedulable allowlist (positive, not a denylist)

**Folded blocker:** the draft's `SCHEDULABLE` denylist was bypassable and partly unimplementable — `fn:"pipe"` sub-steps were never inspected (a scheduled pipe could call `kv_delete`, recurse into `job` create for a job-bomb, or mutate infra), and "oracle writes / store writes" cannot be denied by bare fn name (they are action-gated single fns).

**Fix — a positive allowlist plus recursive validation plus an args-cost gate:**

- A **`schedulable: true` capability flag on `Fn`** (registry-level), set only on side-effect-free, cacheable, read-only fns: `search`, `web_search`, `scrape`, `render`, `crawl`, `watch`, `diff`, `shop`, `product_search`, the retailer/research/extract/convert fns, `ask` (read side). `job` validates `create` against this flag.
- **`schedulable:true` is necessary but NOT sufficient — the flag gates the *fn*, an args-cost gate gates the *invocation* (folded major).** A scheduled recheck is by definition a cheap change-gate that must fit the inline drain budget `JOB_RUN_DEADLINE_MS=18_000` (§1.5), but schedulability is a per-*fn* capability while fitting 18s is a per-*args* property, and the flag alone cannot tell `shop {store:"kroger", query:"eggs"}` (one bounded fetch, seconds) from `shop {store:"*"}` (~8 serialized concurrency-1 mac solves, minutes — a hard fact). So `job action:"create"` **additionally validates that the target's declared args provably fit 18s**, rejecting the known-unbounded shapes on otherwise-schedulable fns: `shop store:"*"` (schedulable inline only for a bounded store set / single query), `crawl` beyond a shallow `depth`/`max_pages` cap, and any target whose declared fan-out exceeds a documented ceiling. `shop` and `crawl` are therefore **not wholesale schedulable** — the fn flag says the *shape* is allowed, the args gate says whether *this* invocation is cheap enough to recheck every tick.
- **Heavy-but-recurring is the durable path, not a rejection (folded major — the schedule↔durable bridge).** The args gate does not simply forbid recurring heavy work — the design *wants* nightly `shop store:"*"` — it **routes** it: at `create`, a heavy-args target whose `fn` has a §4 durable runner (`crawl`/`teach`/`shop`) is accepted and flagged **durable-dispatched** (`durable:true` on the `sux:sched:` record; still `source:"schedule"`, but its tick escalates to the durable path rather than running inline, §1.5); only a heavy target with **no** durable runner, or fan-out past even the durable ceiling, is `failWith("bad_request")`. When `WORKFLOWS` is unbound (before §4 lands — build-order step 11), there is no durable executor yet, so `create` **fails closed** and rejects a durable-dispatched target too — heavy scheduling switches on with the Workflows binding, matching the no-op-until-bound posture of every other capability here. This is the literal realization of D3's "one substrate, `source` discriminates": the inline 18s budget is reserved for genuinely cheap rechecks, and a heavy scheduled target transparently becomes a `source:"cron"` durable enqueue at fire time — so the flagship `job action:"create" fn:"shop" args:{store:"*"} schedule:"daily" notify:{on:"change"}` is **accepted and delivers**, instead of being enrolled inline where it would trip the 18s deadline every tick, record `errored`, and (per the §1.5 mapping) never fire on `change`. **Invariant — a schedule's durable runtime must be reconciled against its cadence.** A `durable:true` target can run for minutes (`shop store:"*"` ≈ 8 serialized concurrency-1 solves), longer than a `15m` or even an `hourly` tick, so the accept path must forbid a fire from overlapping the schedule's own still-in-flight prior fire — either the **in-flight latch** on the `sux:sched:` parent (recommended, §1.3/§1.5) or a create-time rejection of a heavy-durable target on a cadence shorter than its documented worst-case runtime. Without one, the args gate that routed the target *to* the durable path would then let it re-fire every tick and accumulate overlapping Workflows on the concurrency-1 solver (D6/§4.7).
- **Explicitly non-schedulable:** `job`, `notify`, `kv_put`/`kv_delete`, `store` writes, `teach` (write side), `browse`, `selftest`. No self-mutation of infra, no recursion, no scheduled purchases.
- **`fn:"pipe"` is validated recursively** at create time: every sub-step's `fn` must itself be schedulable, and a `(fn,action)`-tuple denylist rejects `store {action:"put"|"delete"}`, `kv_*`, `teach` writes even where the bare fn might otherwise pass.
- Cap `MAX_JOBS = 100`, counted by a direct `KV.list({prefix:"sux:sched:"})` over the schedule keyspace (enabled + disabled), which is **disjoint by construction** from terminal `source:"workflow"`/`"cron"` history (`sux:job:<invertedTs>:<id>`, §1.3). The count is therefore both **complete** (never a page window that could under-count schedules hidden past a cursor) and **cheap** (one bounded list of ≤100 keys), and accumulated durable-job results (which GC at `JOB_RESULT_TTL`, §1.3/§1.5) can never exhaust the cap and refuse a new schedule `create`. Dead history never blocks a live watch.

### 1.5 The cron drain — `sux/src/jobs.ts`

```ts
export async function readJob(env: RtEnv, id: string): Promise<JobRecord | null>;
export async function writeJob(env: RtEnv, j: JobRecord): Promise<void>;
export async function listSchedules(env: RtEnv): Promise<JobRecord[]>;
export async function listJobs(env: RtEnv, filter?: JobStatus, limit?: number): Promise<JobRecord[]>;
export async function deleteJob(env: RtEnv, id: string): Promise<void>;
export async function runJob(env: RtEnv, ctx: ExecutionContext, j: JobRecord): Promise<JobRecord>;
export async function drainJobs(env: RtEnv, ctx: ExecutionContext): Promise<void>;
export async function finishNotify(env: RtEnv, rec: JobRecord): Promise<void>;
export async function gateBackToSchedule(env: RtEnv, rec: JobRecord): Promise<void>;
```

`finishNotify` takes the terminal `JobRecord` **the completion path already holds in memory** — it never re-reads it from KV by `id` — reads its `notify` spec + `status` + `result`, and fires `sendNotify` (§1.1) when `notify.on` is satisfied by the outcome. Re-reading here would reintroduce, at the single most load-bearing moment, the exact un-anchored bare-id KV read §4.2/§4.4 built the reader/writer symmetry to eliminate: `mark`'s own opening `readJob(jobId)` populates the in-request KV read cache with the PRE-terminal value, so a subsequent `readJob(jobId)` in the same isolate could be served that stale `running`/no-`result` record (or a lagging pointer could read null) and fire nothing — silent results-rot on the flagship durable-job deliverable, resurrected via the finalizer's own re-read. So `SuxWorkflow.run()` passes the merged record it just wrote (§4.4); `finishNotify` recovers `notify`/`status`/`result` from that in-memory object and can never be served a stale/cached/null pre-terminal value. It is the **workflow/cron finalizer only** — called from the `SuxWorkflow` completion path (§4.4/§4.5), never from the schedule path — and its body implements exactly the durable rows of the mapping table below; a record with `notify: undefined` sends nothing. `gateBackToSchedule` is its sibling for the one case a durable Workflow *is* servicing a schedule (a durable-dispatched heavy watch, §1.4/§1.5): the `SuxWorkflow` completion path calls it **instead of** `finishNotify` when the terminal record carries a `scheduleId`, and it feeds the fresh `result` back through the parent `sux:sched:` record's change gate (declutter→hash→schedule-vocabulary notify per the mapping) rather than the durable rows — so `finishNotify` still never fires a `change` and never touches a schedule.

**The complete outcome→`notify.on` mapping (folded major — one table over two vocabularies).** Notify firing spans **two disjoint status vocabularies** (schedule: `changed`/`unchanged`/`errored`→`change`/`always`/`error`; durable: `complete`/`errored`→`complete`/`always`/`error`), and the load-bearing invariant is that they never merge — `finishNotify` has no `change` branch and never sees a schedule. There is no single "shared finalizer"; the cron drain's *schedule* jobs notify inline via `runJob` step 5 (below) and only the durable `SuxWorkflow` completion path calls `finishNotify`. The one bridge — a durable-dispatched heavy watch (§1.4/§1.5) — executes the **schedule** vocabulary from the durable completion via `gateBackToSchedule` (not `finishNotify`), so the vocabularies stay disjoint even where a schedule runs on the durable engine. This table is the single source of truth for all three sites:

| Dispatcher (owner) | `source` | Terminal status | Fires when `notify.on` ∈ |
|---|---|---|---|
| `runJob` step 5 — inline (§1.5) | `schedule` | `changed` | `change`, `always` |
| `runJob` step 5 — inline (§1.5) | `schedule` | `unchanged` / `ok` | `always` |
| `runJob` step 5 — inline (§1.5) | `schedule` | `errored` | `error`, `always` |
| escalated: change gate on the cron job's completion (§1.5) | `schedule` (durable-executed) | `changed` / `unchanged` / `errored` | identical to the inline `schedule` rows above — a durable-dispatched fire feeds its result back through the schedule change gate and fires the schedule vocabulary, **NOT** `finishNotify` |
| `finishNotify` (§4.4/§4.5) | `workflow` / `cron` | `complete` | `complete`, `always` |
| `finishNotify` (§4.4/§4.5) | `workflow` / `cron` | `errored` | `error`, `always` |

**Ownership, stated unambiguously:** a `source:"schedule"` recheck never reaches a `complete`/`errored`-then-`finishNotify` terminal — its terminal statuses are `changed`/`unchanged`/`ok`/`errored` (the `JobStatus` enum, §1.3) and it notifies **inline in `runJob` step 5**, which is the sole owner of the schedule vocabulary. `finishNotify` has **no `changed`→`change` branch** and never sees a schedule record; consolidating scheduled-recheck notification onto it — the reading the old "shared finalizer both paths call" language invited — would make every `notify.on:"change"` watch structurally inert, exactly the flagship proactive feature silently killed. Conversely a durable `source:"workflow"`/`"cron"` job has no change detection, never emits `changed`/`unchanged`, and is finalized by `finishNotify` — the **sole** carve-out being a `source:"cron"` job that carries a `scheduleId` (a durable-dispatched schedule), which routes through `gateBackToSchedule` into the schedule vocabulary instead (below). So `change` is meaningless for a durable job and `complete` is meaningless for a schedule; `always`/`error` are the only two that fire on both. **The one exception that proves the ownership rule is the durable-dispatched schedule** (§1.4, heavy args on a §4 runner): its fire escalates to a `source:"cron"` Workflow, but the schedule — never the cron record — keeps ownership of change detection and notify, and its result is fed **back through the schedule change gate** on completion (below) so `notify.on:"change"` still fires; `finishNotify` never touches it, so its `change`-less vocabulary is not consolidated onto the schedule path.

**Create-time rejection of cross-surface misuse (folded major):** because the single `notify.on` enum is shared across both surfaces, `job action:"create"` (schedule) and the `enqueueJob` durable path (§4.2) each **reject or normalize a `notify.on` that cannot fire for the target's `source`** rather than accepting a silently-inert config — `on:"complete"` on a `source:"schedule"` create → `failWith("bad_request")` (a `daily` watch never emits `complete`), and `on:"change"` on a durable `workflow`/`cron` enqueue → the same rejection (no change detection in the durable path). The schema `on` description (§1.3) states the restriction so a calling LLM sees it up front.

**Two keyspaces, one bare-id lookup (folded blocker):** `source:"schedule"` records are stored **directly** under `sux:sched:<id>`, so a bare id resolves in one `KV.get` with no pointer and `listSchedules` enumerates the whole live-schedule set with one `KV.list({prefix:"sux:sched:"})` (complete, ≤`MAX_JOBS`, §1.3/§1.4/D10). The pointer machinery below exists **only** for terminal `source:"workflow"`/`"cron"` records, whose chronological key defeats direct addressing: `writeJob`/`deleteJob`/dedup/`action:"get"` are addressed by a **bare content-hash `id`**, but the terminal record is *stored* under the chronological primary key `sux:job:<invertedTs>:<id>` (§4.3's newest-first `KV.list`, paginated by `listJobs`). A single key cannot be both O(1)-computable from a bare id AND timestamp-prefixed, so the two are bridged by a tiny pointer key `sux:jobidx:<id>` → the primary key (or its `invertedTs`): `readJob` first tries `KV.get("sux:sched:"+id)` (schedules, direct) and on a miss does `KV.get("sux:jobidx:"+id)` → `KV.get(<primary>)` (terminal, one extra hop, never a list scan); `writeJob` routes by `source` — a `schedule` record goes directly to `sux:sched:<id>` (no pointer), a terminal `workflow`/`cron` record goes under the primary key **and** the pointer under `sux:jobidx:<id>`; `deleteJob` removes `sux:sched:<id>` for a schedule, or the primary+pointer pair for a terminal record. Pointer writes/deletes are **best-effort under KV eventual consistency** (same window as §4.2's `provisioning`) — a stale pointer resolves to a missing record and is treated as `not_found`/re-provisioned. This is what lets a deterministic `baseId` dedup (§4.2) and a time-ordered `KV.list` (§4.3) coexist on one keyspace; `sux:jobidx:` is covered by the wholesale `sux:` `RESERVED` prefix (§4.1), so no `kv_put` collision.

**Per-source retention & pointer expiry (folded blocker):** `writeJob` routes the record to its keyspace by `source` (`sux:sched:<id>` vs `sux:job:<invertedTs>:<id>`, above) and derives `expirationTtl` from `(j.source, j.status)` per §1.3 — `source:"schedule"` → **no TTL** (durable until `deleteJob`); `source:"workflow"|"cron"` → **no TTL while `queued`/`running`**, then `expirationTtl = JOB_RESULT_TTL` (`604_800` s / 7 d) on the terminal `complete`/`errored` write. The **`sux:jobidx:<id>` pointer (terminal records only) is written with the SAME `expirationTtl` as its primary record on every `writeJob`**, so the pair expires together: a pointer that outlives its record already resolves to `not_found` (acceptable, above), but a live record must **never** be orphaned by an expired pointer. The `invertedTs` prefix in `sux:job:<invertedTs>:<id>` derives from the **immutable `created`** timestamp (**not** `updated`), so every status transition **rewrites the same key idempotently** — a rolling-key-per-write would leak one stale key per transition regardless of TTL, and would also split a record from its own history.

**`writeJob` header invariant (folded blocker):** `writeJob` **rejects (or `console.warn`s + no-ops) any record whose `created` or `source` is `undefined`** rather than silently stringifying them into a garbage `sux:job:<invertedTs>:<id>` key. The §4.4 durable-payload seeding guarantees both are always present on every write (a null KV read inside the Workflow reseeds from `event.payload`, never from a bare `{id}` stub), and this invariant is the backstop that turns what would otherwise be silent key-splitting corruption into a visible failure — no writer may derive the primary key or the `(source,status)` TTL from an undefined field.

Cron (`wrangler.jsonc:22`): add a `*/15` heartbeat beside the existing `0 13` maintenance cron.

```jsonc
"triggers": { "crons": ["*/15 * * * *", "0 13 * * *"] },
```

`index.ts:430` — rename `_event`→`event`, branch:

```ts
async scheduled(event: ScheduledController, env: RtEnv, ctx: ExecutionContext): Promise<void> {
	ctx.waitUntil(runScheduled(event, env, ctx));
},
```

`runScheduled` runs `maintenanceTick` on the `0 13` cron and `drainJobs` on the heartbeat, in an outer try/catch → `console.warn` (mirrors `maintenanceTick`). Adding a cron entry is fully **reversible** (remove it) — the earlier "irreversible" framing was wrong.

**Drain wall-time + lock (folded major):** `MAX_JOBS_PER_TICK=25` × per-job `withDeadline(60_000)` sequential = up to 25 min, far past a 15-min heartbeat; and with KV eventual consistency two overlapping heartbeats both `listSchedules` and re-select the same due jobs (double-run + double-notify). One-key-per-job fixes RMW-loss but **not** cross-tick double-fire. **Fixes:**

- **Per-job deadline lowered to `JOB_RUN_DEADLINE_MS = 18_000`** so a full 25-job drain fits inside one heartbeat with margin.
- **A drain lease:** `sux:job:lock` KV key with a short TTL (e.g. 13 min); a heartbeat that can't take the lease skips. (Documented as best-effort — KV has no CAS; a Durable Object is the escalation if double-fire is ever observed, per the `metrics.ts:1-4` guidance.)
- **`last_run` is written BEFORE dispatch, not after**, so a crash or an overlap re-selects nothing.
- `drainJobs` calls `listSchedules` — a **complete** scan of the bounded `sux:sched:` prefix (§1.3/D10), never a page window over commingled terminal history, so a long-lived `daily` schedule can never sink out of due-selection — then filters `enabled && due`, **sorts most-overdue-first, then slices** to `MAX_JOBS_PER_TICK`.

`runJob` — **a durable-dispatched schedule (`durable:true`, §1.4) short-circuits before step 1**: `runJob` consults the **in-flight latch** first — if `j.inflight_since` is set AND younger than `DURABLE_FIRE_MAX_MS` (a documented staleness cap, e.g. a small multiple of the target's worst-case runtime), the prior durable fire is still running, so `runJob` **skips this fire** and returns without escalating (no overlap); otherwise (unset, or stale past `DURABLE_FIRE_MAX_MS` — a Workflow that died without finalizing) it sets `j.inflight_since = Date.now()` (and `inflight_instance`) on the `sux:sched:` parent, escalates the fire to the durable path (see "Args-cost escalation" below), and returns. Steps 1–6 are the inline sub-18s path only. The latch is cleared by `gateBackToSchedule` on completion (§1.5/§4.5), so the next period's tick re-fires — this preserves cross-tick recurrence while forbidding a fire from overlapping its own schedule's in-flight prior fire.

1. Resolve `fn` via the manifest (dynamic `import("./fns")`, avoiding the `jobs.ts`↔`fns/index.ts` cycle).
2. **Route through the shared dispatch, not `fn.run` raw (folded major):** the draft called `fn.run(env, j.args)` directly, bypassing `normalizeArgs` (`index.ts:197`), `checkArgs`, `clampResult`, and `weightedRateLimit` — so a scheduled call was *not* equivalent to the same call made directly, and the claimed "transitive rate-limiting" never happened (the limiter charges the inbound `job` rpc once, cost 1, and is never re-entered). **Fix:** `runJob` normalizes `j.args` through `normalizeArgs`, runs under `withDeadline(j.fn, JOB_RUN_DEADLINE_MS, …)`, applies `clampResult`, and charges the target's `Fn.cost` against the weighted limiter inside the tick. The doc no longer claims transitive throttling that doesn't happen.

   **Cache-bypass on the scheduled dispatch (folded blocker):** a *direct* `tools/call` in this codebase reads through the response cache — `index.ts:285-290` serves a soft-expired hit immediately and `CACHE_STALE_GRACE_SECONDS=86_400` (hard fact #2) freezes any non-`isError`/non-`noCache` result for up to 24h. Every fn on the §1.4 allowlist is there *precisely because it is cacheable read-only*, so a faithful "equivalent to a direct call" dispatch is exactly the wrong thing here: `runJob`'s step-2 dispatch of `scrape url:X` would return the frozen bytes, step 3 would hash a frozen value, and `changed = last_hash && hash !== last_hash` would compare one frozen value against another — `unchanged` for up to 24h no matter how the live page moves, so `notify.on:"change"` **never fires** (the flagship watch feature inert exactly when it should trigger). Worse, hard fact #2's named failure — a success-shaped result built from an all-failed run frozen onto the key for a day — gets hashed and reported as the stable truth, both suppressing a real change and, on `first_seen`, poisoning the baseline; and because the cache key is `sha256(args)` shared across every job and every human call with identical args, one user's manual `scrape url:X` at T+3m freezes the value the recheck reads at T+15m (cross-job/cross-caller contamination of a supposedly per-job gate). **Fix:** the scheduled dispatch **forces a live re-fetch** — it runs the normalize→checkArgs→withDeadline→clampResult→rate-limit core with the cache read AND `deferCacheWrite` suppressed (thread a `bypassCache` flag into the dispatch helper, or pass the target the equivalent of `refresh:true`/`noCache`), so it neither serves a soft-expired hit nor freezes the tick's fetch onto the shared `cache:<sha256>` key. **The corrected equivalence (supersedes the "equivalent to a direct call" language above):** a scheduled call is equivalent to a direct call *in normalization, deadline, clamping, and rate-limiting* but explicitly **NOT in cache behavior** — a change detector reading through a 24h stale-while-revalidate cache is the one way it *must* differ from a direct call, and this bypass is what makes the all-cacheable §1.4 allowlist (hard fact #2) safe to schedule.
3. Declutter + strip volatile fields → hash → `changed = last_hash && hash !== last_hash`.
4. `changed && semantic` → `computeDiff` pure mode over `last_snapshot` + new text.
5. **Schedule-vocabulary notify dispatch (inline — this path owns it, NOT `finishNotify`):** map the terminal status through the *schedule* rows of the §1.5 table — `changed`→fires on `change`|`always`, `unchanged`/`ok`→fires on `always`, `errored`→fires on `error`|`always` — and call `sendNotify` (§1.1, deferred, swallowed) when satisfied. A `source:"schedule"` job **never** reaches `finishNotify` (which has no `changed`→`change` branch); routing scheduled rechecks through `finishNotify` would make every `notify.on:"change"` watch structurally inert — the exact "notice + push" feature the proactive layer exists to deliver.
6. Write back `last_run`/`last_hash`/`last_snapshot`/`status`/`last_error` on **its own key** (no shared-array RMW). Per-job try/catch: one poison job records `errored` on its own key and the loop continues.

**Nested-deadline fix (folded major):** `job action:"run"` is request-bound — `handleRpc` already wraps `job.run` in `withDeadline("job",60_000)`, and a naive `runJob` wrapping the target in a *second* 60s deadline means a >55s target trips the **outer** deadline first: the caller gets a timeout `isError`, the run promise is abandoned but keeps running, and `runJob` then writes the record and fires `sendNotify` **after** the RPC already returned an error → a phantom "changed" push for a call the user was told timed out. **Fix:** the inner `runJob` deadline is `JOB_RUN_DEADLINE_MS=18_000` (meaningful headroom below the outer 60s for `computeDiff`+notify), and notify/writeback are gated on the dispatch not having already timed out. `action:"run"` may alternatively return a `queued` ack and run the drain way — never race two 60s timers.

**Args-cost escalation — inline drain is sub-18s only, heavy targets go durable (folded major — the §1.4↔§1.5↔§4 reconciliation):** `runJob`'s inline dispatch (step 2) handles **only** targets whose args provably fit `JOB_RUN_DEADLINE_MS=18_000`; the `create` args gate (§1.4) already refuses to enroll a heavy shape for inline execution, so `runJob` never faces one it cannot meet. A schedule flagged **durable-dispatched** (`durable:true`, §1.4 — heavy args on a §4 runner fn) does **not** run inline: when the drain selects it as due, `runJob` **escalates that fire to the durable path** — `enqueueJob(env, "cron", j.kind, j.fn, j.args, undefined, tickBucket, j.id)` into `SuxWorkflow` (§4.2), state-only (`notify: undefined`) but carrying the parent's `scheduleId = j.id`, where `tickBucket` is the schedule's scheduled bucket (calendar date for `daily`, hour for `hourly`, the due-tick bucket for `15m`/`6h`) so each fire re-mints `baseId` from `(scheduleId=j.id, tickBucket)` and spawns a **fresh** Workflow past the prior fire's 7d-retained `complete` record (§4.2/D10). Because `scheduleId=j.id` is in that dedup key, this escalation can never coalesce with a schedule-less standalone cron enqueue (§4.5, `scheduleId="-"`) on the identical `(fn,args,tickBucket)` — the two mint distinct Workflows and keep their distinct finalizers (`gateBackToSchedule` here vs `finishNotify` there), which is the only thing that keeps the schedule's `change` gate from silently vanishing onto a `finishNotify` record. **The escalation is latch-guarded (§1.3):** `runJob` sets `inflight_since` on the `sux:sched:` parent immediately before this `enqueueJob` and skips the fire entirely when the latch is already live (younger than `DURABLE_FIRE_MAX_MS`), so a durable fire whose wall-time exceeds the schedule's period — the expected case for `shop store:"*"` on a `15m`/`hourly` cadence — cannot spawn a second overlapping Workflow on the next tick just because `tickBucket` (and thus `baseId`) advanced; `gateBackToSchedule` clears the latch on completion so the following period re-fires. This is the bridge the two halves of `job` were missing: the schedule surface enrolls the heavy target, the durable surface actually runs it, and `source` discriminates exactly as D3 promised. **As a runtime backstop, an inline dispatch that unexpectedly trips the 18s deadline also escalates** to the durable path rather than recording a phantom `errored` (which, per the mapping, would never fire on `change`) — so the deadline-vs-args-cost incoherence cannot survive even a mis-estimated arg shape, and the secondary partial-but-success-shaped hazard (an 18s cut yielding an `ok`/`changed`-hashed partial that poisons the baseline) never arises because the heavy target is never cut at 18s in the first place.

**Escalated fires keep the schedule's `change` vocabulary (the notify bridge):** a durably-escalated fire must still honor `notify.on:"change"` — the flagship heavy watch is a change detector — but the durable path has no change gate and §4.2/D11 **rejects** a durable enqueue carrying `on:"change"`. So the escalation enqueues the cron job **state-only** (`notify: undefined`) carrying a **`scheduleId` back-reference** to its `sux:sched:<id>` parent (§1.3 `JobRecord.scheduleId`); on completion the `SuxWorkflow` finalizer, seeing `scheduleId`, **feeds the fresh result back through the schedule change gate** (§4.5) — declutter→hash vs the schedule record's `last_hash`/`last_snapshot`, then the *schedule* rows of the mapping table (`changed`→`change`|`always`, `unchanged`/`ok`→`always`, `errored`→`error`|`always`) — and writes back `last_run`/`last_hash`/`last_snapshot` on the `sux:sched:` record, exactly as inline `runJob` steps 3–6 would have. **That same writeback clears the in-flight latch** (§1.3): it sets `inflight_since = undefined` on both `complete` and `errored` terminals (so the next period's tick re-fires), and it **refuses to regress a newer `inflight_since`** — the RMW guard, in case a stale-past-`DURABLE_FIRE_MAX_MS` re-fire already re-latched the parent — so a slow finalizer cannot reopen a latch a fresh fire legitimately holds. `finishNotify` (durable vocabulary, `complete`/`error`/`always`) is thus reserved for schedule-**less** cron/workflow jobs (§4.5's fire-and-forget nightly re-teach); a schedule-backed durable fire never reaches it, preserving D11's invariant that `finishNotify` has no `change` branch and never fires from a schedule.

**Selftest (folded minor):** ntfy has no dry-run — any POST buzzes the phone. The selftest probe is a **config-presence check** (`NTFY_TOPIC` set?) that does **not** send, unless an explicit opt-in flag is passed.

### 1.6 Security & fn-count

Auth: all three inherit the single-login gate (`isAllowedLogin`, `index.ts:330`). Jobs are stored, owner-created, auto-replayed owner calls with the Worker's egress — the allowlist (§1.4) bounds blast radius. SSRF: `diff` url mode and job targets fetch through `store`/`scrape`/`render`, which already apply `isBlockedTarget`/`isPrivateIp` (`proxy.ts:115-173`). **fn-count: +3** (`notify`, `diff`, `job`). `jobs.ts` is a module. `watch` kept, description gains a cross-reference to `diff`/`job`.

---

## 2. Mac LLM tier — a stronger local model behind `llm()`

Escalate `llm()` from Workers-AI (llama-3.2-3b, default) to a warm Ollama model on the render Mac via a new `/llm` route. **Zero new fns** — pure infra behind `llm()`; the tool surface is untouched. With `MAC_LLM_URL` unset, `tier:"strong"` is byte-identical to today.

**Natural consumers (re-pointed off deleted oracle, D8):** `teach`/`ask` distillation (esp. the `ask` answer call, 1024 tok — multi-fact reasoning, the 3B's weakest job), `style`/`edit` (voice) rewrite (instruction-faithful rewriting, the acute 3B weakness), and `summarize`/`translate` for long no-URL text. **NOT** oracle — that fn is gone.

### 2.1 Transport — reuse the render Funnel, add a `/llm` route

One Funnel, one physical secret, a new route (not a second Funnel port). Wire a **distinct env pair** `MAC_LLM_URL`/`MAC_LLM_SECRET` (in practice the same URL/secret as `MAC_RENDER_*`) so inference is independently togglable, breaker-tracked, and relocatable to its own box. HMAC scheme verbatim from `mac-render.ts:97-112`.

Node endpoint `POST /llm?ts=<ms>&sig=<hex>` request JSON:

```json
{ "system": "…", "user": "…", "max_tokens": 1024, "model": "qwen2.5:7b-instruct-q4_K_M",
  "temperature": 0.2, "timeout_ms": 30000 }
```

**HMAC freshness (folded minor→now load-bearing):** `_authorized` (factored out of `h_render:137-141`) currently checks only the signature over `ts\npayload`, never that `ts` is recent. On a public Funnel a captured signed `/llm` request is replayable, and `/llm` drives an **unbounded-cost generation** (compute-DoS on the shared Mac) — a worse asymmetry than idempotent `/render`. **Fix:** `_authorized` rejects `|now - ts| > 60s`. This hardens `/render` at the same time.

**Model allowlist rationale corrected (folded minor):** the allowlist (`MAC_LLM_MODELS`) is about **resident-model / RAM control**, not weight exfiltration — Ollama `/api/chat` does not pull weights, it just errors on an unknown model. An unlisted `model` → `400`. Prompt-injection defense stays centralized in the Worker: `ai.ts` composes the trusted `system` (`${system}\n\n${guardInstruction(task)}`) and the fenced `user` (`wrapUntrusted(user)`) *before* signing, so the node is a dumb pass-through and the guard cannot be relocated.

### 2.2 Node — `render_server.py`, own semaphore, honest RAM

`h_llm` posts to `127.0.0.1:11434/api/chat` under a **dedicated `llm_sem`** (heavy renders and inference must not starve each other), clamps `num_predict ≤ 4096`, `keep_alive:-1` on the default model only.

**RAM co-tenancy (folded major):** the node already runs a headless patchright Chromium context **and** a headed CapSolver Chromium context. Pinning an 8–14B model resident competes for RAM/bandwidth with both; on a non-Max box this drives swap and degrades **both** inference and the render pillar this upgrade promised not to touch. **Fixes:** pin exactly one model; set `OLLAMA_MAX_LOADED_MODELS=1`; **do not** pass `keep_alive:-1` for non-default `model` overrides (they evict, not accumulate); document a minimum-RAM floor; measure render latency with the model resident before enabling; the split `MAC_LLM_URL` already allows moving inference to a separate box.

### 2.3 Worker client — `sux/src/mac-llm.ts`

Near-clone of `macRender` with its **own breaker** (`macLlmBreaker`, threshold 3), and a timeout **cap below the node timeout**:

```ts
export type MacLlmSpec = { system: string; user: string; max_tokens?: number; model?: string; temperature?: number; timeout_ms?: number };
export type MacLlmResult =
	| { ok: true; response: string; model: string; eval_count?: number }
	| { ok: false; error: string; slow?: boolean };

const MAC_LLM_TIMEOUT_CAP_MS = 40_000;
const MAC_LLM_BREAKER_THRESHOLD = 3;

export function macLlmConfigured(env: RtEnv): boolean { return Boolean(env.MAC_LLM_URL && env.MAC_LLM_SECRET); }
export async function macLlm(env: RtEnv, spec: MacLlmSpec): Promise<MacLlmResult>;
```

**Breaker vs slow-but-alive Ollama (folded major):** the draft's breaker only tripped on a full transport timeout/abort. But a slow-but-alive Ollama returns a `502` at ~45s (node default) *before* the worker's 50s abort, so `macBreakerOnResponse()` reset failures to 0 every call — the breaker was **dead code against the most likely failure mode**, and every strong call paid ~45s then fell back indefinitely with no protection. **Fixes, both applied:** (1) the **worker abort is set BELOW the node timeout** (`timeout_ms` default 30s, cap 40s, node timeout 45s) so a hung node actually aborts client-side and registers a failure; and (2) **non-ok/empty Responses (502) count toward the breaker** on their own threshold, tagged `slow:true` so §2.5 can distinguish node-slow from node-down.

**`eval_count` surfaced (folded minor):** `MacLlmResult` carries `eval_count` so the Worker can measure `tok/s` for §2.6 tuning (the draft discarded it).

### 2.4 `ai.ts` — `LlmOpts` with a real `timeout_ms`, escalate-then-fallback

```ts
export type LlmTier = "fast" | "strong";
export type LlmOpts = { tier?: LlmTier; model?: string; timeout_ms?: number; temperature?: number };

export async function llm(env: AiEnv, system: string, user: string, maxTokens = 1024, task = "this task", opts: LlmOpts = {}): Promise<string>;
```

**`timeout_ms`/`temperature` wired (folded major):** the draft's tuning lever ("consolidate may set 45s", "keep well under the cap") **did not exist** — `LlmOpts` was only `{tier?,model?}` and `ai.ts` passed `macLlm` no `timeout_ms`. Now `timeout_ms` (and `temperature`) are real `LlmOpts` fields threaded `llm()`→`macLlm`→spec→node Ollama `ClientTimeout` — the exact knob the multi-call blocker below needs. The Workers-AI path is byte-identical to today; the strong branch is taken only when `opts.tier === "strong" && macLlmConfigured(env)`, and on `!mac.ok` it `console.warn`s and falls through to Workers-AI.

`AiEnv` widened with `MAC_LLM_URL?`/`MAC_LLM_SECRET?`; add the same to `registry.ts` `RtEnv`.

### 2.5 The 60s deadline across MULTI-CALL fns (the blocker)

**Folded blocker:** the draft budgeted **one** strong call, but the learn-then-answer path issues **several serial strong calls in one `fn.run` under one 60s budget**. `teach` does up to 8 distill passes + 1 consolidate; a naive blanket-escalation of all of them at 15–30s each blows the `TEACH_TIME_BUDGET_MS=45_000` on the first one or two. **The per-call ≤40s cap does not compose across calls in the same fn.** Fixes:

- **Do not blanket-escalate.** `teach` distill (700 tok, per-source, high-volume) and consolidate (1800 tok) **stay fast tier**; only the **`ask` answer call** (1024 tok, once per fn.run, the reasoning-heavy step) defaults to strong. This keeps the worst case for the whole `fn.run` under ~40s with fallback headroom.
- **Callers that chain strong calls budget them under 50s:** divide the remaining `fn.run` deadline across pending strong calls and pass a tight `timeout_ms`; **fall back to Workers-AI mid-chain** when the remaining budget drops below a strong call's floor. `style`/`edit` (voice) rewrite: **cap `num_predict` for the strong path** — a 2048-tok restyle at ~20–40 tok/s is 50–100s, past every cap, so long restyles route to fast or fall back, and the design states this honestly rather than "voice always strong."

**Concurrency vs fan-out (folded major):** `batch`/`web_search` spawn many concurrent child calls; if several resolve to strong-tier they queue on `llm_sem` with no wait cap, hit the worker abort, fall back, and (now that aborts increment the breaker) sustained load trips the breaker for *everyone*. Worse, an aborted client request does not cancel the in-flight Ollama generation. **Fixes:** bound the semaphore wait (fast-fail to Workers-AI when the queue is deep rather than stalling to the abort), size `LLM_CONCURRENCY` to the box, and **treat a queue-timeout differently from node-down** so a batch burst degrades to fast tier without opening the breaker. `LLM_CONCURRENCY` is reconciled with the platform fan-out: a strong-tier call under fan-out is a best-effort optimization, never a correctness dependency.

**Degradation rungs:** unset env → no-op → Workers-AI; node down → breaker opens 30s → instant `circuit-open` → Workers-AI; cold model → loads within `timeout_ms` or falls back; empty/`{error}` → fallback. Only hard-fail: strong tier + Mac unreachable **and** `AI` unbound — the same failure today's fast tier already has.

### 2.6 Model sizing & fn-count

One warm model (`keep_alive:-1`), binary `tier` (fast=WAI-3B / strong=the one Mac model), no per-fn model routing (a switch forces a reload that blows the warm budget). Default an **8B-class Q4 instruct** (`qwen2.5:7b-instruct-q4_K_M` / `llama3.1:8b-instruct-q4_K_M`); 14B override-only on a Max/Ultra box; measure `eval_count/duration` on a real `ask` answer call before bumping. **fn-count: +0.**

---

## 3. `browse` — interactive automation on the Mac patchright node

One new fn, the top rung above `render`, driven by a **closed action-script DSL**: one `browse` call = one **ephemeral** page context opened, ≤20 verbs run sequentially, per-step results returned, context destroyed. **+1 fn** (`browse`). Reuses `MAC_RENDER_URL`/`MAC_RENDER_SECRET` — no new Worker env, no new Funnel.

### 3.1 The DSL (safety by construction)

```ts
type BrowseAction =
	| { goto: { url: string; wait_until?: "load"|"domcontentloaded"|"networkidle"; wait_ms?: number; block_resources?: boolean } }
	| { click: { selector: string; nth?: number; timeout_ms?: number } }
	| { fill: { selector: string; value: string; enter?: boolean } }
	| { fillSecret: { selector: string; ref: string; enter?: boolean } }
	| { waitFor: { selector?: string; state?: "visible"|"attached"|"hidden"; load_state?: "load"|"domcontentloaded"|"networkidle"; timeout_ms?: number } }
	| { press: { key: string; selector?: string } }
	| { select: { selector: string; value: string | string[] } }
	| { scroll: { to?: "top"|"bottom"; selector?: string; y?: number } }
	| { extract: { as?: "html"|"text"; selector?: string; attr?: string; all?: boolean; label?: string } }
	| { screenshot: { selector?: string; full_page?: boolean; label?: string } };

type BrowseArgs = { url: string; actions: BrowseAction[]; timeout_ms?: number; block_resources?: boolean; delivery?: "url"|"base64"; solve?: boolean };
```

Schema: `additionalProperties:false` throughout; `actions` `minItems:1 maxItems:20`, each item `minProperties:1 maxProperties:1`; selectors ≤400 chars, `fill.value` ≤2000, `extract all` capped 200 nodes node-side. **There is no `eval`/`script`/`evaluate`/`addScriptTag`/`route` verb** — every verb maps to a fixed Playwright locator call; the DSL cannot execute caller-supplied JS in the page. That is the load-bearing security property.

**Not `raw` (folded major):** the draft used `raw:true`, which opts out of the `MAX_OUTPUT_CHARS=1_000_000` clamp (`index.ts:242`), so a 20-step script with multiple `extract{all}` + inline base64 screenshots could return tens of MB — exactly what the clamp exists to prevent. browse's payload is structured JSON, not an opaque codec, so it does **not** need the raw exemption. **Fix:** `browse` is **non-raw and clamped**, plus the node enforces a **total-response byte cap summed across all rows** (not per-action), and screenshots egress as URLs (below), not inline.

### 3.2 Node — the fixes that make a side-effectful endpoint safe

**(a) DNS-resolved SSRF (folded blocker).** The draft's `_blocked_host` (and the Worker `isBlockedTarget`) inspect only the URL's literal host — an IP-literal + `localhost` check. A hostname with a private A record, or a DNS-rebinding host (`internal.evil.com` → `127.0.0.1`), passes **both** guards, and patchright resolves DNS itself at navigation and connects to the private address. The Mac sits inside the home LAN and runs the Obsidian REST API (`127.0.0.1:27123`) and reaches the router admin UI — browse would be a live SSRF read primitive (`goto → extract`) into those. **Fix (mirrors the residential `server.mjs` post-resolution check that `render.ts:152-153` documents):** on the node, **after navigation, resolve the actual connected IP and abort if private / loopback / link-local / CGNAT / metadata** — on the initial `goto`, on **every committed navigation** (`framenavigated`/`response`), and on **click-induced navigation** (a page linking to `http://192.168.1.1/` must not slip through). The Worker literal-host pre-check is defense-in-depth, **not** the SSRF boundary.

**(b) Screenshots disabled when a secret is in play (folded blocker).** Credential redaction is text-only (`str.replace → •••` over extract/screenshot **text** bodies); a screenshot is base64 PNG **pixels** the redaction pass cannot touch, and many login pages reflect the typed value or have a reveal toggle. **Fix:** the pixel channel is treated as un-redactable — **no `screenshot` is allowed on a page after a `fillSecret` in the same session** (equivalently, refuse `screenshot` when any `REDACT` value is present in the DOM, or blank/blur secret-filled fields before shooting). Vaulted secrets and screenshots are mutually exclusive on a call.

**(c) Submit-blocking at the navigation layer, not the verb flag (folded major).** The `allow_submit:false` guard covered only `fillSecret`'s own `enter` flag, but `press{key:"Enter"}` and `click{submit}` bypass it, and "will a later click submit?" is undecidable per-verb. **Fix:** after a `fillSecret` with `allow_submit:false`, **block any form submission / same-frame navigation for the rest of the session at the network/navigation layer** (intercept the request), not by trying to detect submit intent per verb.

**(d) Checkout/payment must cover the click (folded major).** Placing an order is almost always a `click` on "Place order"/"Buy now" — frequently an in-page XHR with no URL change and no form submit — so a URL-path regex on `goto`/`enter` misses the primary purchase action (and false-positives on `/payments-faq`). **Fix:** gate at the interaction layer — **block clicks on elements whose text/aria matches buy/pay/order** unless `BROWSE_ALLOW_SENSITIVE=1`, **and block outbound requests to known payment endpoints** — and the docs state this is **best-effort**, not an absolute guarantee.

**(e) HMAC freshness / replay (folded major).** `/browse` is now side-effectful (login, click, submit), but the reused HMAC never checks `ts` freshness — a captured signed URL is replayable indefinitely. **Fix:** `_authorized` rejects `|now - ts| > 60s` (shared with §2.1); consider a **separate secret for `/browse`** so a leaked render secret does not grant credentialed interactive control.

**(f) Ephemeral profile (folded major).** `ctx`/`solver_ctx` are `launch_persistent_context` with on-disk `user_data_dir` — cookies/localStorage/logins persist across every request, so a login by one call leaks an authenticated session to the next caller, and a script can `goto` an already-logged-in site and `extract` account data / a saved password that was never in the `REDACT` set. **Fix:** browse runs in a **fresh non-persistent context per call** (or explicitly clears cookies/storage per call). "One page per request" was page-level isolation only; the design is now genuinely stateless.

**(g) Own semaphore (folded major).** `do_render` uses the shared `sem`, and `walmart`/`homedepot` depend on `render backend:mac`. A browse script holds a `sem` slot for the **entire** script (up to 50s) vs a one-shot render's seconds; `solver_sem` is size 1, so one `browse{solve:true}` monopolizes the only headed solver for up to 50s and blocks every Akamai/PerimeterX escalation. **Fix:** browse gets its **own semaphore** (and a much smaller cap for `solve`), separate from render's `sem`/`solver_sem` — long interactive scripts can never starve one-shot retailer traffic.

### 3.3 Worker client + fn + composition metering

`macBrowse()` in `mac-render.ts`: near-clone of `macRender`, **own `browseBreaker`**, returns the parsed `BrowseResponse`. `sux/src/fns/browse.ts`: `cost:8`, `cacheable:false` (side-effectful — never cache an interaction), **non-`raw`**. `run` does a Worker-side `isBlockedTarget` pre-check on `url` + every `goto.url`, maps `{ok:false}`→`failWith`, and delivers `screenshot` rows through `deliverBytes(... "url" ...)` → content-addressed `/s/<uuid>` URLs (feeds `ocr`/`render` downstream).

**Rate-limit under composition (folded major):** `weightedRateLimit` charges only at top-level `tools/call` (`rate-limit.ts:28`); `batch.ts`/`pipe.ts` call `target.run()` directly, bypassing the limiter — so one `batch` could fan N residential/headed browser sessions (each holding a scarce Mac slot up to 50s) at **zero** `cost:8` charge. **Fix:** the node **bounds the number of concurrent browse sessions it accepts regardless of caller** (the hard backstop), and `batch`/`pipe` **cap browse fan-out** / charge nested cost through the limiter. The docs do **not** advertise unbounded batch-fanned browse.

### 3.4 The 60s deadline — a fixed serialization margin

**Folded major:** the draft let one `timeout_ms` knob set both the node budget and the worker abort, so at `timeout_ms=50000` the margin collapsed to ~2s — too little to serialize partial results (incl. base64) and cross the DERP relay, so the worker abort fired and **all partial results were discarded** — the exact outcome partial-return claims to prevent. **Fix:** the two bounds are **decoupled** — node budget hard-capped at **44_000ms**, worker abort at **52_000ms**, a **fixed 8s** serialization/relay margin independent of the caller's `timeout_ms`; `withDeadline` at 60s is the untouched hard wall. When the node budget exhausts it stops, sets `truncated:true`, and returns HTTP 200 with results-so-far (the dominant path); a hung node trips `browseBreaker` and subsequent calls fast-fail `circuit-open`.

### 3.5 Ladder & fn-count

Ladder: `scrape` → `render backend:cf` → `render backend:mac` (one-shot `goto→extract`, cacheable) → **`browse`** (drives the page). Reach for browse **only** when the data needs interaction (content behind a search box/form, pagination behind a button, infinite scroll, tab-gated content, a login wall). browse does **not** absorb `render` (render keeps the cheap cacheable cf path). **fn-count: +1.**

---

## 4. Cloudflare Workflows — durable execution for the genuinely-unbounded jobs

Workflows is the right fix for exactly three job shapes that are *inherently* longer than 60s AND *must* complete server-side: **whole-site teach** (`teach` over N URLs), **deep crawl** (BFS over many pages), **shop all-retailers** (`shop store:"*"`, serialized on the concurrency-1 mac solver). It is the **wrong** fix for the 80% case — `batch` and single-shot fns that merely *sometimes* brush 60s get disciplined partial-return (§4.6). **+0 additional fns** — the handle surface is the unified `job` fn (D3); long behaviors fold into existing verbs as modes (`teach mode:"site"`, `crawl` deep, `shop store:"*"`).

The decisive reason to adopt Workflows over `singleFlight` + `ctx.waitUntil`: **a Workflow instance gives cross-isolate single-execution and durable per-step retry**, which the per-isolate `singleFlight` Map and non-durable, request-lifetime-bound `waitUntil` structurally cannot.

### 4.1 Plan honesty & binding

**Availability: yes, no plan upgrade.** Workflows is GA; sux is already on Workers Paid (it binds Browser Rendering, R2, and an `unsafe` ratelimit — all Paid features, `wrangler.jsonc:14,17,25-27`). The honest caveat: Workflows limits still evolve; fine for a single-user server. Verify the account before shipping the cycle that first calls `create()`.

```jsonc
"workflows": [{ "name": "sux-jobs", "binding": "WORKFLOWS", "class_name": "SuxWorkflow" }]
```

Each Workflow **step** is its own invocation with its own CPU budget, so no `limits.cpu_ms` raise is needed. `index.ts` exports `export { SuxWorkflow } from "./workflow";`. `RtEnv` gains an optional `WORKFLOWS?` binding (mirrors the `AI?`/`BROWSER?`/`MAC_RENDER_*?` optional-binding pattern) so dev/test degrade gracefully: a long fn with `!env.WORKFLOWS` falls back to the synchronous bounded partial-return path, never throws.

**RESERVED (folded minor):** the draft added `"sux:job:"` to `RESERVED` in `kv_put.ts`, but `RESERVED` already contains `"sux:"` wholesale — the edit is a no-op. Dropped; `sux:` already partitions the keyspace, and there is no collision with `cache:` (response cache), `sux:kb:` (teach/ask), or `sux:watch:` — the wholesale `sux:` reservation equally covers the schedule keyspace `sux:sched:` (§1.3/D10), the pointer `sux:jobidx:`, and the tombstone `sux:jobtomb:` (§4.2).

### 4.2 Enqueue-and-poll — `sux/src/jobs.ts`

MCP `tools/call` is synchronous and 60s-capped, so a long job **cannot** hang the call: the long fn returns a handle in <1s, the Workflow runs in the background, the caller polls `job op:"get"`.

```ts
export function jobId(fn: string, args: unknown, disc?: string): Promise<string>;   // ASYNC — see below; for source:"cron" disc = `${scheduleId ?? "-"}:${tickBucket}` so scheduleId + fire-bucket discriminate (§4.2)
export async function enqueueJob(env: RtEnv, source: JobSource, kind: string, fn: string, args: Record<string, unknown>, notify?: { on: "change" | "always" | "error" | "complete"; title?: string; priority?: number }, tickBucket?: string, scheduleId?: string): Promise<JobRecord>;
```

**`jobId` async (folded blocker):** the draft called `sha256HexSync(...)` + `stableStringify(...)`, but **neither exists usably** — the repo has only an async `sha256Hex` (`_util.ts`), `stableStringify` is **private** in `mcp-util.ts:65`, and a synchronous SHA-256 is impossible in Workers (`crypto.subtle.digest` is async). **Fix:** `jobId` is **async** and awaited in `enqueueJob`; it uses the existing `sha256Hex(new TextEncoder().encode(...))`; `stableStringify` is **exported** from `mcp-util.ts` (or a canonical serializer inlined). Every caller awaits.

```ts
export async function enqueueJob(env, source, kind, fn, args, notify, tickBucket, scheduleId) {
	const baseId = await jobId(fn, args, source === "cron" ? `${scheduleId ?? "-"}:${tickBucket}` : undefined);
	const existing = await readJob(env, baseId);
	if (existing && existing.status !== "errored" && existing.status !== "canceled") return existing;
	const attempt = (existing?.attempt ?? 0) + 1;
	const instanceId = `${baseId}-a${attempt}`;
	const rec: JobRecord = { id: baseId, source, kind, status: "queued", created: Date.now(), updated: Date.now(), pollAfterMs: 5000, attempt, notify, scheduleId };
	await writeJob(env, rec);
	try {
		await env.WORKFLOWS!.create({ id: instanceId, params: { fn, jobId: baseId, args, created: rec.created, source, kind, notify, scheduleId } });
	} catch (e: any) {
		const inst = await env.WORKFLOWS!.get(instanceId).catch(() => null);
		if (!inst) { rec.status = "errored"; rec.last_error = String(e?.message ?? e); await writeJob(env, rec); }
	}
	return rec;
}
```

**Deterministic dedup via the pointer (folded blocker):** `readJob(env, baseId)` resolves the content-hash `baseId` through the deterministic pointer `sux:jobidx:<baseId>` (§1.5) — **no timestamp component** — so every re-enqueue of the same `(fn,args)` finds the live record and returns the existing handle instead of spawning a duplicate Workflow. The chronological `sux:job:<invertedTs>:<id>` storage key (§4.3) never enters the dedup path; only the pointer does. `writeJob(rec)` writes both the primary record (under the ts-prefixed key) and the pointer, so `list` sees it newest-first and `get`/dedup resolve it by bare id.

**Content-hash dedup is intra-lifetime idempotency, NOT a recurrence suppressor (folded blocker):** the timestamp-free `baseId` is deliberately time-invariant so an interactive poller re-hitting `enqueueJob(fn,args)` mid-flight coalesces onto the one live handle — but that same property is fatal to a *recurring* cron enqueue, and the D10 fix that gives terminal records a 7d TTL is precisely what keeps the dedup target alive to swallow every intra-week recurrence. The line-446 guard returns any `existing` whose status is not `errored`/`canceled` — i.e. a **`complete`** record too — and D10 retains a terminal `complete` under `JOB_RESULT_TTL=7d`. So a nightly `enqueueJob(env, "cron", …, "shop", {store:"*"})` with an identical `(fn,args)` computes the same `baseId` every night; night 1 creates→runs→`complete`, and nights 2–7 resolve the still-live 7d `complete` record through the pointer, hit the guard, and return it **without a fresh `WORKFLOWS.create()`** — and since `finishNotify` fires only inside `SuxWorkflow.run()` (§4.4), the dedup-return path delivers no notify either. The flagship nightly refresh would fire once and serve a 7d-stale cached result six nights running — the exact "results rot" §4.5 claims to close. **Fix — carve the cron path out of content-hash dedup, on two counts:** (1) `source` is a **real `enqueueJob` parameter** (above), replacing the draft's hardcoded `source:"workflow"` at the record and in the `create()` `params` — so a cron enqueue is genuinely `source:"cron"` and reaches the D10 keyspace/TTL routing as `cron`, not mis-routed to the terminal keyspace as a workflow; and (2) for `source:"cron"` both the enqueue's `scheduleId` (or its absence) **and** the scheduled fire bucket enter the id — ``baseId = await jobId(fn, args, source === "cron" ? `${scheduleId ?? "-"}:${tickBucket}` : undefined)``, where `scheduleId` is the parent `sux:sched:` id for a durable-dispatched schedule fire or `"-"` for a schedule-less fire-and-forget cron enqueue, and `tickBucket` is the cron's scheduled **calendar date** for `daily` and scheduled **hour** for `hourly` (computed by the cron branch from `event.scheduledTime` + cadence, §1.5) — so each night's enqueue is a **distinct** id that MISSES the prior night's retained `complete` record and spawns a fresh Workflow + `finishNotify`, while a same-tick retry of the **same** schedule (two overlapping heartbeats sharing `scheduleId`+`tickBucket`) still dedups within that bucket. Equivalently/additionally, the line-446 guard may treat a `complete` record older than the job's cadence as re-runnable (a completed `daily` job >~20h old re-runs). **Folding `scheduleId` into the key is what keeps two distinct-intent `source:"cron"` enqueues on the identical `(fn,args,tickBucket)` from silently coalescing.** `source` alone cannot separate them — both are `source:"cron"`: the doc's own canonical pair is (a) the standalone nightly cron `enqueueJob(env,"cron",…,"shop",{store:"*"})` (§4.5, `scheduleId="-"`, `finishNotify` finalizer) and (b) the durable-dispatched daily-`shop store:"*"` watch escalation `enqueueJob(env,"cron",…,"shop",{store:"*"},undefined,tickBucket,j.id)` (§1.5, `scheduleId=j.id`, `gateBackToSchedule` finalizer). Both compute `tickBucket = today's date` for a `daily` cadence, so without `scheduleId` in the id they hit a byte-identical `baseId`, dedup onto **one** Workflow, and whichever fires first in the nondeterministic drain imposes its finalizer on the other — if the standalone cron wins, the escalation dedups onto a `scheduleId:undefined` record → `finishNotify` runs instead of `gateBackToSchedule`, the schedule's change gate never runs, its `last_hash`/`last_snapshot` never advance, and `notify.on:"change"` never fires (the flagship watch silently inert, its baseline frozen); if the watch escalation wins, the standalone cron dedups onto a `notify:undefined`+`scheduleId` record → `finishNotify` never fires and the nightly re-shop result rots unnotified (the §4.5 failure). Keying the cron dedup on `(source, scheduleId ?? "-", fn, args, tickBucket)` mints them as **separate** Workflows, each keeping its own finalizer and notify spec; two different daily watches on the same `shop store:"*"` (one `notify.on:"change"`, one `semantic:true`) likewise get distinct `scheduleId` → distinct Workflows and distinct gates. `source:"workflow"`/`source:"schedule"` keep the timestamp-free `baseId` — their idempotency is per-lifetime, not per-recurrence, exactly as the interactive poll model requires.

**Attempt nonce (folded blocker):** a deterministic instance-id **defeats the retry it claims to enable** — CF `create()` rejects *any* previously-used instanceId (completed, errored, terminated are all retained), so re-enqueuing an `errored`/`canceled` job hits "already exists", the catch swallows it as success, and a `queued` record is written that **no workflow ever runs** — stuck `queued` forever. **Fix:** the CF `instanceId` carries a **monotonic `attempt` suffix** (`${baseId}-a${attempt}`) while the `JobRecord` key stays stable (`baseId`), so a retry mints a fresh instance; and the swallowed-"already exists" branch **verifies via `WORKFLOWS.get`** that an instance is actually running before returning a handle, marking the record `errored` (not `queued`) if it is terminal/absent.

**What a long fn returns:** long fns stay `cacheable:false` so the handle passes through:

```ts
if (!env.WORKFLOWS) return runSynchronousBounded(env, args);   // graceful degrade → partial-return
const rec = await enqueueJob(env, "workflow", "teach", "teach", { ...args, mode: "site" }, { on: "complete" });
return ok(JSON.stringify({ job_id: rec.id, created: rec.created, status: rec.status, kind: rec.kind, poll: `job action:"get" id:"${rec.id}" created:${rec.created}`, poll_after_ms: rec.pollAfterMs }));
```

**Threading the finalizer (folded major):** the long-fn return path attaches the caller's intended finalizer as the sixth `enqueueJob` argument (`{ on: "complete" }` above, after the explicit `source`) so the `notify` spec rides the `JobRecord` all the way to `finishNotify` (§4.5). Without this, every `source:"workflow"`/`source:"cron"` record would reach `finishNotify` with `notify: undefined`, nothing would be delivered, and a completed nightly re-teach/deep-crawl/shop-all job would expire at its `JOB_RESULT_TTL` (7d, §1.3/§1.5) unseen — the exact "results rot with no poller" failure §4.5 exists to close. Interactive foreground callers may omit `notify` (they poll `job op:"get"` themselves); the argument exists for the pollerless paths (cron, fire-and-forget). `enqueueJob` **rejects a durable `notify.on:"change"`** (D11/§1.5) — a `source:"workflow"`/`"cron"` job has no change detection and `finishNotify` can never fire `change`, so the only meaningful durable values are `complete`/`error`/`always`.

**KV eventual consistency (folded major):** KV is eventually consistent (cross-PoP up to ~60s), so the first `job op:"get"` can legitimately read `null` for a job that exists and every `progress`/`partial` write lags — undermining the "partial-return while running" feature. The naïve fix — "a null read within the first ~60s of `created` is `provisioning`" — is **unimplementable as stated**: on a null read there is no `JobRecord`, so `created` (which lives *inside* the record) is unreadable, and the `id` is a bare content hash with **no time component** (the load-bearing property of §4.2 dedup and the §4.3 pointer, both equally null in the window). The reader has zero time anchor on the exact null-read case the guard exists to classify, so it cannot distinguish an in-flight job's first 60s from a silently-GC'd 7d record (KV expiry is silent — past `JOB_RESULT_TTL` the primary AND pointer both read null, indistinguishable from a fresh enqueue) or a hallucinated/typo'd `job_id`. A degenerate default breaks a load-bearing behavior either way: "null → always `provisioning`" makes an expired workflow/cron result poll `provisioning` forever and a hallucinated id never terminate (the exact "results rot / no terminal signal" failure this layer exists to kill); "null → `not_found`" reintroduces the cross-PoP race this guard was written to kill (a genuinely in-flight job reads `not_found` in its first 60s). This is the **reader** gap that no prior fix closed: §4.4 hardened the *writer* (`mark` seeds the header from `event.payload`, which carries `created`), but the reader's provisioning decision was only asserted, never given a time anchor. **Fix — give the reader an independent time anchor from the handle it already holds, never from the unreadable record:**

- **Echo `created` in the handle and back on `get`.** `enqueueJob`/`create` return `created` alongside `job_id`/`poll_after_ms` (§1.3, §4.2 handle); the `get` schema carries an optional `created` (or an opaque `poll_token` wrapping it). A poller *always* holds the handle it is polling, so echoing the anchor is free. `get` classifies a null read from the **echoed** value: echoed `created` **younger than ~60s** → `provisioning`; echoed `created` **older than `JOB_RESULT_TTL` (7d)** → `gone`/`expired` (the record GC'd, §1.3/D10), never an eternal `provisioning`.
- **A bare-id `get` with no echoed anchor is `unknown`, never silently `provisioning`.** With no time anchor the reader cannot classify a null read, so it returns a distinct `unknown` status (neither `provisioning` nor `not_found`) with schema guidance that the caller should trust the handle's `poll_after_ms` and stop after a bounded number of polls — so a hallucinated/typo'd `job_id` cannot masquerade as a job that is forever `provisioning`, and a caller that discarded its handle degrades to a bounded poll rather than an infinite one.
- **Post-expiry gaps resolve to `gone`, not `provisioning`.** The echoed-`created` age check (above) covers the common path cheaply; as a bare-id backstop the **terminal write also stamps a short-lived `sux:jobtomb:<id>` tombstone** (covered by the wholesale `sux:` `RESERVED` prefix, §4.1) whose TTL **outlives** the record's `JOB_RESULT_TTL`, so a null primary read whose tombstone is present resolves to `gone` even without an echoed anchor. Either mechanism suffices; the echoed anchor is primary, the tombstone the anchorless backstop.

`pollAfterMs` is set **above** the propagation floor (5s); the docs flag a Durable Object as the escalation if strong-consistency of status transitions is ever required (the codebase's own recommended escalation for KV correctness). **The reader/writer symmetry, stated precisely:** both sides recover the record header from an **out-of-band durable anchor**, not the KV record — the **writer** (`mark`, §4.4) from the durable `event.payload` (which replays `created`/`source`/`notify` every step), the **reader** (`job op:"get"`) from the **echoed handle timestamp**. Neither side may materialize a canonical `JobRecord`, nor a `provisioning`-vs-`gone` classification, from a bare time-free `id`; a null read is `provisioning` only against a durable anchor, `gone` past the TTL, and `unknown` when no anchor is available. The **finalizer** (`finishNotify`, §1.5/§4.4) is deliberately off the KV read path entirely — it is handed the in-memory terminal record `mark` just wrote, so it recovers `notify`/`status`/`result` from a durable in-request object, never re-materializing the header from a bare id through the very cross-PoP/read-cache window this symmetry was built to close.

### 4.3 `job` list/get/cancel semantics (ordering + race fixes)

**`listJobs` sort-before-truncate (folded major) — terminal history only:** schedules are enumerated **completely** from the disjoint `sux:sched:` prefix via `listSchedules` (below, §1.3/D10); this paragraph governs only the paginated terminal `workflow`/`cron` keyspace. The draft broke the loop at `out.length >= limit` and sorted **after** slicing — but KV enumerates keys lexicographically and ids are sha-derived (random), so the first `limit` keys are an arbitrary subset that sorting cannot make "newest." With a `status` filter it also `KV.get`s every walked key (billed) and truncates past 1000. **Fix:** **encode a time component in the storage key** — `sux:job:<invertedTimestamp>:<id>` — so KV lexicographic order **is** chronological (newest-first via inverted ts); read a bounded page, then sort-then-slice; cap the number of `KV.get`s and paginate the cursor. The bare content-hash `id` stays O(1)-addressable via the `sux:jobidx:<id>` pointer (§1.5) — dedup (§4.2), `action:"get"`, `delete`, and `runJob` writeback each resolve an id in one extra `KV.get` without a list scan — so the time-ordered key and the deterministic id lookup no longer contradict. The `invertedTs` derives from the immutable `created` (§1.5), so a record keeps one stable key across every status transition.

**Live schedules surface via complete enumeration, not a page reorder (folded blocker):** because `source:"workflow"`/`"cron"` terminal records GC only after `JOB_RESULT_TTL=7d` (§1.3) while `source:"schedule"` records are durable and live in a **disjoint** `sux:sched:` keyspace (§1.3/D10), a naïve newest-first page over a commingled space would not merely mis-order schedules — it would **never contain** a schedule that has sunk past the bounded `KV.get` window under enough terminal volume, and sorting a page that lacks the record cannot surface it (the D10 completeness failure — distinct from the ordering failure this section's other fixes address). **Fix:** the default `list` (no `status` filter) **fully enumerates `sux:sched:` via `listSchedules`** (complete, ≤`MAX_JOBS=100`, one cheap prefix list) and merges those records — `source:"schedule"` (enabled+disabled) first — **ahead of a bounded newest-first page of terminal `sux:job:` history** (`listJobs`), then slices the terminal tail to `limit`. Active schedules are surfaced by enumeration, never by reordering a page that might never have held them; only terminal history is subject to the cost-capped page window. A `status` filter narrows within that order (in-memory over the small schedule set, paged over terminal). **This resolves the §4.3-vs-§1.5/§1.4 tension:** schedule enumeration is complete over a bounded prefix; the "cap the `KV.gets` / bounded page" cost control applies to terminal history alone.

**`cancel` cooperative (folded major):** `cancel` writes `status:"canceled"` then best-effort `terminate()`, but a running `SuxWorkflow` does read-modify-write on the same key after every step — the next `progress`/`complete` write **clobbers `canceled`** (the `metrics.ts:1-4` RMW-loss), and a swallowed `terminate()` failure lets the workflow finish `complete`, silently overriding the cancel. **Fix:** each runner/`mark` **re-reads and aborts if `status === "canceled"`** (cooperative cancellation) and **refuses to overwrite a terminal status**; a failed `terminate()` is surfaced as a hard error to the caller, not swallowed.

### 4.4 `SuxWorkflow` — static dispatch, no template-literal import

**Static registry map (folded blocker):** the draft dispatched via `await import(\`./jobs/${fn}.ts\`)` — a variable-path dynamic import **with a `.ts` extension**. Wrangler/esbuild cannot statically analyze a variable specifier, Workers have no runtime filesystem, and every working dynamic import in this repo uses a **static string literal** — the runner modules would never bundle → runtime "module not found" for every job. **Fix — a static dispatch map with static specifiers and no `.ts`:**

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readJob, writeJob, finishNotify, gateBackToSchedule, type JobRecord, type JobSource } from "./jobs";
import type { RtEnv } from "./registry";

const RUNNERS: Record<string, () => Promise<{ runJob: (env: RtEnv, step: WorkflowStep, args: Record<string, unknown>, mark: (p: Partial<JobRecord>) => Promise<void>) => Promise<ToolResult> }>> = {
	crawl: () => import("./jobs/crawl"),
	teach: () => import("./jobs/teach"),
	shop: () => import("./jobs/shop"),
};

export type JobParams = { fn: string; jobId: string; args: Record<string, unknown>; created: number; source: JobSource; kind: string; notify?: JobRecord["notify"]; scheduleId?: string };

function seedFromPayload(p: JobParams): JobRecord {
	return { id: p.jobId, source: p.source, kind: p.kind, created: p.created, updated: p.created, status: "queued", notify: p.notify, args: p.args, scheduleId: p.scheduleId };
}

export class SuxWorkflow extends WorkflowEntrypoint<RtEnv, JobParams> {
	async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<void> {
		const { fn, jobId, args } = event.payload;
		const base = (await readJob(this.env, jobId)) ?? seedFromPayload(event.payload);
		const mark = async (patch: Partial<JobRecord>): Promise<JobRecord> => {
			const latest = await readJob(this.env, jobId);
			if ((latest ?? base).status === "canceled") throw new Error("job canceled");
			const merged = { ...base, ...latest, ...patch };
			await writeJob(this.env, merged);
			return merged;
		};
		try {
			await mark({ status: "running" });
			const entry = RUNNERS[fn];
			if (!entry) throw new Error(`no runner for '${fn}'`);
			const result = await (await entry()).runJob(this.env, step, args, mark);
			const done = await mark({ status: "complete", result, progress: undefined });
			done.scheduleId ? await gateBackToSchedule(this.env, done) : await finishNotify(this.env, done);
		} catch (e: any) {
			const failed = await mark({ status: "errored", last_error: String(e?.message ?? e) });
			failed.scheduleId ? await gateBackToSchedule(this.env, failed) : await finishNotify(this.env, failed);
		}
	}
}
```

**Payload-seeded record header (folded blocker):** `mark` is the sole writer inside the Workflow, and its first call — `mark({ status: "running" })`, fired within seconds of `create()` — lands squarely inside §4.2's cross-PoP KV window where `readJob` can legitimately return `null` for a job that provably exists (`enqueueJob` does `writeJob(rec)` *then* `WORKFLOWS.create()`, so the first `mark` races the enqueue's put on a PoP that may not yet see it). The draft reconstructed a bare `{ id: jobId }` stub on that null read and wrote it, clobbering the canonical enqueue record: `notify` lost (→ `finishNotify` reads `undefined` and delivers nothing, resurrecting the §4.5 "results rot with no poller" failure round-2 exists to close), `created` lost (→ `writeJob` derives the §4.3 `sux:job:<invertedTs>:<id>` primary key from `undefined` → a garbage second key, repointing `sux:jobidx:<id>` at it and defeating both newest-first ordering and §4.2 pointer dedup), `source` lost (→ the §1.3/D10 `(source,status)` → `expirationTtl` derivation misfires) — all **silent corruption** (`writeJob` stringifies to a garbage key rather than throwing), not a retryable step failure, and `mark` sat OUTSIDE the try so even a throw would not route to the errored+`finishNotify` path. **Fix:** the immutable header rides the durable payload, not KV. `enqueueJob` sets `params: { fn, jobId, args, created, source, kind, notify }` at `create()` time (so it lives in `event.payload`, replayed on every step regardless of KV lag); `run()` builds `const base = (await readJob(...)) ?? seedFromPayload(event.payload)`; `mark(patch)` writes `{ ...base, ...latest, ...patch }` — a null KV read can never drop `created`/`source`/`notify`, so the primary key stays stable (derived from the payload `created`), the TTL derives from the payload `source`, and `notify` survives to `finishNotify`. `mark({ status: "running" })` moves **inside the try** so a genuine failure routes to errored+`finishNotify` rather than an uncaught throw. This is the writer half of §4.2's reader/writer symmetry: **both sides recover the header from an out-of-band durable anchor, not the KV record** — the writer from `event.payload`, the reader from the echoed handle `created` — and neither may materialize a canonical `JobRecord` (nor a `provisioning`-vs-`gone` classification) from a bare time-free `id`; a bare-id null read is `provisioning` only against a durable anchor, `unknown` without one (§4.2).

Each `./jobs/<fn>.ts` runner expresses work as `step.do(...)` units so CF persists+retries per step; `teach mode:"site"` makes each URL one durable step with the `_kb` KB in KV as the natural checkpoint. **SSRF in runners (folded minor):** every runner fetches **exclusively via `smartFetch` / the `render` fn (never raw `fetch`)** and re-runs `isBlockedTarget` on **every** URL derived from fetched page content (sitemap entries, crawl frontier, site-teach enumerator) — the frontier is attacker-influenceable.

**60s handling is the whole point:** the Workflow is **not** wrapped in `withDeadline`. Only `enqueueJob` (create + one KV put) is on the synchronous path (<1s). Steps run for minutes; per-step retries are independent; the abandon-the-promise problem (`index.ts:52`) does not apply — there is no racing timeout.

### 4.5 Cron-enqueued jobs get a finalizer (this is where notify + Workflows compose)

**Folded major:** routing heavy nightly jobs through `enqueueJob(source:"cron")` gives them durability but **no poller** — a cron enqueue has no client calling `job op:"get"`, so a completed "re-teach nightly" job just expires at the TTL, unseen (the codebase has zero user-notification egress today). **Fix:** the finalizer config threads through the durable path — `enqueueJob`'s sixth `notify` argument (§4.2, after the explicit `source`) sets `rec.notify`, so the `SuxWorkflow` completion path's **`finishNotify` → `sendNotify` (§1.1)** call (fired on both `complete` and `errored`, §4.4) is handed the **in-memory terminal `JobRecord`** `mark` just wrote (never a KV re-read, §1.5/§4.2) carrying a **populated `notify`** and delivers whenever `notify.on` is satisfied — the **durable rows** of the §1.5 mapping table (`complete` → `on:"complete"|"always"`, `errored` → `on:"error"|"always"`). `finishNotify` never handles a `source:"schedule"` record; those notify inline via `runJob` step 5 (§1.5), which is why a durable enqueue rejects `on:"change"` at §4.2 (it can never fire here). The proactive layer's egress **is** the missing finalizer, and the intro's compose-the-loop thesis now has a signature to carry it. **Recurrence, not just delivery (§4.2 carve-out):** delivery is only half the compose story — a nightly cron enqueue reuses an identical `(fn,args)`, and the terminal `complete` record is retained 7d (D10), so bare content-hash dedup would resolve night 1's still-live record on nights 2–7, hit the line-446 guard, and return it with **no fresh `WORKFLOWS.create()` and no `finishNotify`** — the job fires once and serves a 7d-stale result six nights running, the very rot this section exists to close. The cron branch therefore enqueues with `source:"cron"` (a **real `enqueueJob` parameter**, never the hardcoded `"workflow"` the draft used, §4.2/D3) and re-mints `baseId` per fire from `(scheduleId ?? "-", tickBucket)` (bucket = calendar date for `daily`, hour for `hourly`, from `event.scheduledTime`; `scheduleId="-"` for this schedule-less fire-and-forget path), so each night's id misses the prior night's retained record and actually spawns a fresh Workflow — and, because `scheduleId` is in the key, this standalone nightly enqueue also never collides with a durable-dispatched watch escalation (§1.5, `scheduleId=j.id`) sharing the identical `(fn,args,tickBucket)`, so the two keep their separate finalizers (`finishNotify` here vs `gateBackToSchedule` there). Content-hash dedup stays the intra-lifetime idempotency guard for the interactive poll model — never a recurrence suppressor. Cron jobs must therefore enqueue with `notify.on:"complete"|"error"` to deliver a result; a cron job enqueued with **no `notify`** is the explicit **state-mutation-only, nothing-to-deliver** case (e.g. refreshing `_kb`) — `finishNotify` reads `notify: undefined` and correctly sends nothing. **The durable-dispatched *schedule* (§1.4/§1.5) is the third variant of a no-`notify` cron enqueue:** it too rides with `notify: undefined`, but it carries a `scheduleId` back-reference to its `sux:sched:<id>` parent, and the completion path branches on it — a terminal record **with** `scheduleId` does **not** call `finishNotify` (whose `complete`/`error`/`always` vocabulary cannot express the schedule's `change` gate); instead it feeds the fresh `result` back through the **schedule change gate** (declutter→hash vs the parent's `last_hash`/`last_snapshot`, then the *schedule* rows of the §1.5 mapping) and writes `last_run`/`last_hash`/`last_snapshot` back onto the `sux:sched:` record. **The same terminal writeback clears the in-flight latch** `inflight_since` set at escalation (§1.3/§1.5) — on both `complete` and `errored`, refusing to regress a newer value — so the schedule is unlatched for its next period yet can never have overlapped its own prior fire. This is what lets a heavy nightly `shop store:"*"` watch enrolled with `notify.on:"change"` (§1.4 flagship) run durably yet still fire only on an actual change, and never accumulate overlapping Workflows when its wall-time exceeds a short cadence — the durable path supplies the compute, the schedule keeps the gate, the latch keeps fires non-overlapping.

### 4.6 `batch` partial-return — the cheap 80% win that ships first

Independent of all Workflow infra: make `batch` checkpoint against a soft deadline and return completed items instead of discarding everything at 60s.

**Folded minor (contract + implementation):** `batch` is `raw` and today **reduces** successful results into one value that composers (`pipe`, nested `batch`) consume; switching the timeout case to a `{results, pending, complete}` envelope is a **breaking output-shape change** for those callers, and the draft's `waves`/`remaining(wave)` don't exist — the real `batch` uses a `pool()`-based concurrency model (`batch.ts:17`, `CONCURRENCY=8`), not discrete waves. **Fixes:** the partial envelope is **opt-in / distinguishable** so reducers never silently receive the wrong shape, and the soft-deadline checkpoint is written against the **actual `pool()` scheduler** (track completed vs not-yet-scheduled items at `SOFT_DEADLINE_MS=55_000`), not a nonexistent wave loop. No new binding, no durability engine — ships in cycle 1 ahead of the Workflows infra.

### 4.7 Cost & fn-count

**Backpressure honesty (folded minor):** charging the weighted limiter only at enqueue is **not** "metered once = correct" — one `shop store:"*"` admission fans into ~8 serialized mac-render solves (minutes of node work) at `cost:1`, removing the per-render backpressure that protects the single solver. **Fix:** weight the enqueue charge by expected fan-out (retailer/step count), or charge per-step against the limiter, so metered cost tracks real serialized node load. **Not just batch fan-out saturates the concurrency-1 solver (folded major):** a `durable:true` schedule (§1.4) whose durable fire outlasts its cadence would, absent the in-flight latch (§1.3/§1.5), re-fire every tick and pile overlapping Workflows onto `solver_sem` (size 1) — an unbounded live-instance leak and serialized backlog that defeats the same single-solver backpressure this section protects. The latch (skip-if-`inflight_since`-live, cleared by `gateBackToSchedule`) is what keeps a heavy recurring schedule from overlapping itself; enqueue-charge weighting bounds *distinct* admissions, the latch bounds *self-overlap*. **fn-count: +0 additional** (`job` is D3's unified fn).

---

## 5. `entity` — shared cross-source identity resolution

A pure shared module `sux/src/fns/_entity.ts` (the substance) + a thin, **non-raw** `entity` fn (a bonus agent surface). Identity resolution is CPU-only compute over already-fetched records, so it belongs inline in the caller's 60s budget sharing the caller's in-memory records, sharing the algebra `records[]` contract and the shop model-key extractor. `shop`'s `_compare` and `teach`'s dedup are the **intended** consumers — but adoption is an OFFER this doc makes, not a contract those docs co-sign (they define their own resolution today, §5.3); `entity` ships standalone regardless. **+1 fn** (`entity`); `_entity.ts`/`_compare.ts` are unregistered modules.

### 5.1 `_entity.ts` — tiered pipeline over union-find with blocking

```ts
export type EntityType = "product" | "source" | "place" | "person";
export interface EntityRecord { type: EntityType; id?: string; title?: string; brand?: string; url?: string; ids?: Record<string,string>; text?: string; source?: string; raw?: unknown; }
export interface EntityCluster { key: string; type: EntityType; tier: "exact"|"structured"|"fuzzy"|"embed"; confidence: number; members: EntityRecord[]; canonical: EntityRecord; }
export interface ResolveOpts { strategy?: "exact"|"structured"|"fuzzy"|"embed"; threshold?: number; embed?: boolean; }

export function resolve(records: EntityRecord[], opts?: ResolveOpts): EntityCluster[];
export async function resolveWithEmbeddings(env: AiEnv, records: EntityRecord[], opts?: ResolveOpts): Promise<EntityCluster[]>;
export function canonicalKey(r: EntityRecord): string | null;
export function canonicalUrl(u: string): string;
export function normModel(title: string, brand?: string): string | null;
export function isGtin(s: string): boolean;
export function tokenSet(s: string): Set<string>;
export function jaccard(a: Set<string>, b: Set<string>): number;
export function blockKey(r: EntityRecord): string;
```

Four tiers, strongest-wins, over union-find: **tier 0** exact canonical key (GTIN/UPC/EAN check-digit-valid, else `brand|normModel(title)`; `canonicalUrl` for sources; email/phone/place_id for person/place), **tier 1** structured (brand + model-token, name + one strong field), **tier 2** fuzzy token Jaccard (product 0.60, source 0.80, place 0.70, person 0.85 — tuned to under-merge), **tier 3** embedding cosine (bge, `MODELS.embed`, opt-in via `embed:true`, `hasAI`-gated, ≤200 records — this design is that model's first consumer). `resolveWithEmbeddings` falls back verbatim to `resolve()` when `!hasAI(env) || !opts.embed`.

**Blocking must not hard-gate all tiers (folded major):** the draft's blocking key gated tiers 1–3, so two records that *are* the same entity in different blocks (retailer A brand `"DeWALT"`, retailer B brand empty) could **never** merge, even with embeddings — blocking caps recall before embeddings run. **Fix:** the **embedding tier (and a global fuzzy pass) run ACROSS blocks**, and `blockKey` is derived **only from a field stable across sources** (never brand/title alone). The design states explicitly that block-key disagreement on the pure-CPU tiers is an **unrecoverable miss** without the embedding pass.

### 5.2 `entity` fn — non-raw, self-bounded

**Not `raw:true` (folded major):** the draft's `raw:true` opts out of the `MAX_OUTPUT_CHARS` clamp (`index.ts:242`), and the output is ~2x the input (every cluster echoes each member's opaque `raw` **and** duplicates one member as `canonical`, pretty-printed) — then written to KV (`cacheable:true`). `MAX_ARG_BYTES=256_000` bounds **input**, not output. `normalizeArgs` only trims strings and would not corrupt records, so `raw:true` buys almost nothing while discarding the output cap. **Fix:** `entity` is **non-`raw`** (so `normalizeArgs`/`clampResult`/`normalizeText` apply); it also stops echoing full `raw` in **both** members and canonical, and self-guards output size inside `run()`. `Fn`: `cost:2`, `cacheable:true`, `ttl:300`.

**maxItems honesty (folded minor):** the schema's `maxItems:1000` is unreachable through dispatch — `checkArgs` rejects any args blob over 256KB, which real records hit at ~200–400 items. **Fix:** `maxItems` lowered to fit under 256KB for typical records, and the docs note **byte-size, not item-count, is the real cap** for the dispatched fn; the CPU-budget claim (`resolve()` sub-second, no I/O so it cannot time out) applies to the **unguarded inline `_entity.ts` helper path** that `shop`/`teach` use, which has no arg guard.

### 5.3 Consumers — `shop._compare` and `teach` dedup

**`collapseOffers` must not mislabel a SKU as a UPC (folded major):** the draft set `ids:{ upc: p.id }`, but `p.id` is the retailer's own id (kroger.productId, walmart usItemId, ASIN), **not** a GTIN — so `canonicalKey` only uses it if `isGtin()` passes, most fall through to model-token matching, and **grocery titles rarely carry clean model tokens** (`normModel` targets MPNs like `DCD777C2`, not "organic oat milk 64oz"). Net: cross-retailer collapse **almost never fires** for the real kroger/walmart/costco grocery domain, yet the draft framed it as *solving* `product_search`'s concat problem. **Fixes:** populate the `upc` slot **only from a field the retailer documents as a GTIN/UPC** (never `p.id`); guard against a retailer id that coincidentally passes `isGtin`'s check digit forcing a false cross-namespace merge (which silently drops an offer); and the docs **state honestly that grocery dedup recall is low without a real UPC source** — the identity ceiling is model-key extraction from free-text titles. `product_search` gains an opt-in `dedupe:true` (default off one cycle, then flip).

**teach `_kb` retrofit (re-pointed off oracle, D8):** the draft's "oracle `StoredKb.sources: string[] → {key,label}[]` migration" is re-pointed at teach/ask's `_kb.ts` v3, and **most of it is already correct there** — `_kb`'s `KbSource[]` already carries content hashes, `loadKb` already dual-reads legacy `sux:oracle:` keys and coerces shape, and teach's acquisition loop already skips an unchanged source by **content hash** (`contentHash`), not URL. So there is **no back-compat break** and no shape migration to ship. entity contributes only `canonicalUrl` as a **fetch-dedup helper within a single call** (dedupe `?utm_`/redirect variants before fetching), feeding teach's existing `sourceId(canonicalize(locator))`.

**URL idempotency must be content-hash, not URL-presence (folded major):** the draft's "if the URL is already in sources, return the cached distilled immediately" would **permanently skip re-learning a page whose content changed** — a regression for teach's core "learn updates" use (re-teaching a news/pricing URL silently returns stale KB). **Fix:** for URL sources the idempotency key is **`sha256Hex(fetched body)` after fetch**, not `canonicalUrl` alone; `canonicalUrl` is reserved for fetch-dedup within one call. teach already does exactly this (content-hash skip), so this is a *constraint honored*, not a change to make.

### 5.4 Infra, security, fn-count

**Transport:** none new — `_entity.ts` is pure compute; tier 3 uses the already-bound `AI` binding (edge-local, sub-second). No Vectorize (not bound), so clusters do not persist across calls and cross-call idempotency (teach) uses only the deterministic tier-0/content-hash key, never embeddings. **KV wording (folded minor):** not "no KV" — `entity` is `cacheable:true` so it writes the shared response cache under `cache:<sha256>`; the honest statement is **"no new KV namespace/binding; uses the existing content-addressed response cache under `cache:`,"** which is disjoint from `sux:kb:`/`sux:job:`/`sux:watch:`. **Security:** pure compute, no SSRF surface (never fetches `url`/`text` — they are opaque data); embeddings have no instruction channel (like m2m100 translate) so no prompt-injection fence; `canonicalUrl` is a pure string op (no DNS). **60s:** pure tiers can't time out on I/O; the embedding tier is opt-in and record-capped. **fn-count: +1.**

---

## Combined build order

Each cycle is independently shippable, testable, and (except where noted) reversible. Every new capability no-ops until its secret/binding is set, so Worker cycles land before the Mac/CF infra is ready.

1. **`notify.ts` + `sendNotify` + NTFY env** (config-presence selftest, no send). Independent, zero coupling.
2. **`batch` partial-return** (`pool()`-based checkpoint, opt-in envelope). The cheap 80% win; independent of all durable infra.
3. **`_entity.ts`** — types + pure primitives + `resolve()` union-find + cross-block fuzzy. Ships dark (no importer).
4. **`resolveWithEmbeddings()`** — bge tier, `hasAI`-gated fallback, cross-block.
5. **`entity.ts`** (non-raw, self-clamped) + register; then **`_compare.ts` + `product_search dedupe:true`** (default off), then flip.
6. **`diff.ts`** — pure `{a,b}` first, then baseline (cache-bypassing live fetch of "current", declutter-before-hash, Workers-AI only; `tier:"mac"` gated to fall back until §9).
7. **`jobs.ts` + unified `job.ts`** — registry CRUD (schedules under a direct `sux:sched:<id>` keyspace enumerated complete via `listSchedules`; terminal `workflow`/`cron` under chronological `sux:job:<invertedTs>:<id>` records + `sux:jobidx:<id>` pointer for bare-id resolution) + schedulable allowlist **+ args-cost gate** (schedulable is per-fn, fitting the 18s inline budget is per-args; `create` rejects unbounded shapes like `shop store:"*"`/deep `crawl`, and — once §4 lands — flags heavy-args-on-a-durable-runner targets `durable:true` instead, else fails closed) + `runJob` (through normalize/limiter, cache-bypassed live re-fetch so the change gate never reads the 24h stale hit) + drain lease + `action:"run"` + `get` null-read classification from the echoed `created` (`provisioning`/`gone`/`unknown`, D12). Test end-to-end synchronously, no cron.
8. **Cron branch** — add `*/15`, `runScheduled`/`drainJobs`, `_event`→`event`. Reversible. Jobs fire automatically.
9. **Mac LLM node** (`/llm` route, `_authorized` freshness, `llm_sem`, `OLLAMA_MAX_LOADED_MODELS=1`) → **`mac-llm.ts`** (breaker on 502 + abort-below-node-timeout) → **`ai.ts` `LlmOpts` with `timeout_ms`** → flip only the reasoning-heavy callers (ask answer, short voice restyle) → enable + tune. Each no-op until `MAC_LLM_URL` set. Unlocks `diff tier:"mac"`.
10. **Browse node** — refactor `_extract`/`_authorized`; **DNS-resolved SSRF re-check**; **`/browse`** with ephemeral context, own semaphore, network-layer submit/checkout blocking, screenshot-after-secret ban, node concurrency cap → **`macBrowse` + browseBreaker** → **`browse.ts`** (non-raw, clamped, fixed 8s margin, fan-out metering).
11. **Workflows infra** — `[[workflows]]` binding + no-op `SuxWorkflow` → `enqueueJob` (`source` a real parameter never a hardcoded literal, `source:"cron"` re-mints `baseId` per fire from `(scheduleId ?? "-", tickBucket)` so nightly jobs recur past the 7d-retained `complete` record and a standalone cron never collides with a durable-dispatched watch escalation sharing the same `(fn,args,tickBucket)`, async `jobId`, attempt nonce, `WORKFLOWS.get` verify, full `{created,source,kind,notify}` header in `create()` `params`, `created` echoed in the returned handle for get's null-read anchor + `sux:jobtomb:<id>` on terminal write, D12) merged into `jobs.ts` → static `RUNNERS` dispatch (payload-seeded `mark`, `writeJob` header invariant, `gateBackToSchedule` vs `finishNotify` split on `scheduleId`) + first runner `jobs/crawl.ts` (self-contained) → `jobs/teach.ts` (site) → `jobs/shop.ts` (all) → **durable-dispatched schedules go live** (with `WORKFLOWS` bound, the drain now escalates a `durable:true` schedule fire to a `source:"cron"` enqueue carrying `scheduleId` + per-fire `tickBucket` — **latch-guarded**: `runJob` sets `inflight_since` on the `sux:sched:` parent before escalating and skips a fire whose prior durable run is still in flight, younger than `DURABLE_FIRE_MAX_MS`, so a run outlasting a `15m`/`hourly` cadence can't spawn overlapping Workflows on the concurrency-1 solver — and `gateBackToSchedule` feeds the result back through the schedule change gate and **clears the latch** so a heavy `notify.on:"change"` watch fires correctly and non-overlapping — §1.3/§1.4/§1.5) → cron branch enqueues heavy periodic jobs, passing `enqueueJob(env, "cron", …, { on: "complete" | "error" }, tickBucket)` for every job whose result must be delivered (a cron enqueue with no `notify` is the state-mutation-only case; the explicit `source:"cron"` + per-fire `(scheduleId ?? "-", tickBucket)` re-mint is what makes the nightly job recur instead of returning its 7d-retained `complete` record, and keeps it distinct from the durable-dispatched watch escalation that shares its `(fn,args,tickBucket)`, §4.2), so `finishNotify` — handed the in-memory terminal record `mark` just wrote, never a bare-id KV re-read (§1.5/§4.4) — reads the threaded `notify` spec off that object and closes the loop.

---

## Deliberate scope cuts

- **No iMessage/Mac notify channel** — ntfy covers the need with zero Mac dependency; the AppleScript `/notify` route is documented, not built.
- **No Workflows for `batch` or any usually-fast fn** — durable execution is reserved for the three inherently-unbounded, must-complete jobs; everything else gets partial-return. Wrapping a 3-second call in a durable engine is the trap this design refuses.
- **No per-fn Mac model routing** — one warm model, binary fast/strong tier; per-task model selection forces a reload that blows the warm budget and the deadline.
- **No blanket strong-tier escalation** — teach distill/consolidate stay fast; only the reasoning-heavy `ask` answer and short voice restyles go strong, because serial strong calls do not compose under one 60s budget.
- **No Vectorize / persistent embeddings for `entity`** — in-request cosine only; cross-call identity uses deterministic keys, and grocery dedup recall is honestly capped without a real UPC database.
- **No `browse` checkout/purchase guarantee** — submit/payment blocking is best-effort at the interaction+network layer, off by default (`BROWSE_ALLOW_SENSITIVE=1`), and the docs say so; screenshots and vaulted secrets are mutually exclusive on a call.
- **No unbounded batch-fanned `browse`** — the node caps concurrent browse sessions regardless of caller; the marketing line is dropped.
- **No travel work here** — travel's authoritative design is `docs/proposals/travel.md`; it adopts the Workflows pattern as a consumer.

**Total fn-count delta across all five upgrades: +5** — `notify`, `diff`, `job`, `browse`, `entity` (**89 → 94**). mac-llm is +0 (pure infra behind `llm()`); Workflows is +0 additional (its handle surface is the unified `job` fn). Sibling proposals move the baseline independently; +5 is the delta attributable to these five.

## Related

- [[two-hard-facts]]
- [[fanout]]
- [[Infrastructure-MOC]]
