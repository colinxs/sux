# op-engine: a `metal` capability for leaves (Design Spec)

**Date:** 2026-07-22
**Scope:** Add `caps.metal` — a new op-engine capability that lets any leaf, in either
existing runtime, reach the SuxOS/metal spine (Postgres+pgvector and a home daemon).
**Status:** Draft for review. Terminal state of a `/brainstorming` pass; next step is `writing-plans`.
**Relates to:** `2026-07-15-suxos-v2-op-engine-design.md` (the op/caps model this extends),
`SuxOS/metal#24` and `2026-07-22-spine-design.md` (the substrate this capability reaches —
this spec's implementation is gated on that one's Phase 1–2 shipping).

## 1. Goal

Today `caps` gives a leaf `store` (R2), `llm` (Workers AI), `sinks` (named terminal
writes), and per-leaf `governors`/`cache` — a small, closed set of effect capabilities,
each independently addable, each just a plain object a leaf's `fn(input, caps)` calls.
Nothing about *how* a leaf reaches R2 or Workers AI is visible to the op tree or the
interpreter; it's an implementation detail inside `caps.store`/`caps.llm`.

Add one more: `caps.metal`. A leaf that wants a cross-domain Postgres join, a
pgvector similarity search, or to hand work to the spine daemon (enqueue a job,
trigger a render, touch the local filesystem) calls `caps.metal.query(...)` or
`caps.metal.call(...)` — the same shape as calling `caps.store.put(...)` today. No
new combinator, no new interpreter, no new `LeafOpts` field.

## 2. Non-goals

- **No per-leaf "runtime" declaration field.** The handoff that motivated this spec
  framed the ask as "a leaf declares which runtime it needs," which reads like it
  wants a dispatch mechanism (a `LeafOpts.runtime` enum, a switch in the interpreter).
  That's not needed — see §4. Do not add one.
- **No new interpreter.** `runInline` and `interpretDurable` are unchanged by this
  spec. Both already build `caps` once per run (`makeCaps`); this spec adds one field
  to that object. Neither tree-walker needs to know a leaf used it.
- **No Container-runtime design.** The 2026-07-15 spec's `heavy: true` → Container-step
  ambition was downscoped to a concurrency-governor selector during implementation
  (verified: `caps.ts`'s `makeGovernors`, `durable.ts:71` — `heavy` only picks
  `heavyConcurrency` vs plain `concurrency`, no Container dispatch exists today). If a
  concrete Container workload shows up later, it's a `caps.container` capability built
  the identical way this spec builds `caps.metal` — no engine change needed then either.
  Not designed here because nothing currently demands it (YAGNI).
- **No change to `catchOp`, `map`, `pipe`, or any existing combinator.** The
  best-effort/fallback behavior this capability needs (see §5) composes entirely from
  what already exists.

## 3. Design — `caps.metal`

```ts
interface MetalCaps {
  // Direct SQL via Hyperdrive+VPC (env.HYPERDRIVE binding). Read/write, parameterized.
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  // Everything that isn't SQL: job enqueue, render trigger, scoped fs read —
  // a thin fetch() wrapper against the spine's HTTP API (see spine-design.md §6).
  call<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T>;
}
```

Both methods are plain capabilities — no retry/timeout/fallback logic lives inside
`caps.metal` itself, matching how `caps.store`/`caps.llm` also stay thin and push
retry/backoff to the leaf's declared `LeafOpts.retries` (existing mechanism, already
honored by both runtimes) and fallback to `catchOp` (§5).

