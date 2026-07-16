# SuxOS v2 — Op Engine & `suxlib` (Design Spec)

**Date:** 2026-07-15
**Scope:** Slices 1–2 of the SuxOS v2 redesign — the "walking skeleton."
**Status:** Draft for review. Terminal state of a `/brainstorming` pass; next step is `writing-plans`.
**Relates to:** `2026-07-15-get-file-fn-design.md`, the fetch-family redesign (`feat/fetch-family-redesign`), and the `SuxOS/suxlib` HOLD note in `docs/knowledge/master-plan.md` (this spec lifts that HOLD).

---

## 0. One-paragraph summary

SuxOS today runs "operations in the cloud" through a monolithic `sux` Worker whose only composition primitives are `pipe` (linear, text-threaded) and `batch` (one map + one reduce, nesting forbidden). That model cannot express the canonical operation — *fan-out over N inputs → join/reconcile → optional human pause → multiple sinks → return a small result* — and it threads binaries as base64 through step state. This spec introduces **one authoring surface with a graduated runtime**: an operation ("op") is a typed value authored once as pure combinators in a new shared library (`suxlib`); the engine runs it **inline** in-request for quick ops and promotes it to a **Cloudflare Workflow** for batch/mixed ops, with **content-addressed handles** (claim-check) so no blob ever crosses a step boundary. Slices 1–2 build the library, both runtimes, the reliability primitives, and prove the whole vertical with a single acceptance test: the PDF-zip tracer bullet.

---

## 1. Goals, non-goals, and the three op shapes

### 1.1 The three shapes this must serve (the design target)

| Shape | Example | Requirement |
|---|---|---|
| **Quick interop** | `scrape` a URL, `convert` a file, `summarize` text | one call, return fast, **zero orchestration tax** |
| **Batch** | OCR 500 PDFs, scrape 1,000 URLs | fan-out, survive restarts, per-item retry, backpressure |
| **Mixed** | the PDF-zip op (fan-out → reconcile → optional ask → 2 sinks → abstract) | a durable DAG with typed handles and a human pause |

The load-bearing decision: **not three tools, but one authoring model with two runtimes.** The same op scales *down* to a synchronous call as gracefully as it scales *up* to a durable batch.

### 1.2 Goals (slices 1–2)

1. `suxlib` — a **new `SuxOS/suxlib` repo** (lifts the documented HOLD) holding a dependency-light **pure core** plus CLI/HTTP/MCP adapters. It **absorbs `sux-fileops` outright** (that repo is retired) and is consumed by the `sux` Worker and the CLI. Kills the archive/pdf/convert/redact duplication that today lives in both `sux/src/fns` and `sux-fileops`, and adds a `suxlib` entry to `fabric.json`.
2. The **op abstraction** and combinators (`op`, `map`, `reconcile`, `pipe`, `sink`, `ask`).
3. The **graduated runtime**: `runInline` + `runDurable` (Cloudflare Workflows) behind one `run(op, input, {mode})`.
4. **Claim-check handles** over the existing content-addressed `store`.
5. The **control primitives** (token-bucket, AIMD, Full-Jitter backoff, idempotency, circuit breaker) as library code — composed into the governor later (slice 5), available to ops now.
6. **Acceptance:** the PDF-zip tracer bullet runs end-to-end, durably, with one `ask` checkpoint and two sinks.

### 1.3 Non-goals (explicitly deferred, to keep the skeleton thin)

- **Vault semantic search / Vectorize / AI Search** → slice 4. (Research settled: bge-m3 + hybrid via AI Search *or* hand-rolled RRF; decision deferred.)
- **`reconcile` conflict modes + Splink/dedupe entity resolution** → slice 3. The MVP `reconcile` does **faithful-union only** (deterministic concat + dedup), enough to prove the join.
- **MCP surface refactor / `search_tools`** → slice 3+. Near-term, lean on Anthropic's client-side Tool Search Tool (`defer_loading`); `sux()` + `fn` already provide server-side progressive disclosure.
- **Residential egress → suxrouter** → parallel track; the tracer bullet takes a zip as input, so egress is off the critical path.
- **The autonomous pipeline de-shelling & PID/AIMD governor** → slice 5.

