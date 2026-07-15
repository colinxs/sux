---
title: sux-mcp — patterns & conventions
status: living
audience: future Claude sessions — reuse these instead of re-deriving them
---

# How sux is built — the cheat-sheet

sux is one Cloudflare Worker: an MCP server exposing ~95 edge functions ("fns") plus the
personal-data namespaces (vault / mail / files / cal / contact), all fronted by the single
`/mcp` connector as ordinary front verbs (`vault_`/`mail_`/`files_`/`cal_`/`contact_`) — the
old per-namespace `/<domain>/mcp` connectors are fully retired (#105), not just dormant. This
file distills the recurring code patterns so a fresh session writes in the grain of the
codebase. Everything below is grounded in the live source (paths + line numbers as of this
writing).

Companion docs: the product vision is `docs/design/north-star.md`; the working rules (git/CI/
review, sessions, model selection) are `CLAUDE.md`. Deep architecture lives in Claude memory
(`sux-mcp-namespaces`, `knowledge-core-decisions`).

---

## 1. Fn anatomy — the unit of capability

**What.** Every capability is an `Fn` (`sux/src/registry.ts:284`): a plain object with a
`name`, an LLM-facing `description`, a JSON-Schema `inputSchema`, optional caching/cost metadata,
and a `run(env, args) => Promise<ToolResult>`. One fn per file under `sux/src/fns/<name>.ts`,
`export const <name>: Fn`.

```ts
export type Fn = {
	name: string;
	description: string;
	inputSchema: unknown;
	cacheable?: boolean;   // opt into the KV cache at dispatch (§5)
	cost?: number;         // weighted rate-limit tokens; default 1 = no extra (§2)
	ttl?: number;          // per-fn cache lifetime override (seconds)
	raw?: boolean;         // byte-exact: skip input/output normalization + output clamp
	surface?: "front" | "leaf";        // front-door membership (§2)
	annotations?: ToolAnnotations;     // readOnly/destructive/idempotent/openWorld hints
	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};
```

**Result helpers** (`registry.ts:251`) — always return through these, never hand-build the
envelope:

- `ok(text)` — a success `ToolResult`.
- `fail(text)` — an error (`isError:true`), untyped.
- `failWith(code, text)` — an error carrying a machine-readable `FailCode` from the fixed
  `FAIL_CODES` taxonomy (`registry.ts:248`): `not_configured | blocked | timeout | rate_limited |
  not_found | upstream_error | bad_input | layout_change`. The code is prefixed to the text as
  `[code]` (so it flows into the Grafana `err` field) *and* attached as `errorCode`. **Prefer
  `failWith`** — it groups failures by cause in observability. See `scrape.ts` / `render.ts` for
  canonical usage: `failWith("bad_input", "Provide an absolute http(s) url.")`.

`ToolResult` also carries an optional `noCache?: boolean` — set it (via `noCacheOn4xx` /
`noCacheOnMutation` helpers in `fns/_util.ts`) so error pages and mutations are never cached.

**Registration.** Fns are collected in the one generated-and-committed file
`sux/src/fns/index.ts` (`export const FUNCTIONS: Fn[]`). Generate it with `npm run gen:index`
(`sux/scripts/gen-index.mjs`): it scans `fns/*.ts`, extracts each `export const X: Fn` +
`name:"…"`, orders by `scripts/importance.mjs`, and writes the import list + array. Files
starting with `_` are helpers, excluded from the manifest. **This is the one generated file we
commit** — the Worker imports it at build/test time (observability.ts, registry.test.ts,
rate-limit.ts). After adding/removing a fn: `npm run gen:index` and commit `index.ts` (the
pre-commit hook stages it; hand-editing fails CI). The pure docs (`FUNCTIONS.md`, `llms.txt`)
are gitignored and regenerated on demand — never commit those.

---

## 2. Front-verb routing — a legible tool surface over ~95 fns

**What.** `tools/list` advertises only the curated **front verbs** — ~18 root tools — not all
95, so the surface stays mobile-legible. Everything else is a **leaf**: still fully dispatchable
(by its own name, or via the `fn` escape) and still discoverable (the `sux` capability map), just
not flooding the list.

`FRONT_VERBS` (`registry.ts:375`) is the source of truth:

```ts
export const FRONT_VERBS = new Set<string>([
	"sux", "fn",
	"search", "scrape", "shop",
	"ingest", "recall", "oracle",
	"pipe", "batch",
	"store", "preferences", "issue",
	"vault", "mail", "files", "cal", "contact",
]);
```

A fn joins the front door either by being in this set or by self-declaring `surface:"front"`
(`isFrontVerb`, `registry.ts:385`). `frontToolList` filters the advertised list; `handleRpc`'s
`tools/list` returns `frontToolList(FUNCTIONS)` (`index.ts:162`).

**The `fn` escape.** A leaf is reached with `fn({name, args})`. `unwrapFnCall`
(`registry.ts:414`) rewrites this in place *before* findFn/cache/normalize, so a leaf reached via
`fn` runs byte-identically to a direct call — same cache key, same deadline, same weighted cost.
The inner name is resolved through the same `normalizeText` fold the dispatcher applies, so a
fullwidth/zero-width homoglyph can't dodge the cost weighting or cache. The **same helper** is
shared by the dispatcher (`index.ts:192`) and the rate limiter (`rate-limit.ts:32`) so the two
never diverge.

**`sux` = the self-describing map** (`fns/sux.ts`). Skills don't sync to mobile, so on a phone
the agent sees the bare tool list. `sux` returns the whole capability surface (domains → purpose
→ leaf fns → how to reach them), built live from the registry so it never drifts. `sux({domain})`
zooms in. The rendering lives in `fns/_surface.ts`, shared with the public `GET /llms.txt`.

**Action-vs-front-verb.** Namespace front verbs (`vault`/`mail`/`files`/`cal`/`contact`) take an
`action` arg and dispatch into the existing namespace handlers (`vault-mcp.ts` etc.), so the whole
digital-life spine is reachable on the one `/mcp` connector, not only the separate `/<ns>/mcp`
connectors.

**Cost / weighted rate limiting** (`rate-limit.ts`). The base gate charges every call 1 token;
`Fn.cost` declares the EXTRA tokens an expensive fn burns beyond that (`render` has `cost:5`), so
a burst of paid/heavy calls (render, Kagi, Workers AI) drains the per-user budget faster than free
deterministic fns. `extraCost = max(0, cost-1)`.

---

## 3. Proxy / fetch ladder — residential egress + escalation

Cloudflare Workers egress from datacenter IPs that Akamai/PerimeterX-walled sites block. The
answer is a **tiered fetch ladder**, cheapest rung first:

1. **`smartFetch`** (`proxy.ts:355`) — the drop-in `fetch`. Routes through the **Tailscale
   residential proxy** (a home tailnet node exposed via Funnel) per `willProxy` policy, and
   **falls back to a direct fetch if the proxy errors** — so enabling the proxy can never take
   the Worker down. Used by `scrape` and ~20 other fns. Smart routing: authenticated APIs / DoH
   resolvers (`DIRECT_HOST_RE`, `proxy.ts:85`) go direct even when the proxy is on. Signs
   requests with HMAC-SHA256 (secret never crosses the wire), bounded retries with jitter +
   Retry-After (`withRetry`), 30s per-attempt cap, base64 binary-safe transport, and per-request
   egress-audit Loki lines.
2. **`render`** (`fns/render.ts`) — headless Chromium (Cloudflare Browser Rendering) for
   JS-rendered pages `scrape` can't get. `residential:true` (default) routes the browser's
   subresources through the same residential proxy; `stealth:true` masks headless fingerprints.
3. **`render` backend:mac / render:mac** — a residential patched-browser (patchright) service
   that egresses from a home IP AND **solves active JS bot challenges** (Akamai sensor) that cf
   can't. Slower; used only for the hardest sites (Home Depot, Walmart). The mac tier
   auto-escalates to a **CapSolver**-equipped headed browser when a page looks blocked
   (`solve:true` forces it). Retail fns have a further last rung — a paid "web unlocker"
   (`unlocker-render.ts`, `UNLOCKER_API_*`) after cf + mac fail.

**Two hard SSRF/injection guards** run before any fetch (`proxy.ts`): `isBlockedTarget` rejects
private/loopback/link-local/CGNAT/ULA/metadata targets (the residential node sits *inside* the
home LAN), and `hasUnsafeHeader` rejects CR/LF in headers (the node builds a curl config from
them). These are **hard refusals, not fallbacks** — an internal target is never the caller's
intent. `render` re-applies `isBlockedTarget` (defense in depth, `render.ts:141`).

Every rung is **fail-closed on config**: absent `MAC_RENDER_*` / `UNLOCKER_*` / `TAILSCALE_*` →
that rung no-ops and the ladder degrades, never errors.

---

## 4. LLM safety — the `<<<DATA>>>` fence for untrusted material

**What.** Everything `llm()` (`ai.ts:48`) processes is scraped web pages or caller text — i.e.
UNTRUSTED, and could embed "ignore your instructions and…". The defense: the trusted instruction
rides in the **system role**; the untrusted content is **fenced as data** in the user role.

```ts
{ role: "system", content: `${system}\n\n${guardInstruction(task)}` },
{ role: "user",   content: wrapUntrusted(user) },
```

`wrapUntrusted` (`ai.ts:44`) wraps content in `<<<DATA>>> … <<</DATA>>>`, and `defuseMarkers`
splices a zero-width space into any embedded sentinel so the untrusted text can't break out of
its own fence. `guardInstruction` tells the model, in the trusted role, that anything between the
markers is data to process, never instructions to follow. This is the zero-trust principle
("every ingested byte is untrusted until fenced") made concrete. Used by recall/advise/summarize
and the dispatch-level `summarize` token-saver. Workers AI models are in `MODELS` (`ai.ts:6`).

---

## 5. Caching — content-addressed KV at dispatch

**What.** A fn opts in with `cacheable:true` (+ optional `ttl`). At `tools/call` dispatch
(`index.ts`), a cacheable fn gets a **content-addressed key** = `cacheKey(name, args)` (a hash of
the normalized name+args); a hit returns the stored value, a miss runs the fn and schedules a KV
write via `ctx.waitUntil` (off the response path). Caching lives entirely at the dispatcher — an
individual fn never touches the cache. Extras layered in at the same spot:

- **`fresh:true`** in args forces a cache-read miss (recompute on live data) while still writing
  the fresh result back — stripped before the fn sees it (`index.ts:213`).
- **`summarize:true`** runs the output through Workers AI to compress it; it changes the result,
  so it namespaces the key (`::summarize`).
- **Stale-while-revalidate** — a soft-TTL-expired entry is served immediately and refreshed in
  the background.
- **Single-flight coalescing** (`single-flight.ts`) — concurrent identical calls share one run +
  one cache write.
- Values are gzip-framed via the cache codec (`cache-codec.ts`) so compressed frames round-trip.

**Caveat — internal fn→fn calls bypass the cache.** Only the top-level `tools/call` dispatch
consults the KV cache. When one fn calls another directly in code (not through `handleRpc`),
there's no cache layer — it just runs. `pipe`/`batch` compose leaves server-side and hit each
step live.

**Taste: don't over-cache** (memory: `sux-engineering-taste`). Mark `cacheable` only where
re-fetch is expensive and the answer is stable; leave live/mutating/cheap fns uncached (they set
`noCache` on errors and mutations regardless).

---

## 5b. MCP Tasks — async long-running tool calls (KV-backed, first cut)

**What.** The MCP Tasks primitive (spec 2025-11-25+, experimental) lets a `tools/call` be
task-augmented (`params.task: {ttl?}`) instead of blocking one request/response for the whole run:
the server returns a `CreateTaskResult` immediately, then the caller polls `tasks/get` /
`tasks/result`, or `tasks/cancel`s it. `src/tasks.ts` is the KV-backed store + lifecycle
(`sux:task:<uuid>` keys, prefix-partitioned like everything else in `OAUTH_KV`); `index.ts`
wires it into `handleRpc` alongside the existing cache/single-flight dispatch — see
`TASK_CAPABLE_TOOLS` there (currently `pipe`/`batch`/`render`/`crawl`/`batch_fetch`/`shop`, the
fns that already run close to `FN_DEADLINE_MS`/`FANOUT_BUDGET_MS` in one request). This is the
first real primitive-level replacement for the ad-hoc "fire off a cron sub-job and forget"
pattern (`runSubJob`, `cron-heartbeat.ts`) that pipe/batch/render otherwise rely on being fast
enough to finish inside one request.

**Deliberate first-cut simplifications** (see the PR that introduced this + `tasks.ts`'s module
doc): single-tenant (no per-caller task ownership beyond the existing `ALLOWED_GITHUB_LOGIN`
gate — spec's context-binding requirement is moot here), task-augmented calls skip the KV
response cache/single-flight coalescing entirely (a task's own KV record IS its durable result),
`tasks/result` blocks via a bounded poll (`TASK_RESULT_MAX_WAIT_MS`, not a true indefinite block —
Workers requests aren't a good fit for that), and `tasks/cancel` is best-effort (flips the stored
status; cannot abort an in-flight `fn.run` already mid-execution in its isolate). Extend
`TASK_CAPABLE_TOOLS` as more fns want task augmentation — no dispatch change needed beyond that
one set.

---

## 6. Compression / transform — gzip default, token-pack for LLMs

**Storage compression** (`fns/_gzip.ts`). Every persistent store (R2 CAS, user KV, Dropbox
app-folder) runs text blobs through `maybeCompress`/`maybeDecompress`. Design = backward
compatibility: a compressed blob is a single `GZIP_MARKER` (0x00) byte + the raw gzip stream; a
read inflates ONLY that exact frame, so every pre-existing/raw object round-trips byte-for-byte.
Uses native `CompressionStream` (zero-dependency, present in workerd + Node ≥18). Skips
already-compressed/media MIME (`INCOMPRESSIBLE_CT` + magic-byte sniff) and anything < 256 bytes,
keeps the compressed form only when it's genuinely smaller, has a 64 MB decompression-bomb guard,
and never throws (degrades to storing raw). KV string variant uses a ` gz:` base64 prefix.
**gzip is the KISS default** (memory `sux-engineering-taste`); zstd only where it pays.

**Token-pack / declutter** — cutting tokens for LLM consumption:
- `pack` (`fns/pack.ts`) re-encodes a JSON array of records into header+rows TSV/CSV so keys
  aren't repeated per object. Delegates CSV to `_convert.toCsv` (carries the spreadsheet-formula-
  injection guard) rather than reimplementing quoting.
- `declutter` (`fns/declutter.ts`) — uBlock-style HTML cleaning (strip scripts/ads/trackers/
  consent wrappers/pixels) so downstream `summarize`/`readability`/`markdown` see content, not
  clutter. Regex-based, dependency-free, best-effort.

The dispatcher also **clamps output** (`clampResult`, `MAX_OUTPUT_CHARS = 1_000_000`) so no fn
can blow the caller's token budget; `raw` fns opt out.

---

## 7. Config / gating — env-flag feature gates, secretless where possible

**Everything optional is fail-closed on its config.** A fn whose credential is absent returns
`not_configured` and does nothing (never errors); a bot/loop whose flag is unset is a total
no-op. Two idioms:

- **Credential presence** — `env.X` absent → the fn/rung no-ops (`MAC_RENDER_*`, `UNLOCKER_*`,
  `FASTMAIL_TOKEN`, `TODOIST_TOKEN`, …). The `RtEnv` type in `registry.ts` documents each key's
  gate inline.
- **Two-stage toggle gates** for autonomous loops — the ENABLED/ACT (and KILL/PR/AUTOMERGE)
  pattern. The shared `flagOn` parser (`_self_improve.ts:61`, mirrored in `_mail_triage.ts` /
  `_briefing.ts`) treats empty/`0`/`false`/`no`/`off` as OFF, so an explicit falsey value can
  **never** flip a gate on (the bug bare `!!env.X` had):

  ```ts
  const flagOn = (v) => { const s = String(v??"").trim().toLowerCase();
    return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off"; };
  ```

  So a first deploy ships **dormant** and the first cycle is suggest-only by construction. Master
  enable + a separate act/side-effect flag + a KILL that always wins. These loops ride the daily
  cron (`index.ts` `scheduled`), are dynamically imported so the cron path pulls the surface only
  when armed, and are set via `wrangler secret` (NOT declared in `wrangler.jsonc`). This is the
  "ship gated-dormant, live switch = Colin's per-PR approval" deploy policy (memory
  `sux-deploy-autonomy-policy`).

- **Secretless PKCE** where a public client suffices — Mode B full-Dropbox
  (`fns/_dropbox-full.ts`) omits the app secret and uses a PKCE code_verifier/challenge flow, so
  the Worker holds no long-lived secret for that scope. Rate caps in autonomous loops are
  **compile-time literals** (`_self_improve.ts:87`), never read from env/KV, so no injected value
  can lift a cap.

---

## 8. Testing — vitest, exercise the real dispatch

- `npm test` → `vitest run`. Config: `vitest.config.ts`, `include: ["sux/src/**/*.test.ts",
  "sux/node/**/*.test.ts"]` — so `.claude/worktrees/*` (parallel-agent trees outside those globs)
  are never collected.
- **Test the real path.** `handleRpc` (`index.ts:141`) is split out of `rtServer.fetch` precisely
  so the full dispatch chain (unwrap → cache → normalize → deadline → run → finalize) runs
  end-to-end in `index.test.ts` without constructing the OAuth provider. Prefer driving a fn
  through dispatch over calling `run` in isolation.
- **Workflow/pipeline-as-text tests** — multi-step server logic (e.g.
  `security-review-workflow.test.ts`) is asserted as text transformations, and codec/guard
  round-trips (`_gzip.test.ts`, `cache-codec.test.ts`, `proxy.test.ts` SSRF cases) run the real
  native APIs.
- Almost every source file has a sibling `*.test.ts`. Match that when you add a fn.

CI gates (`.github/workflows/ci.yml`, all must pass): `type-check` (`tsc --noEmit`), `test`,
`check:node`, `gen:index` (index.ts committed + in sync), `wrangler deploy --dry-run`,
`lint:dispatcher-docs` (below).

- **Dispatcher doc-example params must match the real schema.** The five `namespaceFn()`
  front verbs (`vault`/`mail`/`files`/`calendar`/`contact`, `sux/src/fns/_namespace.ts`) carry
  worked example calls in their `description` string — `vault({action:'read', path})` and
  friends — that are the *only* documentation an LLM caller sees for that action's args. Three
  separate PRs (#202 `contact_search`, #205 `contact_create`/`update`, #206 `calendar`) landed
  where the example named a param the target tool's `inputSchema` didn't actually accept, so
  every call built from the doc failed. `npm run lint:dispatcher-docs`
  (`sux/scripts/lint-dispatcher-param-docs.mjs`) statically resolves each example's `action` to
  its real namespace-tool schema (in `vault-mcp.ts`/`mail-mcp.ts`/`files-mcp.ts`) and fails CI
  if a documented param isn't in `inputSchema.properties` (excluding the universal
  `stage`/`commit_token`/`force`/`confirm` args). Keep dispatcher descriptions accurate the
  first time — this catches drift the next time a target tool's schema changes but the
  front-verb description doesn't.

---

## 9. Goals & taste — why it's shaped this way

**North star** (`docs/design/north-star.md`): sux is "a personal AI Swiss-army-knife you weave
your life through" — do the right thing *and nudge toward it*, zero-trust (every side-effect
gated, every ingested byte fenced until proven safe, least-privilege creds), genuine novel
utility, never noise, bounded self-improvement. The `<<<DATA>>>` fence (§4), the SSRF guards
(§3), and the fail-closed toggle gates (§7) are that zero-trust principle in code.

**Engineering taste** (memory `sux-engineering-taste`): KISS / 80-20 / "obvious-good, not best."
Don't over-engineer or over-cache; gzip is the KISS default (zstd only if it pays); swiss-army-
knife pragmatism over frameworks.

**Working principle** (`CLAUDE.md`): **git is the undo, CI is the gate, review is the net** — so
we move fast and unblocked and lean on those three instead of asking permission. One change per
cycle; land it green before the next. Never commit to `main` (it auto-deploys to prod). Branch
per logical change; Conventional Commits with scope; rebase onto main, never merge back; integrate
via reviewed PR; run `/code-review ultra` before merging anything substantial.
