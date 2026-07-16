# SuxOS v2 Op-Engine Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the thinnest end-to-end vertical of the SuxOS v2 op-engine — a new `suxlib` core plus a graduated (inline + Cloudflare Workflows) runtime — proven by the PDF-zip tracer bullet running durably with one human-pause and two sinks.

**Architecture:** Ops are typed tree values authored from pure combinators in a new `SuxOS/suxlib` repo. Two runtimes interpret the same tree: `runInline` (synchronous, in-request) and `runDurable` (compiles the tree onto one `WorkflowEntrypoint`, one `step.do` per leaf). All inter-step values are content-addressed `Handle`s (claim-check), never blobs.

**Tech Stack:** TypeScript 5, npm, Vitest, `fflate` (zip), Web Crypto (`crypto.subtle`) for sha256; Cloudflare Workers + Workflows + R2 + Workers AI in the `sux` worker adapter.

## Global Constraints

- **Purity:** everything in `suxlib/op/*` and `suxlib/control/*` is pure and deterministic. All I/O lives behind a `suxlib/effects/*` capability and is invoked ONLY inside an op leaf. (DBOS determinism rule — this is what makes inline↔durable promotion free.)
- **Claim-check:** leaf inputs/outputs that carry bytes are `Handle = {r2Key, sha256, type, size}`; never serialize a blob through a step return or an event payload (Cloudflare 1 MiB caps).
- **Single retry point:** rely on Workflows' per-step retry config; leaves do NOT re-implement retry around a call a step already retries.
- **Node/TS:** TypeScript `5.x`, `"module": "ESNext"`, `"target": "ES2022"`; no dependency that isn't dependency-light and actively maintained.
- **Tooling:** `npm` + `npx` (matches existing SuxOS repos — `package-lock.json`); do NOT use pnpm/yarn.
- **Plan tier:** assume Workers Paid (25,000-step ceiling).
- **Repo:** `suxlib` is a NEW `SuxOS/suxlib` repo; the op-engine lives INSIDE the existing `sux` worker.

---

## File Structure

**New repo `SuxOS/suxlib`:**
- `src/effects/types.ts` — `Store`, `Llm`, `Clock` capability interfaces; `MemoryStore` test double
- `src/handles/handle.ts` — `Handle`, `putBytes()`, `resolve()`
- `src/op/types.ts` — `Op` tree node union + `LeafOpts`
- `src/op/combinators.ts` — `op/pipe/map/reconcile/sink/ask`
- `src/control/aimd.ts` — `aimd()` limiter (`Concurrency` interface); `fixed()`
- `src/control/retry.ts` — `backoffFullJitter()`, `idempotencyKey()`
- `src/domain/archive.ts` — `unzip()` (ported from fileops core)
- `src/domain/text.ts` — `extract()` (pdf→md), `summarize()` leaves
- `src/runtime/inline.ts` — `runInline()`
- `src/index.ts` — public surface
- `test/**` — one test file per source file

**Existing repo `sux` (op-engine, slice 2):**
- `src/op-engine/durable.ts` — `compileToWorkflow()` + `OpWorkflow extends WorkflowEntrypoint`
- `src/op-engine/caps.ts` — R2/Workers-AI-backed `Store`/`Llm` adapters
- `src/fns/run.ts` — the `run` front-verb
- `wrangler.jsonc` — add the Workflow binding
- `test/op-engine/tracer.test.ts` — the acceptance test

---

## Task 1: Scaffold the `SuxOS/suxlib` repo

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `src/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces: a repo where `npm test` and `npm run build` run green.

- [ ] **Step 1: Create the repo skeleton**

`package.json`:
```json
{
  "name": "@suxos/lib",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json --noEmit" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" },
  "dependencies": { "fflate": "^0.8.2" }
}
```
`tsconfig.json`:
```json
{ "compilerOptions": { "module": "ESNext", "target": "ES2022", "moduleResolution": "Bundler",
  "strict": true, "verbatimModuleSyntax": true, "lib": ["ES2022", "WebWorker"], "skipLibCheck": true } }