---

## 2. Research grounding (verified; cited; confidence-tagged)

Two adversarial deep-research passes + primary-doc dogfooding. Confidence tags: **[V]** harness-verified/primary-doc, **[I]** reasoned inference, **[S]** validate with a build-time spike.

- **[V] Engine.** Cloudflare Workflows is GA/production-ready ([blog](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/)). Caps: **1,024 steps (Free) / 10,000 default–25,000 max (Paid)**; **1 MiB** on both step-return values and `waitForEvent` payloads; `step.sleep` is free and uncounted; unlimited wall-time per step but **CPU-capped per step** ([limits](https://developers.cloudflare.com/workflows/reference/limits/)).
- **[V] Human-in-the-loop.** `step.waitForEvent({type, timeout})` pauses at zero CPU (doesn't count against the 4,500-instance cap); resumed by `instance.sendEvent()` or REST; **throws on timeout** (wrap in try/catch) ([example](https://developers.cloudflare.com/workflows/examples/wait-for-event/)).
- **[V] Claim-check is mandatory.** The 1 MiB caps forbid threading blobs through step state → pass `{r2Key, sha256, idempotencyKey}` ([limits](https://developers.cloudflare.com/workflows/reference/limits/)). The existing `store` (R2, sha256-dedup) is this substrate.
- **[V] Graduated model.** DBOS makes an ordinary TS function durable by registration with an identical call site — "Workflows are ordinary TypeScript functions, not DAGs or DSLs" ([docs](https://docs.dbos.dev/typescript/reference/workflows-steps)). **Constraint:** durable bodies must be deterministic with I/O isolated in steps — so promotion is free *only if ops are authored as pure combinators with effects in leaves*.
- **[V] Control primitives.** Token-bucket is AWS's endorsed damped, non-modal limiter; **Full Jitter** `random(0, min(cap, base·2^n))`; **retry at a single point** (independent retries across layers = 3⁵ = 243× load) ([AWS](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)). AIMD is the field standard for concurrency discovery vs 429s (Netflix concurrency-limits; gadget-inc/aimd-bucket; floodgate for LLM APIs).
- **[V] Escape hatch.** Outgrow order: **Workflows → DBOS (in-process, Postgres) → Temporal (external, re-architecture)**. Leave CF only when 25k-step/1 MiB genuinely bite.
- **[S] Open — control-law composition.** Two passes returned **zero verifiable claims** on AIMD-vs-PID-vs-token-bucket as a *budget* governor. This is an engineering choice, not a findable fact. Position: token-bucket (spend pacing) + AIMD (concurrency) + Full-Jitter (retries); **PID rejected** (integral-windup risk on a bursty discrete signal). Validate empirically in slice 5.

---

## 3. Architecture

### 3.1 `suxlib` — the pure core (Slice 1)

A **new `SuxOS/suxlib` repo** of `(input, opts) => output` functions with **no ambient I/O**; effects are injected as capabilities. It generalizes the `sux-fileops` pure-core+adapter shape and **absorbs fileops outright** — fileops' pure core moves into `suxlib/domain/*`, its CLI/HTTP/MCP adapters become `suxlib`'s adapters, and the `sux-fileops` repo is retired.

```
suxlib/
  op/          op(), map(), reconcile(), pipe(), sink(), ask(); Op<I,O> types
  handles/     Handle<T> = {r2Key, sha256, type, size}; put/resolve over a Store capability
  control/     tokenBucket(), aimd(), backoffFullJitter(), circuitBreaker(), idempotencyKey()
  domain/      extract(), reconcile() [faithful-union MVP], archive.*, transform.*  (absorbed from fileops)
  effects/     capability interfaces: Store, Clock, Llm, Fetch  (injected, never imported)
```

**Consumers:** the `sux` Worker (both runtime adapters), `sux-fileops`, the CLI.
**Deletes:** `sux/src/fns/{archive,pdf,_convert,image_convert,compress,redact}.ts` become thin re-exports of `suxlib/domain/*` — one implementation, three surfaces.
**Determinism rule (from DBOS [V]):** everything in `op/` and `control/` is pure and deterministic; all I/O lives behind an `effects/` capability and is only invoked inside an op *leaf* (which becomes a durable step). This is what makes inline↔durable promotion free.

### 3.2 The op abstraction & combinators (Slice 1)

An `Op<I,O>` is a **typed, inspectable value** describing a computation as a tree of steps — not a running function. Combinators:

| Combinator | Meaning | Compiles to (durable) |
|---|---|---|
| `op(name, fn, {schema, retries, effort, kind})` | a leaf unit of work | one `step.do` |
| `map(op, {concurrency})` | fan-out over `Handle[]` | bounded fan-out; child workflow past ~25k items |
| `reconcile(ops, {mode})` | join N → 1 | a join `step.do` |
| `pipe(a, b, …)` | sequential compose | ordered steps |
| `sink(target)` | terminal write (R2 / vault / …) | terminal `step.do` |
| `ask(prompt, {timeout})` | human pause | `step.waitForEvent` (try/catch) |

Each leaf declares an input/output **schema**, a **retry** policy, an **effort/model** hint (satisfies "right-size every call"), a **kind** (`pure | effect`), and an optional **`heavy: true`** flag that routes the step to a Container. Leaf outputs are **`Handle<T>`**, resolved lazily — the runtime never materializes a blob it doesn't need. `sink` has concrete targets (`sink.r2`, `sink.vault`) and `sink.fanout(...)` runs several sinks as parallel terminal steps.

### 3.3 The graduated runtime — two adapters, one core (Slice 2)

```
run(op, input, { mode = 'auto' })
  ├ 'inline'  → runInline:  execute the op tree synchronously in-request. Quick ops. No Workflow.
  ├ 'durable' → runDurable: compile the op tree into a WorkflowEntrypoint and start an instance.
  └ 'auto'    → durable iff the op contains map / ask / a sink fan / declared large-N; else inline.
```

- **`runInline`** walks the tree calling leaves directly. This is (roughly) today's `fn` path, preserved and un-taxed.
- **`runDurable`** maps the tree onto Workflow steps per §3.2. `map` uses a bounded concurrency limiter (§3.5); a leaf that declares **`heavy: true`** (large PDF render/OCR) is dispatched to a **Container step** rather than a Worker step (Worker steps are CPU-capped [V]).
- **Selection is a knob, not magic** — `mode` overrides `auto`; `auto`'s rule is explicit and testable.

### 3.4 Data flow — claim-check everywhere (Slice 1–2)

Input bytes → `store.put` → `Handle`. Steps pass **handles, not bytes**. A leaf resolves only the handles it needs, does its work, `store.put`s its output, returns the new handle. The final small result (e.g. the abstract, < 1 MiB) is returned inline. Consequence: because every inter-step value is content-addressed, **re-runs resolve the same `sha256` and skip completed work** — idempotency, dedup, and crash-resumability fall out for free.

### 3.5 Error handling & control (Slice 1 primitives; wired in Slice 2)

- **Retries:** per-step via Workflows' native config `{retries:{limit, delay, backoff:'exponential'}, timeout}`; `NonRetryableError` for terminal failures. **Single retry point** [V] — leaves do **not** re-implement retry around a call that a step already retries.
- **Backoff:** `backoffFullJitter()` for any leaf making an external call that is *not* wrapped by a retrying step.
- **Concurrency:** `aimd()` limiter wraps `map` over external-API leaves — additive-increase, halve on 429, TCP-sawtooth toward the sustainable limit.
- **Idempotency:** `idempotencyKey(op, args) = sha256(name + stableStringify(args))` — reuses the content-addressed cache key already in `sux`.
- **`ask` timeout:** `waitForEvent` throws on timeout; the runtime catches and routes to a declared `onTimeout` handler (`'proceed' | 'fail'`; default `'fail'` with a resumable marker).

### 3.6 The tracer bullet — the acceptance test (Slice 2)

```ts
const assimilatePdfs = pipe(
  op('unzip',      unzipToHandles,        { kind: 'effect' }),   // zip Handle -> Handle[]
  map(
    op('extract',  pdfToMarkdown,         { kind: 'effect', heavy: true }),      // heavy:true -> Container step
    { concurrency: aimd() },
  ),
  reconcile({ mode: 'faithful-union' }),                                         // MVP: concat + dedup (consumes piped Handle[])
  ask('review master?', { timeout: '24 hour', onTimeout: 'proceed' }),          // optional human pause
  op('summarize',  summarizeHandle,       { kind: 'effect' }),
  sink.fanout(
    sink.r2('master'),                                                          // -> cloud storage
    sink.vault('summary'),                                                      // -> Obsidian vault
  ),
  op('abstract',   takeAbstract),                                               // small, returned inline
)
// run(assimilatePdfs, { zip: handle }, { mode: 'durable' })  -> { abstract }
```

**Proves:** claim-check handles (no PDF bytes cross a step), fan-out + join, a `waitForEvent` human pause, multi-sink, a Container step, and an inline-returned result — every load-bearing mechanism in one run.

---

## 4. Interfaces (the seams)

- **`suxlib`** public API: `op/map/reconcile/pipe/sink/ask`, `run`, `Handle`, `control/*`, `effects/*` capability interfaces. Everything else is internal.
- **`sux` Worker:** a `run` front-verb (MCP tool) — `run({ op, input, mode })` — invoking a registered op by name; durable runs return an instance id + a `/s/<uuid>` handle for the result.
- **CLI:** `sux op run <name> <input.json> [--mode]` (the fileops CLI adapter pattern, generalized).

Each unit answers *what it does / how you use it / what it depends on* without reading its internals — the isolation test. `suxlib` depends on nothing ambient; the adapters depend on `suxlib` + Cloudflare bindings; ops depend on `suxlib` combinators + injected effects.

---

## 5. Testing

- **`suxlib` pure core:** unit tests, the existing "1 test · 1 file · 1 fn" convention. Pure functions → no mocks.
- **Op engine:** `runInline` is a plain unit test. `runDurable` uses the Workflows **Vitest integration** — `mockEvent` to resolve `ask`, `disableSleeps` to skip waits [V].
- **Tracer bullet:** an integration test over a small fixture zip (2–3 PDFs) asserting the abstract, both sinks written, and — critically — that intermediate values are handles, not inlined bytes.

---

## 6. Rollout

- **Slice 1** — extract `suxlib`; absorb `sux-fileops`; delete the duplicated fns (re-export shims); ship `runInline` + the control primitives + the `reconcile` faithful-union MVP.
- **Slice 2** — `runDurable` (Workflows compile), the Container-step path, the `run` front-verb, and the tracer-bullet acceptance test.
- **Back-compat** — `pipe`/`batch` become thin shims over `run` (or deprecation-aliases). No caller breakage.

---

## 7. Risks & open questions (doubt)

- **[S] Control-law composition (slice 5).** Literature-empty; validate token-bucket + AIMD empirically; PID rejected pending evidence.
- **[V-caveat] DBOS-determinism refactor cost.** "Promotion is free" holds only if ops isolate I/O in leaves; messy existing fns need restructuring before they can run durably. Mitigated by authoring *new* ops correctly and shimming old ones through `runInline` first.
- **[V] Fan-out ceiling.** > ~25k units per instance needs child workflows; the `map` compiler must split large-N. Logged, not silently truncated.
- **[S] `reconcile` beyond faithful-union (slice 3).** Splink/dedupe ER + conflict modes are medium-confidence (single-preprint efficacy); spike on real data before committing modes.
- **Time-sensitivity [V-caveat].** Vectorize/AI-Search capacity and pricing are moving targets (2026 Q1–Q2 changes); re-verify at slice 4, not now.

---

## 8. What this explicitly is not

Not the vault redesign, not the MCP-surface refactor, not the egress migration, not the governor. Those are slices 3–6, each its own spec → plan → build. This spec is the **one vertical that makes something real run** and validates every layer's contract before any layer is widened.