`query` talks Postgres wire protocol through the `HYPERDRIVE` binding — no auth headers
to construct, Hyperdrive handles the Tunnel/VPC connection. `call` sends
`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers (minted as a Worker secret,
same pattern as every other upstream `fn` uses for machine-to-machine auth — see
`sux/docs/design/archive/chunks/designs/home-node-connectivity.md`, which settled this
exact header shape for a Worker→home bridge back on 2026-07-12).

## 4. Wiring

`caps.ts`'s `makeCaps(env)` (both call sites — `run.ts`'s inline caps and
`durable.ts`'s durable caps already build `caps` from the same factory) gains:

```ts
metal: env.HYPERDRIVE
  ? { query: (sql, params) => queryViaHyperdrive(env.HYPERDRIVE, sql, params),
      call: (path, opts) => callSpine(env.SPINE_BASE_URL, env.SPINE_ACCESS_CLIENT_ID,
                                       env.SPINE_ACCESS_CLIENT_SECRET, path, opts) }
  : undefined,
```

Deliberately `undefined` (not a throwing stub) when the bindings/secrets aren't
configured — matches the established "eval-safe when absent" pattern every sops-gated
metal module already follows, and gives leaves an obvious presence check
(`if (!caps.metal) ...`) rather than a try/catch around a guaranteed throw.

New `RtEnv` surface (added to `registry.ts`, hand-typed like the existing `R2Bucket`
override — `wrangler types` regeneration inside a sandbox drops fields, per sux's
CLAUDE.md gotcha, so this must be committed by hand): `HYPERDRIVE: Hyperdrive`,
`SPINE_BASE_URL: string`, `SPINE_ACCESS_CLIENT_ID: string`,
`SPINE_ACCESS_CLIENT_SECRET: string`.

## 5. Failure mode — best-effort, existing fallback stays live

Per the design decision this spec answers to: nothing currently served by KV/D1/
Vectorize should stop working when elk-newt is unreachable. This is not new engine
work — it's the existing `catchOp` combinator, used the way it's already used
elsewhere:

```ts
catchOp(
  op('vault-semantic-pg', lookupViaPostgres, { kind: 'effect' }),  // caps.metal.query
  op('vault-semantic-kv', lookupViaKvCosine, { kind: 'effect' }),  // today's fallback, unchanged
)
```

A leaf using `caps.metal` should set a short `LeafOpts.retries` (existing field) rather
than relying on Hyperdrive/fetch's own default timeout — a home box behind a Tunnel can
hang rather than fail fast, and the whole point of best-effort is not blocking a Worker
request on a slow home network.

## 6. What this is NOT: no interpreter change

Worth stating explicitly since the source material for this spec described "four
runtimes" as peer interpreters. `runInline` and `interpretDurable` are two *tree
walkers* — each decides HOW a leaf's effect executes (call it directly vs. wrap it in
`step.do`). `caps.metal` doesn't change how either walker treats a leaf; it changes
what's *available inside* the leaf's own function body, same as `caps.store` always
has been. A leaf calling `caps.metal.query(...)` inside `interpretDurable`'s tree gets
that call automatically wrapped in a memoized `step.do` — same as every other effect
call already does. Nothing new to build there.

## 7. Testing

- `caps.metal.query`/`.call` unit-tested against a fake `Hyperdrive`/`fetch`, same
  shape as `caps.test.ts`'s existing fakes for `store`/`llm`.
- A leaf using `catchOp` with a metal-primary/KV-fallback pair gets one new test: metal
  call rejects (simulated) → fallback leaf runs → result matches the non-metal path.
  This is the one behavior worth directly testing, since it's the actual availability
  guarantee this spec exists to provide.
- No new integration-test harness needed — existing `durable.test.ts`'s fake `step.do`
  harness and `runInline`'s plain unit tests already cover leaf execution; `caps.metal`
  is just another fake capability in that same harness.

## 8. Dependencies

This spec can be **designed and reviewed now**, but `caps.metal` has nothing real to
call until `SuxOS/metal#24`'s Phase 1–2 ships (Postgres+pgvector live, Hyperdrive+VPC
service configured, the spine daemon's HTTP API up behind `cloudflared`+Access).
Implementation order: metal Phase 1 (Postgres proof) → metal Phase 2 (daemon skeleton +
ingress) → this spec's `caps.metal` wiring, proven against `vault_semantic`'s existing
~10k-vector-capped lookup as the first real caller (per spine-design.md's own Phase 1
target — same acceptance test serves both specs).