```
`src/index.ts`: `export const VERSION = '0.0.0'`
`test/smoke.test.ts`:
```ts
import { test, expect } from 'vitest'
import { VERSION } from '../src/index.js'
test('package loads', () => { expect(VERSION).toBe('0.0.0') })
```

- [ ] **Step 2: Run tests** — Run: `npm install && npm test` — Expected: PASS (1 test).
- [ ] **Step 3: Commit** — `git init && git add -A && git commit -m "chore: scaffold suxlib repo"`

---

## Task 2: `Handle` type, `Store` capability, `MemoryStore`

**Files:**
- Create: `src/effects/types.ts`, `test/effects/memory-store.test.ts`

**Interfaces:**
- Produces: `Handle = {r2Key,sha256,type,size}`; `Store = {put(bytes,type)=>Promise<Handle>; get(h)=>Promise<Uint8Array>}`; `Llm`, `Clock`; `MemoryStore` implements `Store`.

- [ ] **Step 1: Write the failing test**
```ts
import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
test('MemoryStore round-trips bytes and dedups by content', async () => {
  const s = new MemoryStore()
  const h = await s.put(new TextEncoder().encode('hello'), 'text/plain')
  expect(h.size).toBe(5)
  expect(new TextDecoder().decode(await s.get(h))).toBe('hello')
  const h2 = await s.put(new TextEncoder().encode('hello'), 'text/plain')
  expect(h2.r2Key).toBe(h.r2Key) // content-addressed → same key
})
```
- [ ] **Step 2: Run — Expected: FAIL** (`MemoryStore` not defined). Run: `npx vitest run test/effects/memory-store.test.ts`
- [ ] **Step 3: Implement**
```ts
export interface Handle { r2Key: string; sha256: string; type: string; size: number }
export interface Store { put(bytes: Uint8Array, type: string): Promise<Handle>; get(h: Handle): Promise<Uint8Array> }
export interface Llm { markdownFromPdf(bytes: Uint8Array): Promise<string>; summarize(text: string): Promise<string> }
export interface Clock { now(): number }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export class MemoryStore implements Store {
  private m = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array, type: string): Promise<Handle> {
    const sha = await sha256Hex(bytes); const r2Key = `cas/${sha}`
    if (!this.m.has(r2Key)) this.m.set(r2Key, bytes)
    return { r2Key, sha256: sha, type, size: bytes.byteLength }
  }
  async get(h: Handle): Promise<Uint8Array> {
    const b = this.m.get(h.r2Key); if (!b) throw new Error(`handle not found: ${h.r2Key}`); return b
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Handle, Store capability, MemoryStore"`

---

## Task 3: content-addressed `putBytes` / `resolve` helpers

**Files:** Create `src/handles/handle.ts`, `test/handles/handle.test.ts`

**Interfaces:**
- Consumes: `Store`, `Handle` (Task 2).
- Produces: `putBytes(store, bytes, type) => Promise<Handle>`; `resolve(store, h) => Promise<Uint8Array>`; `putText`/`resolveText`.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText } from '../../src/handles/handle.js'
test('putText/resolveText round-trip', async () => {
  const s = new MemoryStore(); const h = await putText(s, 'abc', 'text/markdown')
  expect(await resolveText(s, h)).toBe('abc'); expect(h.type).toBe('text/markdown')
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
import type { Store, Handle } from '../effects/types.js'
export const putBytes = (s: Store, b: Uint8Array, type: string) => s.put(b, type)
export const resolve = (s: Store, h: Handle) => s.get(h)
export const putText = (s: Store, t: string, type = 'text/plain') => s.put(new TextEncoder().encode(t), type)
export const resolveText = async (s: Store, h: Handle) => new TextDecoder().decode(await s.get(h))
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: handle put/resolve helpers"`

---

## Task 4: Op tree types + `op()` leaf + `pipe()`

**Files:** Create `src/op/types.ts`, `src/op/combinators.ts`, `test/op/pipe.test.ts`

**Interfaces:**
- Produces: `Op` union (`leaf|pipe|map|reconcile|sink|ask`); `LeafOpts`; `op(name, fn, opts)`, `pipe(...ops)`. `LeafFn = (input:any, caps:Caps) => Promise<any>`. `Caps = { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget> }`.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { op, pipe } from '../../src/op/combinators.js'
test('op + pipe build an inspectable tree', () => {
  const t = pipe(op('a', async (x) => x + 1, { kind: 'pure' }), op('b', async (x) => x * 2, { kind: 'pure' }))
  expect(t.tag).toBe('pipe'); expect(t.steps.map(s => (s as any).name)).toEqual(['a', 'b'])
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
`src/op/types.ts`:
```ts
import type { Store, Llm, Clock } from '../effects/types.js'
export interface SinkTarget { name: string; write(input: any, caps: Caps): Promise<any> }
export interface Caps { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget> }
export interface Concurrency { acquire(): Promise<void>; release(ok: boolean): void }
export interface LeafOpts { kind: 'pure' | 'effect'; heavy?: boolean; retries?: number; effort?: 'cheap' | 'auto' | 'max' }
export type LeafFn = (input: any, caps: Caps) => Promise<any>
export type Op =
  | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
  | { tag: 'pipe'; steps: Op[] }
  | { tag: 'map'; op: Op; concurrency: Concurrency }
  | { tag: 'reconcile'; mode: 'faithful-union' }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
```
`src/op/combinators.ts`:
```ts
import type { Op, LeafFn, LeafOpts } from './types.js'
export const op = (name: string, fn: LeafFn, opts: LeafOpts): Op => ({ tag: 'leaf', name, fn, opts })
export const pipe = (...steps: Op[]): Op => ({ tag: 'pipe', steps })
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: op tree types + op/pipe"`

---

## Task 5: `map()` + `Concurrency` + `fixed()`

**Files:** Modify `src/op/combinators.ts`; Create `src/control/aimd.ts` (the `fixed` half here), `test/op/map.test.ts`

**Interfaces:**
- Consumes: `Op`, `Concurrency` (Task 4).
- Produces: `map(inner, {concurrency})`; `fixed(n): Concurrency`.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { map, op } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
test('map wraps an inner op with a concurrency limiter', () => {
  const m = map(op('x', async (v) => v, { kind: 'pure' }), { concurrency: fixed(2) })
  expect(m.tag).toBe('map'); expect((m as any).op.name).toBe('x')
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
Append to `combinators.ts`:
```ts
import type { Concurrency } from './types.js'
export const map = (inner: Op, o: { concurrency: Concurrency }): Op => ({ tag: 'map', op: inner, concurrency: o.concurrency })
```
`src/control/aimd.ts` (fixed limiter):
```ts
import type { Concurrency } from '../op/types.js'
export function fixed(n: number): Concurrency {
  let inflight = 0; const q: Array<() => void> = []
  return {
    async acquire() { if (inflight < n) { inflight++; return } await new Promise<void>(r => q.push(r)); inflight++ },
    release() { inflight--; const next = q.shift(); if (next) next() },
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: map combinator + fixed concurrency"`

---

## Task 6: `aimd()` adaptive concurrency limiter

**Files:** Modify `src/control/aimd.ts`; Create `test/control/aimd.test.ts`

**Interfaces:**
- Produces: `aimd(opts?) => Concurrency` — additive-increase on `release(true)`, multiplicative-decrease (halve) on `release(false)`.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { aimd } from '../../src/control/aimd.js'
test('aimd halves its limit on failure and grows on success', async () => {
  const c = aimd({ start: 8, min: 1 })
  await c.acquire(); c.release(false)          // failure → limit 8→4
  expect(c.limit).toBe(4)
  for (let i = 0; i < 4; i++) { await c.acquire(); c.release(true) } // successes → additive increase
  expect(c.limit).toBeGreaterThan(4)
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** (extend the file; expose `limit` for testability)
```ts
export interface Aimd extends Concurrency { readonly limit: number }
export function aimd(opts: { start?: number; min?: number; max?: number } = {}): Aimd {
  let limit = opts.start ?? 4; const min = opts.min ?? 1, max = opts.max ?? 64
  let inflight = 0; let successes = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < limit && q.length) { inflight++; q.shift()!() } }
  return {
    get limit() { return limit },
    async acquire() { await new Promise<void>(r => { q.push(r); pump() }) },
    release(ok: boolean) {
      inflight--
      if (ok) { if (++successes >= limit) { limit = Math.min(max, limit + 1); successes = 0 } }
      else { limit = Math.max(min, Math.floor(limit / 2)); successes = 0 }
      pump()
    },
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: AIMD adaptive concurrency limiter"`

---

## Task 7: `reconcile()` faithful-union

**Files:** Modify `src/op/combinators.ts`; Create `src/op/reconcile.ts`, `test/op/reconcile.test.ts`

**Interfaces:**
- Consumes: `Handle[]`, `Store`.
- Produces: `reconcile({mode:'faithful-union'})` node; `faithfulUnion(handles, store) => Promise<Handle>` (concat resolved text, dedup identical blocks by sha, provenance header per block).

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { faithfulUnion } from '../../src/op/reconcile.js'
test('faithfulUnion concatenates and dedups identical blocks', async () => {
  const s = new MemoryStore()
  const a = await putText(s, 'shared\n', 'text/markdown')
  const b = await putText(s, 'shared\n', 'text/markdown') // identical → same handle
  const c = await putText(s, 'unique\n', 'text/markdown')
  const master = await resolveText(s, await faithfulUnion([a, b, c], s))
  expect(master.match(/shared/g)!.length).toBe(1)  // deduped
  expect(master).toContain('unique')
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
import type { Store, Handle } from '../effects/types.js'
import { putText, resolveText } from '../handles/handle.js'
export async function faithfulUnion(handles: Handle[], store: Store): Promise<Handle> {
  const seen = new Set<string>(); const blocks: string[] = []
  for (const h of handles) {
    if (seen.has(h.sha256)) continue; seen.add(h.sha256)
    blocks.push(`<!-- source: ${h.r2Key} -->\n${await resolveText(store, h)}`)
  }
  return putText(store, blocks.join('\n\n'), 'text/markdown')
}
```
Append node constructor to `combinators.ts`:
```ts
export const reconcile = (o: { mode: 'faithful-union' }): Op => ({ tag: 'reconcile', mode: o.mode })
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: reconcile faithful-union"`

---

## Task 8: `sink()` + `sink.fanout()`

**Files:** Modify `src/op/combinators.ts`; Create `test/op/sink.test.ts`

**Interfaces:**
- Consumes: `Caps.sinks` (a `Record<string, SinkTarget>`).
- Produces: `sink(name)` and `sink.fanout(...names)` → `{tag:'sink', targets}`; `runInline` (Task 10) resolves each name against `caps.sinks` and writes in parallel.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { sink } from '../../src/op/combinators.js'
test('sink and sink.fanout produce target lists', () => {
  expect(sink('r2')).toEqual({ tag: 'sink', targets: ['r2'] })
  expect(sink.fanout('r2', 'vault').targets).toEqual(['r2', 'vault'])
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
export const sink = Object.assign(
  (name: string): Op => ({ tag: 'sink', targets: [name] }),
  { fanout: (...names: string[]): Op => ({ tag: 'sink', targets: names }) },
)
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: sink + sink.fanout"`

---

## Task 9: `ask()` node, `idempotencyKey()`, `backoffFullJitter()`

**Files:** Modify `src/op/combinators.ts`; Create `src/control/retry.ts`, `test/control/retry.test.ts`

**Interfaces:**
- Produces: `ask(prompt, {timeout, onTimeout})`; `idempotencyKey(name, args) => Promise<string>` (sha256 of `name`+stable JSON); `backoffFullJitter(attempt, {base, cap}) => number`.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { backoffFullJitter, idempotencyKey } from '../../src/control/retry.js'
test('full-jitter stays within [0, min(cap, base*2^n)] and idempotencyKey is stable', async () => {
  const d = backoffFullJitter(3, { base: 100, cap: 20_000 }, () => 0.5)
  expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(800) // base*2^3 = 800
  expect(await idempotencyKey('x', { a: 1 })).toBe(await idempotencyKey('x', { a: 1 }))
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
`src/control/retry.ts`:
```ts
export function backoffFullJitter(attempt: number, o: { base: number; cap: number }, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(o.cap, o.base * 2 ** attempt))
}
export async function idempotencyKey(name: string, args: unknown): Promise<string> {
  const stable = JSON.stringify(args, Object.keys(args as object).sort())
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name + stable))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
```
Append `ask` to `combinators.ts`:
```ts
export const ask = (prompt: string, o: { timeout: string; onTimeout: 'proceed' | 'fail' }): Op =>
  ({ tag: 'ask', prompt, timeout: o.timeout, onTimeout: o.onTimeout })
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: ask node + full-jitter + idempotency key"`

---

## Task 10: `runInline()` — the eager interpreter

**Files:** Create `src/runtime/inline.ts`, `test/runtime/inline.test.ts`

**Interfaces:**
- Consumes: every `Op` node, `Caps`, `faithfulUnion` (Task 7).
- Produces: `runInline(op, input, caps) => Promise<any>`. `ask` in inline mode resolves immediately via `caps.askInline?(prompt)` (default: proceed with the piped value). `map` requires the piped input to be an array; each element passes through the inner op under the concurrency limiter.

- [ ] **Step 1: Failing test**
```ts
import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { op, pipe, map, reconcile, sink } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { runInline } from '../../src/runtime/inline.js'
test('runInline threads a pipe: split → map → reconcile → sink', async () => {
  const store = new MemoryStore(); const written: any[] = []
  const caps: any = { store, llm: {}, clock: { now: () => 0 },
    sinks: { out: { name: 'out', write: async (v: any) => { written.push(v); return v } } } }
  const tree = pipe(
    op('split', async (words: string[]) => Promise.all(words.map(w => putText(store, w + '\n'))), { kind: 'effect' }),
    map(op('id', async (h) => h, { kind: 'pure' }), { concurrency: fixed(2) }),
    reconcile({ mode: 'faithful-union' }),
    sink('out'),
  )
  const result = await runInline(tree, ['alpha', 'beta'], caps)
  expect(written.length).toBe(1)
  expect(await resolveText(store, result)).toContain('alpha')
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
import type { Op, Caps } from '../op/types.js'
import { faithfulUnion } from '../op/reconcile.js'
export async function runInline(node: Op, input: any, caps: Caps): Promise<any> {
  switch (node.tag) {
    case 'leaf': return node.fn(input, caps)
    case 'pipe': { let v = input; for (const s of node.steps) v = await runInline(s, v, caps); return v }
    case 'map': {
      const items: any[] = input; const out = new Array(items.length)
      await Promise.all(items.map(async (it, i) => {
        await node.concurrency.acquire()
        try { out[i] = await runInline(node.op, it, caps); node.concurrency.release(true) }
        catch (e) { node.concurrency.release(false); throw e }
      }))
      return out
    }
    case 'reconcile': return faithfulUnion(input, caps.store)
    case 'sink': { await Promise.all(node.targets.map(t => caps.sinks[t].write(input, caps))); return input }
    case 'ask': return input // inline mode: no human pause; proceed with the piped value
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: runInline interpreter"`

---

## Task 11: domain leaves — `unzip`, `extract`, `summarize`

**Files:** Create `src/domain/archive.ts`, `src/domain/text.ts`, `test/domain/archive.test.ts`; Modify `src/index.ts` to export the public surface.

**Interfaces:**
- Consumes: `Caps` (`store`, `llm`), `fflate`.
- Produces: `unzip: LeafFn` (zip `Handle` → `Handle[]`); `extract: LeafFn` (pdf `Handle` → markdown `Handle`, `heavy:true`); `summarize: LeafFn` (markdown `Handle` → `{abstract, summaryHandle}`).

- [ ] **Step 1: Failing test** (archive is pure enough to test with a real zip)
```ts
import { test, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolveText } from '../../src/handles/handle.js'
import { unzip } from '../../src/domain/archive.js'
test('unzip expands a zip handle into per-file handles', async () => {
  const store = new MemoryStore()
  const zip = zipSync({ 'a.txt': strToU8('AAA'), 'b.txt': strToU8('BBB') })
  const zh = await putBytes(store, zip, 'application/zip')
  const parts = await unzip(zh, { store } as any)
  expect(parts.length).toBe(2)
  expect((await Promise.all(parts.map((p: any) => resolveText(store, p)))).sort()).toEqual(['AAA', 'BBB'])
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
`src/domain/archive.ts`:
```ts
import { unzipSync } from 'fflate'
import type { LeafFn } from '../op/types.js'
import { resolve, putBytes } from '../handles/handle.js'
export const unzip: LeafFn = async (zipHandle, caps) => {
  const bytes = await resolve(caps.store, zipHandle)
  const files = unzipSync(bytes)
  return Promise.all(Object.entries(files).map(([name, data]) =>
    putBytes(caps.store, data, name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream')))
}
```
`src/domain/text.ts`:
```ts
import type { LeafFn } from '../op/types.js'
import { resolve, putText, resolveText } from '../handles/handle.js'
export const extract: LeafFn = async (pdfHandle, caps) => {   // heavy:true when used in an op
  const md = await caps.llm.markdownFromPdf(await resolve(caps.store, pdfHandle))
  return putText(caps.store, md, 'text/markdown')
}
export const summarize: LeafFn = async (masterHandle, caps) => {
  const abstract = await caps.llm.summarize(await resolveText(caps.store, masterHandle))
  return { abstract, summaryHandle: await putText(caps.store, abstract, 'text/markdown') }
}
```
Export the surface in `src/index.ts`:
```ts
export * from './effects/types.js'; export * from './handles/handle.js'
export * from './op/types.js'; export * from './op/combinators.js'; export * from './op/reconcile.js'
export * from './control/aimd.js'; export * from './control/retry.js'
export * from './domain/archive.js'; export * from './domain/text.js'; export * from './runtime/inline.js'
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat: unzip/extract/summarize domain leaves + public surface"`

---

## Task 12: `compileToWorkflow()` — the durable runtime (in `sux`)

**Files:** Create `sux/src/op-engine/durable.ts`, `sux/test/op-engine/durable.test.ts`

**Interfaces:**
- Consumes: `Op` tree, `Caps`, `@suxos/lib` (add as a dependency of `sux`).
- Produces: `class OpWorkflow extends WorkflowEntrypoint<Env, {opId:string; input:Handle}>`; `interpretDurable(node, input, step, caps)` mapping each node to Workflow primitives.

**Replay-determinism (REQUIRED design note in this file's header comment):** the `Op` tree is a *static* value; `map`'s item list comes only from a prior step's *memoized* `Handle[]` return — never from `Date.now()`/`Math.random()`/live I/O. Every leaf runs inside `step.do(uniqueName, …)`, so its result is memoized and the body replays deterministically. Step names must be unique and stable: derive them as `${node.name}:${index}`.

**Large-N (documented stub):** `map` fan-out is `Promise.all` of `step.do` calls, bounded by the limiter — fine to the 25k-step ceiling. Past that, split into child workflows via a `env.OP_WORKFLOW.create()` loop awaited by polling instance status. Out of scope for the MVP (tracer bullet = 2–3 PDFs); leave a `// TODO(slice-2-scale): child-workflow split above N steps` marker and throw a clear error if `items.length > 20_000`.

- [ ] **Step 1: Failing test** (a fake `step` that runs `do` inline and records `waitForEvent`)
```ts
import { test, expect } from 'vitest'
import { MemoryStore, type Caps } from '@suxos/lib'
import { op, pipe, ask } from '@suxos/lib'
import { interpretDurable } from '../../src/op-engine/durable.js'
test('interpretDurable runs leaves through step.do and resolves ask via an event', async () => {
  const events: string[] = []
  const step: any = {
    do: async (_n: string, fn: any) => fn(),
    waitForEvent: async ({ type }: any) => { events.push(type); return { payload: {} } },
    sleep: async () => {},
  }
  const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps
  const tree = pipe(op('inc', async (n: number) => n + 1, { kind: 'pure' }), ask('ok?', { timeout: '1 hour', onTimeout: 'proceed' }))
  const out = await interpretDurable(tree, 1, step, caps, 'op1')
  expect(out).toBe(2); expect(events).toEqual(['ask:ok?'])
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers'
import { faithfulUnion, type Op, type Caps } from '@suxos/lib'
export async function interpretDurable(node: Op, input: any, step: WorkflowStep, caps: Caps, path: string): Promise<any> {
  switch (node.tag) {
    case 'leaf': return step.do(`${path}:${node.name}`, () => node.fn(input, caps))
    case 'pipe': { let v = input; let i = 0; for (const s of node.steps) v = await interpretDurable(s, v, step, caps, `${path}.${i++}`); return v }
    case 'map': {
      const items: any[] = input
      if (items.length > 20_000) throw new Error('map fan-out exceeds MVP ceiling; needs child-workflow split') // TODO(slice-2-scale)
      const out = new Array(items.length)
      await Promise.all(items.map(async (it, i) => {
        await node.concurrency.acquire()
        try { out[i] = await interpretDurable(node.op, it, step, caps, `${path}.m${i}`); node.concurrency.release(true) }
        catch (e) { node.concurrency.release(false); throw e }
      }))
      return out
    }
    case 'reconcile': return step.do(`${path}:reconcile`, () => faithfulUnion(input, caps.store))
    case 'sink': { await Promise.all(node.targets.map(t => step.do(`${path}:sink:${t}`, () => caps.sinks[t].write(input, caps)))); return input }
    case 'ask': {
      try { await step.waitForEvent(`ask:${node.prompt}`, { type: `ask:${node.prompt}`, timeout: node.timeout }) }
      catch (e) { if (node.onTimeout === 'fail') throw e }
      return input
    }
  }
}
export class OpWorkflow extends WorkflowEntrypoint<any, { opId: string; input: any }> {
  async run(event: WorkflowEvent<{ opId: string; input: any }>, step: WorkflowStep) {
    const { registry, makeCaps } = await import('./run.js')
    const tree = registry[event.payload.opId]
    return interpretDurable(tree, event.payload.input, step, makeCaps(this.env), 'root')
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat(sux): durable op interpreter + OpWorkflow"`

---

## Task 13: the `run` front-verb + R2/Workers-AI caps + wrangler binding

**Files:** Create `sux/src/op-engine/caps.ts`, `sux/src/fns/run.ts`; Modify `sux/wrangler.jsonc`; register `run` in the fn registry.

**Interfaces:**
- Consumes: `OpWorkflow` (Task 12), `@suxos/lib`.
- Produces: `run({op, input, mode})` front-verb; `makeCaps(env) => Caps` (R2-backed `Store`, Workers-AI `Llm`, R2/vault `SinkTarget`s); `registry: Record<string, Op>`.

- [ ] **Step 1: Failing test** (inline path; `mode:'inline'` doesn't need Workflows)
```ts
import { test, expect } from 'vitest'
import { runVerb } from '../../src/fns/run.js'
test('run executes a registered op inline', async () => {
  const env: any = { /* fake R2/AI injected by makeCaps test double */ }
  const res = await runVerb({ op: 'echo', input: 'hi', mode: 'inline' }, env)
  expect(res).toBe('hi')
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** `caps.ts` (R2 `Store`, AI `Llm`, sinks), `run.ts`:
```ts
import { runInline, op, type Op, type Caps } from '@suxos/lib'
import { makeCaps } from '../op-engine/caps.js'
export const registry: Record<string, Op> = { echo: op('echo', async (x) => x, { kind: 'pure' }) }
export { makeCaps }
export async function runVerb({ op: opId, input, mode = 'auto' }: { op: string; input: any; mode?: 'inline' | 'durable' | 'auto' }, env: any) {
  const tree = registry[opId]; if (!tree) throw new Error(`unknown op: ${opId}`)
  const durable = mode === 'durable' || (mode === 'auto' && hasFanoutOrAsk(tree))
  if (!durable) return runInline(tree, input, makeCaps(env))
  const instance = await env.OP_WORKFLOW.create({ params: { opId, input } })
  return { instanceId: instance.id }
}
function hasFanoutOrAsk(n: Op): boolean {
  if (n.tag === 'map' || n.tag === 'ask') return true
  if (n.tag === 'pipe') return n.steps.some(hasFanoutOrAsk)
  return false
}
```
`wrangler.jsonc` — add:
```jsonc
"workflows": [{ "name": "op-workflow", "binding": "OP_WORKFLOW", "class_name": "OpWorkflow" }]
```
and `export { OpWorkflow } from './op-engine/durable.js'` from the worker entry.
- [ ] **Step 4: Run — Expected: PASS.**  — [ ] **Step 5: Commit** — `git commit -am "feat(sux): run verb + caps + Workflow binding"`

---

## Task 14: the PDF-zip tracer bullet (acceptance test)

**Files:** Modify `sux/src/fns/run.ts` (register `assimilate-pdfs`); Create `sux/test/op-engine/tracer.test.ts`, `sux/test/fixtures/two.zip` (2 tiny PDFs).

**Interfaces:**
- Consumes: everything above.
- Produces: the `assimilatePdfs` op registered under `registry['assimilate-pdfs']`; a passing integration test using the Workflows Vitest APIs (`mockEvent`, `disableSleeps`).

- [ ] **Step 1: Register the op** in `run.ts`:
```ts
import { pipe, map, reconcile, sink, ask, op, aimd, unzip, extract, summarize } from '@suxos/lib'
registry['assimilate-pdfs'] = pipe(
  op('unzip', unzip, { kind: 'effect' }),
  map(op('extract', extract, { kind: 'effect', heavy: true }), { concurrency: aimd({ start: 4 }) }),
  reconcile({ mode: 'faithful-union' }),
  ask('review master?', { timeout: '24 hour', onTimeout: 'proceed' }),
  op('summarize', summarize, { kind: 'effect' }),
  sink.fanout('r2', 'vault'),
)
```
- [ ] **Step 2: Write the failing acceptance test**
```ts
import { test, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'   // Workflows vitest integration
test('tracer bullet: zip → extract×2 → reconcile → ask → 2 sinks → abstract', async () => {
  const zipHandle = await putFixtureZip(env)                // helper: uploads test/fixtures/two.zip to R2, returns Handle
  const inst = await env.OP_WORKFLOW.create({ params: { opId: 'assimilate-pdfs', input: zipHandle } })
  await inst.mockEvent?.({ type: 'ask:review master?', payload: {} })   // resolve the human pause
  const status = await inst.status()
  expect(status.output.abstract).toBeTruthy()
  expect(await env.R2.head('sink/master')).not.toBeNull()   // R2 sink written
  expect(await env.VAULT_wrote('summary')).toBe(true)       // vault sink written
})
```
- [ ] **Step 3: Run — Expected: FAIL** (op not fully wired / fixture missing). Run: `cd sux && npx vitest run test/op-engine/tracer.test.ts`
- [ ] **Step 4: Implement** the `putFixtureZip` helper + R2/vault sink `SinkTarget`s in `caps.ts` so the test passes; ensure `extract` uses `env.AI` `toMarkdown`.
- [ ] **Step 5: Run — Expected: PASS.** The walking skeleton is proven end-to-end.
- [ ] **Step 6: Commit** — `git commit -am "test(sux): PDF-zip tracer bullet passes end-to-end"`

---

## Deferred to the follow-on "suxlib widening" plan (NOT this plan)

Explicitly out of scope here, tracked so nothing is silently dropped:
- Full `sux-fileops` port into `suxlib/domain/*` (all archive/pdf/sanitize/transform ops) and deletion of the duplicated `sux/src/fns/{archive,pdf,_convert,image_convert,compress,redact}.ts`.
- `suxlib` CLI / HTTP / MCP adapters; retire the `sux-fileops` repo; add the `suxlib` entry to `fabric.json`.
- `token-bucket` + `circuit-breaker` control primitives (the governor composition — slice 5).
- `reconcile` conflict-aware / synthesized modes with Splink/dedupe ER (slice 3).
- Large-N child-workflow fan-out (replace the `> 20_000` guard in Task 12).

---

## Self-Review

**Spec coverage:** suxlib pure core (Tasks 2–11) ✓; op combinators (4–9) ✓; graduated runtime — inline (10) + durable (12–13) ✓; claim-check handles (2–3, used throughout) ✓; control primitives present for the vertical — AIMD (6), full-jitter+idempotency (9); token-bucket/circuit-breaker correctly deferred ✓; tracer bullet acceptance (14) ✓. The *full* fileops absorption and adapters are a spec slice-1 goal deliberately moved to the follow-on plan (documented above) — flagged, not dropped.

**Placeholder scan:** the only `TODO` is the intentional, labeled `TODO(slice-2-scale)` child-workflow marker in Task 12 with a hard error guard — a real boundary, not a hidden gap.

**Type consistency:** `Handle`, `Store`, `Caps`, `Concurrency`, `LeafFn`, `Op` node shapes are defined once (Tasks 2, 4) and used verbatim in `runInline` (10) and `interpretDurable` (12); `faithfulUnion(handles, store)` signature matches its call sites; `aimd()`/`fixed()` both return `Concurrency`.
