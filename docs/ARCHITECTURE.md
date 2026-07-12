---
title: sux — Architecture
status: shipped
cluster: infrastructure
type: reference
summary: "Canonical how-sux-works reference — one Cloudflare Worker serving a ~103-fn MCP surface (13 front verbs) plus vault/mail/files connectors behind one single-user OAuth gate; covers request lifecycle, subsystems, data model, and the design laws."
tags: [sux, infrastructure, shipped]
updated: 2026-07-11
related: ["[[Infrastructure-MOC]]", "[[architecture]]", "[[fn-registry]]", "[[oauth-gate]]", "[[fetch-ladder]]", "[[content-addressed-cache]]", "[[namespace-architecture]]"]
---

# sux — Architecture

> **What this is.** The canonical "how sux works" reference: one Cloudflare Worker that serves a universal MCP tool surface plus three personal-data connectors, all behind one single-user OAuth gate. This document is durable repo knowledge — written for humans reading the codebase *and* for the oracle/recall store.
>
> **Scope & provenance.** Synthesized from direct reads of the source under `/Users/colinxs/Code/sux-mcp` (paths below are repo-relative). Function counts and constants drift; regenerate the census with `npm run docs` and trust `sux/FUNCTIONS.md` / `src/fns/*.ts` over any prose here. Companion docs: `sux/docs/architecture.md` (shorter deep-dive, consistent with this) and `CLAUDE.md` (how-we-work, not what-we-build).

---

## Table of contents

1. [System in one picture](#1-system-in-one-picture)
2. [Request lifecycle](#2-request-lifecycle)
3. [The front door: verbs, leaves, and the `fn` escape](#3-the-front-door-verbs-leaves-and-the-fn-escape)
4. [The connector surface (`connectors.ts`)](#4-the-connector-surface-connectorsts)
5. [OAuth and single-user gating](#5-oauth-and-single-user-gating)
6. [The personal namespaces (vault / mail / files)](#6-the-personal-namespaces-vault--mail--files)
7. [Subsystems](#7-subsystems)
   - [7.1 Web ladder: search → scrape → render → unlocker](#71-web-ladder-search--scrape--render--unlocker)
   - [7.2 Research databases](#72-research-databases)
   - [7.3 Converters](#73-converters)
   - [7.4 Storage: KV / R2 / Dropbox / compression](#74-storage-kv--r2--dropbox--compression)
   - [7.5 The learning spine](#75-the-learning-spine-oracle--recall--preferences--advise--learn)
   - [7.6 Mail (JMAP / Fastmail + autonomous triage)](#76-mail-jmap--fastmail--autonomous-triage)
   - [7.7 Vault (git-backed Obsidian)](#77-vault-git-backed-obsidian)
   - [7.8 Fan-out: batch / pipe / batch_fetch](#78-fan-out-batch--pipe--batch_fetch)
8. [Function taxonomy](#8-function-taxonomy)
9. [Data model — persistent state](#9-data-model--persistent-state)
10. [Design decisions and conventions](#10-design-decisions-and-conventions)
11. [Numbers, constants, and limits](#11-numbers-constants-and-limits)
12. [Cross-cutting idioms](#12-cross-cutting-idioms)
13. [Key files index](#13-key-files-index)

---

## 1. System in one picture

One Cloudflare Worker (`sux/`) serves **four MCP connectors on one OAuth provider**:

| Path | Name | Plugin | Advertised | What it is |
|---|---|---|---|---|
| `/mcp` | sux | `sux-router` | yes | Public front door — ~103 `Fn` leaves, only ~13 advertised as front verbs |
| `/vault/mcp` | vault | `sux-vault` | no | Git-backed Obsidian vault (`colinxs/vault`) |
| `/mail/mcp` | mail | `sux-mail` | no | Ergonomic Fastmail (JMAP + CalDAV) surface |
| `/files/mcp` | files | `sux-files` | no | Dropbox blob workspace (Mode A app-folder / Mode B whole-account) |

All four share **one** GitHub-OAuth gate, **one** KV namespace (`OAUTH_KV`), **one** rate limiter (`MCP_RATE_LIMITER`), and **one** deploy. Adding a namespace costs a route + a plugin manifest, not new infrastructure. The `/mcp` front door is the **stateless query/compute plane** (holds no durable state so it can run anywhere); the three personal namespaces are stateful, each with its own verb vocabulary and **handle discipline** (list/search return references; exactly one deliberate read returns bytes).

```
Cloudflare Worker "sux"  (sux/src/index.ts = default export)
│
├─ PUBLIC pre-auth surface (handleObservability): /health /metrics /logs
│    /feedback /s/<uuid> (R2 blob stream) /llms.txt
├─ /admin/tick?job=…      bearer-gated manual cron trigger
│
└─ @cloudflare/workers-oauth-provider   (GitHub OAuth, single-user allowlist)
     defaultHandler = GitHubHandler   → /authorize /callback /register /token
     apiRoute       = CONNECTOR_PATHS → ["/mcp","/vault/mcp","/mail/mcp","/files/mcp"]
     apiHandler     = rtServer.fetch  → login allowlist → rate limit → path routing
                        ├─ /mcp        → handleRpc         (registry.ts FUNCTIONS)
                        ├─ /vault/mcp  → handleVaultRpc    (vault-mcp.ts)
                        ├─ /mail/mcp   → handleMailRpc     (mail-mcp.ts)
                        └─ /files/mcp  → handleFilesRpc    (files-mcp.ts)

Bindings (wrangler.jsonc): OAUTH_KV (state+cache) · AI (Workers AI) ·
IMAGES · R2 (bucket sux-mcp) · BROWSER (headless Chromium) ·
MCP_RATE_LIMITER (120/60s) · daily Cron 0 13 * * *
```

---

## 2. Request lifecycle

`fetch(request, env, ctx)` (`sux/src/index.ts`, default export) processes top to bottom:

1. **`handleObservability`** (`observability.ts`) — PUBLIC, pre-auth: `/health` `/metrics` `/logs` `/feedback` `/s/<uuid>` (R2 blob stream) `/llms.txt`.
2. **`POST /admin/tick?job=…`** — bearer-gated (`SUX_CRON_TOKEN`, constant-time `tokenEq`) manual cron trigger (`mail-triage | self-improve | maintenance`).
3. **`getOAuthProvider().fetch(...)`** — the `@cloudflare/workers-oauth-provider`, lazily constructed as a module-scope singleton so importing `index.ts` for tests never evaluates Cloudflare-runtime-only modules. `apiRoute` = `CONNECTOR_PATHS`; `defaultHandler` = `GitHubHandler` (runs `/authorize` `/callback` `/health` `/register` `/token` **before** the gate); `apiHandler` = `rtServer`, reached **only after** the provider has validated the bearer token and attached `ctx.props` (`{login, name, email, accessToken}`).

**`rtServer.fetch`** (`index.ts`) then:

1. **`isAllowedLogin(ctx.props?.login, env.ALLOWED_GITHUB_LOGIN)`** — single-user allowlist; 403 on any other GitHub login. This is what makes the whole surface single-user *on every request*, not just at token-mint time.
2. **`MCP_RATE_LIMITER.limit({key: login})`** — base 1 token/request, 429 on deny.
3. **Path routing** (exact or trailing-slash prefix against `CONNECTOR_PATHS`): `/mcp/connectors` or `/connectors` → discovery manifest; `/vault/mcp` → dynamic import + `handleVaultRpc`; `/mail/mcp` → `handleMailRpc`; `/files/mcp` → `handleFilesRpc`; else (`/mcp`) → `weightedRateLimit` then `handleRpc`.

### The front-door dispatcher (`handleRpc`, exported so it is testable without a real `Request`/OAuthProvider)

JSON-RPC 2.0 over a single-shot SSE response (`sseResponse`, `mcp-util.ts`):

- `initialize` → protocolVersion `2025-06-18`, `serverInfo.name: "research-tools"`.
- `notifications/*` → 202 no-op.
- `tools/list` → `frontToolList(FUNCTIONS)` — **only the front verbs** (~13), not all ~103 leaves.
- `tools/call` — the hot path:
  1. **`fn` escape unwrap** (`unwrapFnCall`, `registry.ts`): a `fn({name, args})` call is rewritten *in place* to a direct call on the named leaf **before** `findFn`/cache/normalize, so a leaf reached through `fn` is byte-identical to calling it directly (same cache key, same deadline, same weighted rate-limit cost). This same rule is shared by `weightedRateLimit` (`rate-limit.ts`), so an expensive fn cannot dodge its `cost` by hiding behind `fn`.
  2. **`findFn(FUNCTIONS, name)`** → JSON-RPC `-32601` if unknown.
  3. **Strip control flags** — `fresh` (cache-bypass) and `summarize` (post-run AI compression) are removed from the args object before the fn sees them (schemas are `additionalProperties:false`).
  4. **`checkArgs`** — reject pathological args (>256 KB JSON, >64 levels deep) before normalize/run; cheap DoS guard, recorded as an error call.
  5. **`normalizeArgs`** (skipped for `raw:true` fns) — folds fullwidth/styled Unicode to ASCII, strips BOM/zero-width/control chars from string args. Byte-exact fns (hash/encode/compress/qr/kv/batch/pipe/…) opt out via `raw`.
  6. **Per-request `rtEnv`** — a shallow clone of `env` with `_egress:{ctx, reqId}` for correlating outbound `smartFetch` hops in Loki without mutating the shared isolate `env` (so concurrent calls can't clobber each other's correlation id or `waitUntil` context).
  7. **Cache key** = `cacheKey(name[+"::summarize"], args)` (SHA-256 over stable-stringified `{fn, args}`) — only for `fn.cacheable` fns.
  8. **Stale-while-revalidate KV read** — `getWithMetadata` reads a `softExpiresAt` marker: fresh-serve, or stale-serve-and-background-refresh via `ctx.waitUntil`. Values unpacked through `cache-codec.ts` (transparent zstd/brotli frames).
  9. **Single-flight coalescing** (`single-flight.ts`, module-scope `inflight` Map keyed by cache key): concurrent identical calls (or a foreground miss racing a background SWR refresh) share ONE `fn.run` and ONE close path.
  10. **`withDeadline(name, FN_DEADLINE_MS=60_000, fn.run(rtEnv, args))`** — a hung fn *resolves* (never rejects) to a clean `isError` ToolResult on timeout; the real run keeps going in the background but its value is dropped.
  11. **`finalize()`** close path: normalize text → optionally `summarize` via Workers AI (only `summarize:true`, result ≥400 chars, best-effort, never throws) → `clampResult(…, MAX_OUTPUT_CHARS=1_000_000)` (raw fns opt out) → `deferCacheWrite` (never caches `isError`/`noCache`; write off the response path via `ctx.waitUntil`; `fn.ttl` overrides the global 3600 s TTL, +86 400 s stale grace).
  12. **`recordCall`** (`metrics.ts`) + **`shipToLoki`** (`grafana.ts`, best-effort) on every call, including rejects.
- Any other method → JSON-RPC `-32601`.

`checkArgs`, `clampResult`, `withDeadline`, and `FN_DEADLINE_MS` are all exported from `index.ts` and **reused verbatim** by `vault-mcp.ts` / `mail-mcp.ts` / `files-mcp.ts`, so the personal namespaces inherit the same deadline/size rails.

### `scheduled()` — the daily Cron Trigger (`0 13 * * *`)

`ctx.waitUntil(maintenanceTick)` (Kroger OAuth refresh, mail-triage tick, adblock-engine refresh — each independently try/caught, never throws) + `ctx.waitUntil(selfImproveTick)` (dormant unless `SELF_IMPROVE_ENABLE`).

`oauthErrorResponse` maps OAuth-library exceptions to clean JSON 400 (client mistake — bad `redirect_uri`/CSRF/state, pattern-matched from the message) or an opaque 500 (message never leaked) instead of Cloudflare's raw 1101 page.

---

## 3. The front door: verbs, leaves, and the `fn` escape

`registry.ts` owns the front-door projection.

- **`Fn` type**: `{name, description, inputSchema, cacheable?, cost?, ttl?, raw?, surface?, annotations?, run}`. `description` is shown **verbatim** in `tools/list` — it is the fn's docs. `cost` feeds the weighted rate limiter so expensive tools (render/Kagi/Workers-AI) drain the budget faster.
- **`FRONT_VERBS`** — the curated set actually advertised by `tools/list`: `sux, fn, search, scrape, shop, ingest, recall, oracle, pipe, batch, store, preferences, issue` (13). A fn counts as front either by membership here or by self-declaring `surface:"front"` (only `sux` and `fn` do so today).
- **`frontToolList(fns)` = `toolList(fns.filter(isFrontVerb))`** — this is what `tools/list` returns, preserving importance ordering.
- **Everything else (~90 leaves) is still fully dispatchable** — by its own name directly, or via `fn({name, args})` — and **discoverable** via the `sux()` capability map (`fns/_surface.ts`, which also renders the public `GET /llms.txt`) or `sux({domain:"shop"})` for a one-domain zoom. This is the "verbs + fn escape" design: a mobile-legible `tools/list` (~13 items) without losing any capability. The hiding is a **visibility filter only** — dispatch is unaffected.

**`fn` — the escape hatch** (`fns/fn.ts`, `surface:"front"`): `fn({name, args})` invokes any registered leaf. It cannot call itself (`bad_input` if `name === "fn"`) and requires `args` to be a plain object if present. `fns/fn.ts` is the standalone fallback implementation; the dispatcher's inline `unwrapFnCall` is the hot path. Both re-run the same Unicode fold so an obfuscated inner name (`fn({name:"ｒｅｎｄｅｒ"})`) can't slip past cost-accounting yet resolve later.

**`sux` — the self-describing map** (`fns/sux.ts`, `surface:"front"`): `sux()` returns `renderOverview` (all domains + namespaces + how to reach anything); `sux({domain:"shop"})` returns `renderDomain` (one line per leaf for that domain). `cacheable:true`, read-only/idempotent. It exists because **skills don't sync to mobile** — on a phone the agent only sees the bare `tools/list`, so `sux()` is the fallback way to get the whole capability map.

**`TOOL_ANNOTATIONS`** (`registry.ts`) — MCP 2025-06-18 tool annotations (`readOnlyHint / destructiveHint / idempotentHint / openWorldHint`), centrally tagged by name (a fn's own `annotations` field wins). Three buckets:
- `READ_WEB` (read-only, reaches live web/3rd-party): search/fetch/scrape, all research DBs, all retail, `places/people/coingecko/youtube/watch/linkedin/facebook`, `recall/oracle`.
- `READ_LOCAL` (read-only, no network): parse/extract fns over provided input, AI text transforms (`summarize/translate/classify/redact/ocr`), format converters, `kv_get/kv_list`.
- `WRITE_DESTRUCTIVE`: `store, ingest, dropbox, kv_put, kv_delete` (drives a client confirm prompt). Mixed read/write namespace tools (`jmap`, `obsidian`, `todoist`) are deliberately left unannotated rather than claim a hint they can't honor.

**Machine-readable failure taxonomy — `FAIL_CODES`** (`registry.ts`): every fn's failure path returns one of 8 fixed codes via `failWith(code, text)`, prefixed as `[code]` in the response text and carried as a structured `errorCode`, so callers/Grafana can group by cause: `not_configured`, `blocked`, `timeout`, `rate_limited`, `not_found`, `upstream_error`, `bad_input`, `layout_change`.

**Registry generation.** `sux/src/fns/index.ts` (`FUNCTIONS: Fn[]`) is **generated** by `sux/scripts/gen-index.mjs` (`npm run gen:index`) — it scans `sux/src/fns/*.ts` for `export const X: Fn`, ordered by `scripts/importance.mjs`. Adding a fn = create `fns/<name>.ts` exporting `export const <name>: Fn`, then run `npm run gen:index && npm run docs` and commit both (`index.ts` and `sux/FUNCTIONS.md`). Hand-editing either fails CI. Files under `fns/` prefixed `_` (`_util.ts`, `_jmap.ts`, `_dropbox-full.ts`, `_caldav.ts`, `_mail_triage.ts`, `_self_improve.ts`, `_surface.ts`, `_adblock.ts`, `_source.ts`, `_examples.ts`, `_feedback.ts`, `_gzip.ts`, `_markup.ts`, …) are **shared internals**, not `Fn`s — `gen-index.mjs` skips them.

---

## 4. The connector surface (`connectors.ts`)

`sux/src/connectors.ts` is deliberately the ONE place enumerating sux's MCP connectors, replacing three formerly hand-synced places (index.ts routing, the discovery manifest, `marketplace.json`):

```ts
export const CONNECTORS: Connector[] = [
  { path:"/mcp",       name:"sux",   plugin:"sux-router", summary:"…" },                  // advertised (default)
  { path:"/vault/mcp", name:"vault", plugin:"sux-vault",  summary:"…", advertised:false },
  { path:"/mail/mcp",  name:"mail",  plugin:"sux-mail",   summary:"…", advertised:false },
  { path:"/files/mcp", name:"files", plugin:"sux-files",  summary:"…", advertised:false },
];
export const CONNECTOR_PATHS = CONNECTORS.map(c => c.path); // feeds BOTH OAuth apiRoute AND per-path dispatch
```

- `CONNECTOR_PATHS` is the OAuth `apiRoute` — a namespace is authorized purely by appearing here; it is **never filtered by `advertised`**.
- `advertised:false` on vault/mail/files means: still routed, still OAuth-gated, just **hidden from the default `GET /mcp/connectors` manifest** — reachable one deliberate `?all=1` away, mirroring the `fn` escape's "one call away" philosophy. `buildManifest(origin, counts, {all})` is a pure, unit-tested function (`connectors.test.ts` covers both views).
- `connectorCounts()` dynamically imports `./fns`, `./vault-mcp`, `./mail-mcp`, `./files-mcp` ONLY to read their tool-count exports for the manifest — keeping those modules lazy on the hot `tools/call` path (they're dynamically imported again, per-request, in the actual per-path dispatch).
- **`connectors.test.ts` is a drift guard**: `advertised !== false` connectors must have a `plugin` that exists in `.claude-plugin/marketplace.json`; retired (`advertised:false`) connectors must have NO `plugin` field. The marketplace currently ships only `sux-router` (the `/mcp` connector + `sux` skill) and `sux-life` (memory-only skill, no connector). The `sux-vault`/`sux-mail`/`sux-files` plugin *directories* still exist under `plugins/` but are not listed in the marketplace — consistent with those namespaces being `advertised:false`.

> **Direction locked with Colin (2026-07-11):** consolidate to ONE connector (`/mcp`); the mail/vault/files connectors/plugins go dormant (routed, not deleted) once the front door fully lands.

---

## 5. OAuth and single-user gating

- **Provider**: `@cloudflare/workers-oauth-provider`, constructed lazily (`getOAuthProvider()`) so tests importing `index.ts` don't eval runtime-only modules. Endpoints: `/authorize`, `/register`, `/token`; `defaultHandler` = `GitHubHandler`; `apiHandler` = `rtServer`; `apiRoute` = `CONNECTOR_PATHS`.
- **`GitHubHandler.fetch`** (`github-handler.ts`) handles the pre-auth surface: `GET /health` (public status page, heavily redacted via `redactPublicHealth`, KV-cached 60 s), `GET/POST /authorize` (renders/consumes an approval dialog with CSRF cookie protection via `workers-oauth-utils.ts`), `GET /callback` (exchanges the GitHub `code`, fetches the user, **enforces `isAllowedLogin` a second time** before `completeAuthorization`, storing `{accessToken, email, login, name}` as `Props` on the issued token).
- **`isAllowedLogin(login, raw)`** (`utils.ts`) — parses `ALLOWED_GITHUB_LOGIN` (comma-separated, case-insensitive) into a Set and checks membership. Enforced BOTH at `/callback` (mint time) and again at the top of `rtServer.fetch` (every request, using `ctx.props.login`). This single check is what makes the entire ~103-tool + 3-namespace surface single-user *by construction* — a stolen or forged token for anyone else is rejected on every call.
- **OAUTH_KV** state: `oauth:state:<token>` (CSRF/state, single-use: read-then-delete) plus the provider library's own opaque grant/token/client keys (this is why the binding is named `OAUTH_KV` and why `kv_get/kv_put` blanket-refuse keys starting with `oauth`).

---

## 6. The personal namespaces (vault / mail / files)

`/vault/mcp`, `/mail/mcp`, `/files/mcp` are **separate MCP server implementations** (`vault-mcp.ts`, `mail-mcp.ts`, `files-mcp.ts`), each dynamically imported per-request from `rtServer.fetch`, each riding the SAME OAuth gate/props/rate-limiter as `/mcp` — "a second/third/fourth connector, no second provider." Each defines its own small `Tool` type (`{name, description, inputSchema, run}`) and its own `handle*Rpc(env, ctx, rpc, bodyLen)` — **not** `Fn`/`FUNCTIONS`/`registry.ts` (that registry is `/mcp`-only). They reuse `checkArgs`/`withDeadline`/`FN_DEADLINE_MS` from `./index` and `sseResponse`/`JsonRpc` from `./mcp-util`.

**Why namespaces are kept OUT of the front-door `FUNCTIONS` list** (per `_surface.ts`): they carry their own verb vocabulary and a **handle discipline** — list/search verbs return references (ids + light metadata), never bodies; exactly one deliberate read per item returns byte content. This is architecturally distinct from the front door's stateless "leaf in, ToolResult out" model. Slogan: *"100 items = a few calls, zero bytes in context."*

- **vault** (`vault-mcp.ts`) — git-backed Obsidian vault, our rolled-own obsidian-web-mcp; every write a revertible commit; KV-cached. See §7.7.
- **mail** (`mail-mcp.ts`) — ergonomic Fastmail surface compiling to the raw `jmap` conduit; drives Fastmail CalDAV (`_caldav.ts`) for calendar/tasks. See §7.6.
- **files** (`files-mcp.ts`) — Dropbox blob workspace. Mode A app-folder / Mode B full-account. See §7.4 and §10.8. Rule: *"markdown → vault, blobs → files."*

**Shared safety primitives** across mail/files (not used by the stateless `/mcp` front door):
- **`stage.ts`** — a stage-then-commit guard (`staged()`). `STAGE_KINDS` is a fail-closed registry keyed by verb "kind": `irreversible:true` auto-stages (caller gets `{preview, commit_token}`, must re-call with the token or `force:true`); `irreversible:false` auto-mutates (reversible creates/updates just run). A `kind` with no entry throws rather than silently defaulting.
- **`ledger.ts`** — content-fingerprinted write logging / idempotency (`fingerprint`, `ledger`, `markIfNew`) used by both vault and files.

---

## 7. Subsystems

Every leaf hangs off the `handleRpc` dispatch chokepoint (§2). The subsystems below are the notable clusters.

### 7.1 Web ladder: search → scrape → render → unlocker

An escalation ladder from cheapest to most powerful.

**Search** (`fns/search.ts`, `fns/web_search.ts`, `src/kagi.ts`):
- `search` (front verb) — Kagi only, richest scoping (`include/exclude_domains`, `time_relative`, `after/before`, `file_type`, `lens_id`); `remember:true` mirrors query+snippet into the vault KB fire-and-forget.
- `web_search` (leaf) — multi-engine: `kagi` (default, keyed), `ddg` (keyless, scraped via residential proxy — the cheap default), `google` (keyless but JS-gated → renders the live SERP through the `render` **mac** backend and parses post-JS HTML — no third-party SERP API), `brave` (keyed). `engine:"all"` fans every configured engine concurrently (`Promise.allSettled`), merges by normalized URL with consensus ranking; `summarize:true` map-reduces the pool via Workers AI. `tavily` and `exa`/`find_similar` are separate fns, not folded into `web_search`'s engine list.

**Scrape** (`fns/scrape.ts`) — plain fetch through `smartFetch` (residential proxy with direct fallback), no JS execution. Cheapest rung.

**Render** (`fns/render.ts`) — headless-browser rung with two backends:
- `backend:"cf"` (default) → `src/cf-render.ts`: `@cloudflare/puppeteer` against the `BROWSER` binding. `residential:true` (default) intercepts every subresource and re-issues it through `smartFetch` (the *browser's* traffic egresses from a home IP, not just the top-level nav); `stealth:true` (default) sets a realistic UA/viewport/accept-language and masks `navigator.webdriver`; `block_resources` aborts image/font/stylesheet/media before nav (ignored for screenshot/pdf). Outputs html/text/screenshot/pdf; binary delivered via content-addressed `/s/<uuid>` (R2) or inline base64.
- `backend:"mac"` → `src/mac-render.ts`: a residential **patched-Chromium** (patchright) node reached over Tailscale Funnel, HMAC-signed (`hmacHex(ts\npayload)`, ±300 s freshness window). The **only** tier that solves active JS bot challenges (Akamai `_abck` sensor, PerimeterX press-and-hold) via a CapSolver-equipped headed tier (`solve:true` forces it). Own circuit breaker (`macBreaker`: 5 consecutive full-timeout failures → 30 s open, half-open probe after). `waitUntil` vocabulary differs: cf/Puppeteer uses `networkidle0/2`; mac/Playwright uses `networkidle` (mac-render normalizes `networkidle[02]` → `networkidle`).

**Retail escalation ladder** (`src/retail-render.ts`) — the resilient wrapper the retailer fns call: **cf first, mac fallback** (`preferMac` flips for gesture/captcha-first sites). Both legs run inside `FN_DEADLINE_MS` (`FIRST_LEG_MS=25 s`, `SECOND_LEG_MS=12 s`, mac +15 s margin). **`looksBlocked()`** is the canonical bot-wall detector — a marker regex (Access Denied, sec-cpt, Pardon Our Interruption, px-captcha, Just a moment, Incapsula, Reference #…), no blanket length check by default; a "successful" fetch of a challenge page is treated as a ladder failure so it escalates instead of returning as content.

**Last rung — paid unlocker** (`src/unlocker-render.ts`): a Bright Data / Zyte / Oxylabs-style hosted residential-IP + challenge-solving HTTP endpoint (`UNLOCKER_API_URL/KEY`). Fail-closed (unset → `{ok:false}`, never throws) — the rung an operator arms per-retailer when cf+mac both fail a hard wall (Home Depot / Costco Akamai). See §10.6 (Mac-retire) for why this replaced the home Mac.

**Proxy transport** (`src/proxy.ts`) underlies scrape/render/most fetch-outs: `smartFetch()` — SSRF guard (`isBlockedTarget`/`isPrivateIp`: blocks loopback, private, CGNAT, link-local, metadata, IPv4-mapped IPv6; DNS-rebinding re-checked node-side), header-injection guard (CR/LF in header name/value), smart routing (`willProxy`/`isDirectHost` — Kagi/DoH/IP-geo APIs skip the proxy since datacenter IPs aren't blocked there), binary-safe (base64 round-trip, refetch-direct if a proxy mangles bytes), bounded retry with jitter + `Retry-After` honoring (`withRetry`, 3 attempts, on 408/429/502/503/504). Route accounting (`FetchRoute`: proxied/direct/proxy_fallback/binary_refetch) feeds observability. The Tailscale node itself lives outside the Worker: `sux/node/server.mjs` (fetch endpoint + SSRF re-check) and `sux/mac-render/render_server.py` (patchright + CapSolver).

**`product_search`** (`fns/product_search.ts`, leaf) fans one `term` across `kroger, walmart, homedepot, amazon, lowes, costco, ace` concurrently (`Promise.allSettled`, per-retailer isolation into `errors[]`), merging into one normalized product list. `shop` (front verb) is the curated front-door wrapper over the same retailer set.

### 7.2 Research databases

Each its own `fns/<name>.ts`, keyless where the upstream allows, thin regex/XML readers rather than full parsers (arXiv's Atom is "regular enough"): `arxiv`, `pubmed`, `openalex`, `crossref`, `semantic_scholar` (`S2_API_KEY` optional), `clinical_trials`, `stackexchange` (`STACKEXCHANGE_KEY` optional), `reddit` (app-only OAuth). `citation` and `find_similar` round out the domain. All tagged `READ_WEB` (read-only, open-world).

### 7.3 Converters

Format transforms, mostly pure/local (no network), all `READ_LOCAL`: `markdown`, `html` (+ `_markup.ts` `htmlToMd`, shared with `ingest`), `csv`, `json`, `xml`, `yaml`, `readability` (Mozilla-style article extraction, used by `oracle`'s HTML path), `tables`, `metadata`, `contacts`, `entities`, `select`, `grep`, `extract`, `fillable` (PDF form fill), `pdf` (build/merge/split), `ocr`, `image_convert`, `subtitles`, `feed` (RSS/Atom), `sitemap`, `robots`, `redirects`, `wayback` (archive.org snapshots), `voice`/`fontcase` (text styling), `hash`, `encode`, `compress`, `archive` (zip/tar), `pack`/`declutter` (token-packing / boilerplate stripping for LLM context). Text/AI transforms (`summarize`, `translate`, `classify`, `redact`) go through Workers AI but mutate nothing.

### 7.4 Storage: KV / R2 / Dropbox / compression

**Two distinct compression systems — do not conflate:**
- **Cache-layer** (`src/cache-codec.ts`) — every KV *cache* write. Tagged-frame: prefers `zstd` (`node:zlib`, runtime-gated), falls back to `brotli`. 5-byte magic `"sxz1"+codec-tag`. A decode mismatch (e.g. a prod isolate without zstd reading a dev-written zstd frame) throws and is treated as a cache **miss**, not a crash.
- **Content-layer** (`fns/_gzip.ts`) — every *persistent* store (R2 blobs, user KV records, Dropbox app-folder). Native `CompressionStream`. Frame = `[0x00, gzip]` for binary; `"\0gz:" + base64(gzip)` for KV strings. Compresses only when smaller (`shouldCompress`: ≥256 bytes, not already-compressed/media MIME, magic-sniffed), guards against decompression bombs (64 MB cap). Reused by essentially every JSON-blob-in-KV writer: `store.ts`, `_util.ts putBlob`, `kv_get/kv_put`, `oracle.ts`, `preferences.ts`, `_feedback.ts`, `_mail_triage_log.ts`, `_self_improve.ts`.

**R2 object store** (`fns/store.ts`, `fns/_util.ts putBlob`/`deliverBytes`) — content-addressed by sha256 (`cas/<sha256>`, Nix-store-style dedup). Each `put` mints a short-uuid KV handle (`store:<uuid>` → `{key, content_type, size, sha256, expiry?}`) resolvable at `GET /s/<uuid>`. Optional `ttl_seconds` self-expires the *handle* (blob persists, possibly shared). `store op:delete` removes only the KV handle. This is the shared write path every binary-output fn goes through (render screenshots/pdfs, mail blob downloads, `pdf` output). A second R2 key family: `adblock/engine.bin` (`_adblock.ts`), the compiled cosmetic-adblock engine rebuilt staleness-gated by the daily cron.

**Dropbox — two independently-gated scopes** sharing plumbing (`fns/_dropbox-core.ts`): token mint (refresh → short-lived access token, KV-cached, TTL = `expires_in - 60`), confidential (app secret → Basic auth) or public/PKCE support, 401 self-heal.
- **Mode A** (`fns/dropbox.ts`) — App-folder scoped (`/Apps/<app>/` only), the safety wall for routine blob storage. Token at `sux:dropbox:token`.
- **Mode B** (`fns/_dropbox-full.ts`) — whole-account, a **separate** credential (`DROPBOX_FULL_*`) at the **distinct** key `sux:dropbox:full:token`, dormant unless `hasDropboxFull(env)`. Read-only in the base client (`searchFull`/`listFull`/`readFull`); oversize reads return a **temporary** (~4 h, non-public) link, never a permanent share (adversarial-review-driven: a full-scope credential must never mint a durable public URL). Mutations route through `stage.ts` plus a firewall: rev-conditioned writes, a protected-prefix deny-list (`DROPBOX_FULL_PROTECT_PREFIXES`), account-root refusal, and `/.sux-trash` recoverability. See §10.8.

**KV primitives**: `kv_get`/`kv_put`/`kv_list`/`kv_delete` — the raw namespace-agnostic user surface, guarded (§9.6). Every internal stateful fn builds its own prefixed key-space on `OAUTH_KV` directly rather than through these verbs.

### 7.5 The learning spine (oracle / recall / preferences / advise / learn)

One shared pattern: **KV-backed rolling exemplar set → re-distill via guarded `llm()` → store**. The guarded `llm()` (`src/ai.ts`) fences caller-/web-supplied material in `<<<DATA>>>` markers so it can never hijack the system-role instruction — every one of these fns treats taught/ingested material as **untrusted**.

- **`oracle`** (`fns/oracle.ts`, front verb) — per-`topic` KB (`sux:oracle:<topic>`). `learn`: resolve `knowledge` (text or fetched+readability'd URL) → distill one chunk → append to a rolling set (last 15) → **re-distill the whole set** into one coherent KB each time. `answer`: LLM answers using own knowledge + the KB (KB preferred). `get|list|forget` are pure-KV.
- **`preferences`** (`fns/preferences.ts`, leaf) — identical shape for a writing-*voice* profile (`sux:prefs:`, distinct from oracle): `learn` appends a style exemplar (last 20), re-distills a ≤200-word style spec; the `voice` fn applies it.
- **`_examples.ts`** (substrate, no fn wrapper) — a labeled `{input→label}` KV store (`sux:learn:example:`), each entry carrying its bge embedding for brute-force cosine kNN (`classifyKnn`). Every write tags a `batch` id for bulk-undo (`deleteBatch`). This is the "taught by example" classifier substrate behind the `learn` fn and `recall`'s `learned` source.
- **`recall`** (`fns/recall.ts`, front verb) — "what do I know about X" fan-out across **five independent sources** (`gatherRecall`, exported and reused by `advise`): `vault` (obsidian search+read top-3), `files` (Mode B Dropbox content search, small hits inlined ≤200 KB else cited by handle), `mail` (one JMAP round-trip: `Email/query` text filter → `Email/get`), `web` (a plain `search` call), `learned` (kNN against `_examples`). Each source `Promise.allSettled`-isolated — an unconfigured/failing store degrades to "unavailable" in `status`, never fails the whole call. Read-only; never writes.
- **`advise`** (`fns/advise.ts`, leaf) — a **three-tier authority-gated** advisor on top of the spine: tier 1 = an ingested authoritative source (chunked + embedded via `_source.ts`, retrieved by kNN, always-injected distilled Profile) GOVERNS; tier 2 = `recall`'s raw gathered materials ground it; tier 3 = the model's general knowledge may only elaborate where tier 1 is silent, never contradict — conflicts surfaced inline (`⚠ Conflict: …`), gate defers to tier 1. `action:ingest` reuses `ingest.ts` to land the source as a git-versioned vault note (provenance), then chunks/embeds and (re)distills the domain Profile. Explicitly "aligned-with, never a replacement-for professional care."
- **`_self_improve.ts`** (cron-driven, `selfImproveTick`) — consumes the `issue`/`suggest` feedback backlog (`_feedback.ts`) since a KV cursor, classifies each into a `Lane` (security > feature > cleanup > refactor > fix > ambiguous-defaults-to-security), and routes: `fix/refactor/cleanup` get a stub PR + an `@claude fix this` hand-off comment (the existing autofix loop authors the real diff); `security/feature` get a labeled PR only, no auto-author. **Three independent fail-closed gates, in order**: `isKilled` → `hasSelfImprove` → `canOpenPr` (needs `SELF_IMPROVE_PR==='on'` exactly, else review-only). Compile-time rate caps (`SELF_IMPROVE_DAILY_CAP=3`, `MAX_OPEN_SELF_IMPROVE_PRS=5`) — never read from env/KV, so no injected value can raise them. Untrusted feedback is `defang()`'d and fenced with an `UNTRUSTED_BANNER` everywhere it's echoed. Never merges; never edits workflow/CI files.

### 7.6 Mail (JMAP / Fastmail + autonomous triage)

**Engine** (`fns/_jmap.ts`) is the shared substrate behind both the raw `jmap` conduit fn and the ergonomic `mail-mcp.ts` verbs (`mail_search`, `mail_read`, `mail_send`, `mail_draft`, `mail_archive`, `mail_move`, `mail_masked`, `contact_*`, `cal_*`/`task_*` via CalDAV). Handles: Session discovery + KV cache (`sux:fastmail:session`, TTL 3600 s) + self-heal on 401/apiUrl-move (`__reauth__`/`__rediscover__` sentinels), capability-URN derivation (`deriveUsing` — over-declares and unions, never suppresses a required cap), `accountId` routing generalized across non-primary capabilities (MaskedEmail), the limit-safe POST (server `maxCallsInRequest` respected — refuse-and-teach, no auto-split), anchor-based query pagination with a resumable base64 cursor (`runPaginate`, bounded, degrades to `partial:true` rather than erroring on a live-mailbox anchor loss), and blob upload/download (upload accepts only `/s/<uuid>` CAS refs or base64 — **never an https URL**, an explicit SSRF guard). Two **write gates** (`enforceGates`): `allow_send:true` required for any `EmailSubmission/set` create (back-reference-aware — a `#`-prefixed mutation arg counts as present); `allow_destroy:true` required for any irreversible mutation (`destroy`, `Mailbox/set onDestroyRemoveEmails`, `VacationResponse/set`, mail-rule/forwarding changes). Whole surface is `cacheable:false` (mail bodies + Session PII never touch the response cache).

**Autonomous triage bot** (`fns/_mail_triage.ts`, `_mail_triage_log.ts`) — the daily-cron classify → gate → act → log → digest loop. **Two-stage fail-closed gate** (distinct from JMAP working at all): `MAIL_TRIAGE_ENABLED` unset → total no-op; set-but-`MAIL_TRIAGE_ACT` unset → classify+suggest+digest only, mailbox never mutated. Classifier is a rules-stub (sender-domain + subject/preview regex, `classifyMessage`) behind a pluggable `classify()` seam for a future kNN model. **Auto-act allow-list** (`AUTO_ACT_OPS`): `label:add/remove, archive, unarchive, undelete` only — every op has a safe inverse; junk-MOVE and delete are **structurally unrepresentable** (`TriageOp`'s type union has no move-to-junk/delete variant), so a smuggled destructive action isn't possible even in principle. `CONFIDENCE_THRESHOLD=0.75` gates every auto-act. Idempotent per message via `ledger.ts` (`led.seen`/`led.mark`) — marks-seen only AFTER a definitive decision (so a transient failure retries next cycle) and persists the undo-log entry BEFORE marking seen (so a crash mid-cycle can't produce an acted-but-unlogged message). Digest appended to the vault daily note (`Daily/<date>.md`) with a one-call undo hint (`mail_triage {action:"undo", cycle_id}`). Rides the same daily Cron as `maintenanceTick` and `selfImproveTick`.

### 7.7 Vault (git-backed Obsidian)

`fns/obsidian.ts` is the backend client — three backends behind one `action` verb-set (`list|read|search|append|write|edit|delete[|tools|call]`):
- **`git`** (default) — GitHub Contents API against `OBSIDIAN_VAULT_REPO`; every write a commit (**git history is the undo**, no confirm gate for append/write/edit — only `vault_delete` requires `confirm:true`). KV read-through cache validated against the vault's HEAD sha (`vaultHead`, rechecked ≤ once/60 s, trusted stale up to 10 min while GitHub's ref endpoint errors). `readGitContents` always uses the raw-refetch path for >1 MB notes (the Contents API omits inline content past 1 MB — a naive decode would see an empty body and let `append` destroy the note). Optimistic concurrency: `edit`/`vault_patch` PUT with the read-time sha, so a concurrent write collides (409) instead of clobbering.
- **`remote`** — Obsidian's Local REST API over a public Tailscale Funnel URL (`OBSIDIAN_REMOTE_URL/KEY`) — real-time to the *live* vault. Also wraps the vault plugin's own MCP server (`action:tools/call`). The **only** backend with real full-text search (`/search/simple/`) — git backend's "search" is GitHub code search, which **returns empty on a private repo** (this is why there's no dedicated `vault_search` verb — `recall`'s vault source prefers `remote`).
- **`local`** — stub; the Worker can't reach localhost/LAN (SSRF guard) — always redirects to `remote`.

`badVaultPath()` refuses `..`/dot-prefixed path segments on every mutating action — the write-scoped `GITHUB_TOKEN` must never reach `.github/workflows` or `.obsidian` config through this fn.

**`/vault/mcp` connector** (`vault-mcp.ts`) — the curated surface (`vault_read/write/append/edit/delete/capture/batch_append/daily_read/daily_append/backlinks/query/patch/tags`), built on `obsidian.ts` + `vault-graph.ts` (frontmatter parsing, wikilink extraction, JsonLogic-lite filter eval for `vault_query`, heading/block/frontmatter-field patching for `vault_patch`). A **derived whole-vault index** (`buildVaultIndex`/`vaultIndex`, `{path, fm, tags, links}` per note) is cached in KV keyed by HEAD sha so `backlinks`/`query`/`tags` do one KV read instead of ~500 GitHub round-trips; `INDEX_MAX=5000` notes; `truncated` flags either an over-cap vault OR any per-note read that failed mid-scan (so a partial answer is never mistaken for complete); falls back to a direct per-note scan (`scanVaultDirect`) when KV/HEAD is unavailable. `vault_capture` explicitly **allowlists** which fields it forwards to `ingest` (never the raw args) — a stray `path` key from a model would hit ingest's explicit-path overwrite branch and break the "never overwrite" promise.

**`ingest`** (`fns/ingest.ts`, front verb) — the intake half: exactly one of `url|text|query` → a provenance-stamped markdown note in `Inbox/` (git commit = undo), never overwriting (auto-disambiguates `-1`, `-2`…) unless an explicit `path` is given. Blob routing for non-markdown URL captures: ≤1 MB → committed into the vault repo as an attachment; larger (or `blobs:"dropbox"`) → Dropbox Mode A (falls back to R2 if Dropbox is unconfigured/fails). Optional `summarize`/`compress` degrade to verbatim if Workers AI is down (a capture that lands beats one that bounces).

### 7.8 Fan-out: batch / pipe / batch_fetch

Both `batch` and `pipe` are `raw:true` (the dispatcher's normalize/clamp boundary would corrupt byte-exact nested fns like hash/encode/kv/compress) and reproduce that boundary themselves per inner call. Both dynamically `import("./index")` to break the static cycle (`index.ts` imports every fn).

- **`batch`** (front verb) — **MAP**: one tool over many argument sets, two input forms (`calls:[…]` explicit, or `over:[…]`+`args:{template}` with `{{item}}`/`{{item.path}}` substitution). Bounded concurrency (8), `MAX_CALLS=100`, a tighter `MAX_NESTED_CALLS=25` when the mapped tool is itself a fan-out (`pipe`/`batch_fetch`/`crawl`) so work-product can't multiply unbounded. **REDUCE**: `none|concat|summarize` (text-level) or `reduce_with:{tool,args}` (tool-based — e.g. merge mapped PDFs via `pdf`, with `{{items}}`/`{{items.path}}` injected). Time-budgeted (`FANOUT_BUDGET_MS=50 s`) via `pool()` — un-run slots at the deadline return `[timeout]`-marked failures rather than losing the whole batch.
- **`pipe`** (front verb) — **COMPOSE**: `steps:[{tool,args}]`, each step's text output threads into the next via `{{prev}}`/`{{prev.path}}` (JSON-parsed lazily once per step). Stops at the first failing step. `MAX_STEPS=25`; `pipe`/`batch`/`batch_fetch`/`crawl` are refused *as steps* (recursion / unbounded-product guard). Step-preview truncation (500 bytes) in the returned `steps[]`, but the full text still threads via `{{prev}}` and lands in `output`.
- **`batch_fetch` / `crawl`** — the underlying ~100-wide fetchers `batch`/`pipe` treat specially as "nested fan-out tools"; their width is what makes the amplification math matter.

---

## 8. Function taxonomy

**Source-of-truth chain**: one `Fn` per `sux/src/fns/<name>.ts` → the generated `FUNCTIONS` array in `sux/src/fns/index.ts` (`npm run gen:index`, ordered by `scripts/importance.mjs`) → projected into the MCP surface by `registry.ts` → the human table in `sux/FUNCTIONS.md` (`npm run docs`, `scripts/gen-docs.mjs`). Both generators must be re-run and committed after touching any fn or CI fails.

As of `main`: **~103 functions, ~101 with tests** (`fn` — a pure delegator — and `mail_triage` — exercised via `_mail_triage.ts` — are the two untested-by-convention).

> **Drift note.** A pending refactor folds `geo_fetch` into `proxy`; once it lands the count drops by one and `geo_fetch` disappears. Always trust the generated `FUNCTIONS.md` over any count quoted here.

### Two parallel, independently-maintained taxonomies (don't confuse them)

**A. `gen-docs.mjs` → `CATEGORIES`** (17 buckets) — drives `FUNCTIONS.md` only. Every fn appears in exactly one category; the script has a **forward guard** (category references a nonexistent fn → build fails) and a **reverse guard** (a fn in no category → build fails), so this list can't silently rot:

| Category | Members (from `main`) |
|---|---|
| Net / transport | proxy, scrape, render, geo_fetch, redirects, robots, crawl, watch |
| Extract / parse | extract, readability, tables, metadata, feed, sitemap, contacts, select, grep, subtitles |
| Convert | markdown, html, csv, json, xml, yaml, image_convert, pdf, fillable |
| Compress / encode / data | compress, encode, hash, archive |
| Token optimization | pack, declutter |
| Text / AI | summarize, translate, classify, ocr, entities, redact, voice, fontcase |
| Batching / composition | batch, batch_fetch, pipe |
| Storage | kv_get, kv_put, kv_list, kv_delete, store, put, dropbox |
| Web search / query | search, web_search, tavily, find_similar, wayback |
| Retail / shopping | shop, product_search, amazon, walmart, homedepot, lowes, bestbuy, ebay, costco, kroger, ace, winco, weekly_ad |
| Research / reference | arxiv, pubmed, openalex, crossref, semantic_scholar, clinical_trials, stackexchange, reddit, coingecko, youtube |
| People / places / social | people, people_finder, places, linkedin, facebook, uw |
| Notes / knowledge / vault | obsidian, ingest, citation |
| Knowledge / learning | recall, oracle, advise, learn, preferences |
| Mail (JMAP) | jmap, mail_triage |
| Feedback / meta | issue, suggest |
| Infra / meta | selftest, controld, tailscale, sux, fn, todoist |

**B. `_surface.ts` → `DOMAINS`** (14 buckets) — drives the live `sux()` capability map AND the public `GET /llms.txt` (both render from the same `DOMAINS` + `renderOverview`/`renderDomain`, so they can't drift). Looser and overlapping by design (a fn may sit in >1 domain); any registered fn not placed here auto-falls into a synthesized `"other"` bucket at render time. Domains: `search, fetch, extract, research, shop, convert, compute, data, storage, recall, tasks, mail, compose, meta`. The three **namespace connectors** (`vault`, `mail`, `files`) are documented alongside `DOMAINS` but are NOT leaf fns — they're separate MCP mounts with their own verb sets, kept out of the registry so their handle discipline stays enforced at the boundary.

**Use `CATEGORIES`** for an exhaustive, guard-enforced audit ("did I categorize the new fn?"). **Use `DOMAINS`** for the taxonomy an *agent* actually sees at runtime via `sux()`/`fn()`.

> **`importance.mjs` cruft.** The `IMPORTANCE` tier list names many fns that don't exist in `src/fns/` (`whois`, `dns`, `calc`, `units`, `datetime`, `jwt`, `embed`, `diff`, `dedupe`, …) — aspirational/historical from an earlier larger-planned surface. The comparator silently no-ops on unranked names (`RANK.has()` returns false), so this is not a bug, but don't go hunting for a `whois` fn.

---

## 9. Data model — persistent state

> **There is no `RT_KV`.** `wrangler.jsonc` declares exactly one KV namespace, `OAUTH_KV`. Every non-R2, non-git durable value — OAuth grants, the result cache, every `sux:*` app namespace, the vault index, user `kv:*` data, stage tokens, undo logs — lives in this **one** namespace, disambiguated purely by key prefix. If a task references `RT_KV`, read it as a misnomer for `OAUTH_KV`.

Other bindings: `AI`, `IMAGES`, `R2` (bucket `sux-mcp`), `BROWSER`, `MCP_RATE_LIMITER` (120/60 s).

### 9.1 OAUTH_KV key-space map

One flat namespace, prefix-partitioned by convention:

| Prefix | Owner | Shape | Purpose |
|---|---|---|---|
| `cache:<sha256>` | `mcp-util.ts` | ArrayBuffer (`cache-codec` framed) + `CacheMeta{softExpiresAt}` metadata | Universal tools/call result cache (§2, §9.5) |
| `oauth:state:<token>` | `github-handler.ts` | JSON `{oauthReqInfo,…}` | GitHub-login CSRF/state token (single-use: read-then-delete) |
| *(library-internal)* | `workers-oauth-provider` | opaque | The provider's own grant/token/client storage — shares the namespace, hence the `oauth`-prefix refusal in `kv_*` |
| `sux:oracle:<topic>` | `oracle.ts` | JSON `{distilled, chunks[], sources[], updated_at}` | Per-topic distilled KB (cap 15 chunks) |
| `sux:prefs:<profile>` | `preferences.ts` | JSON `{distilled_spec, examples[], updated_at}` | Self-distilling style-voice profile (cap 20) |
| `sux:learn:example:<id>` | `_examples.ts` | `Example{id,input,label,source?,embedding?,batch,ts}` | Labeled kNN example store; `batch` is the bulk-undo handle |
| `sux:ledger:<ns>:<id>` | `ledger.ts` | string (default `"1"`), TTL'd (default 30 d) | Generic idempotency ("done X before?"); mail-triage seen-ids, batch-append dedup |
| `sux:mail_triage:log` | `_mail_triage_log.ts` | one JSON array, newest-first, cap 500, of `TriageEntry` | The mail-triage undo log; `bulkUndo(env, cycle)` reverses a whole cycle |
| `sux:feedback` | `_feedback.ts` | one JSON array, cap 500, `FeedbackEntry{kind,text,at,tool?}` | Server-side feedback log (PII-redacted; `/feedback` is public+unauthed) |
| `sux:selfimprove:cursor` | `_self_improve.ts` | number-as-string | Monotonic cursor into `sux:feedback` |
| `sux:selfimprove:count:<UTC-day>` | `_self_improve.ts` | number-as-string, TTL 48 h | Daily outward-PR counter (cap is a compile-time literal, unreachable from KV) |
| `sux:selfimprove:findings` | `_self_improve.ts` | JSON array, cap 200, `Finding` | Review-only record of every classified finding |
| `sux:stage:<token>` | `stage.ts` | JSON `{kind, hash}`, TTL 300 s | Stage→commit token, verify-and-delete-once |
| `sux:dropbox:token` | `dropbox.ts` | access-token string, TTL'd | Mode A (app-folder) Dropbox token |
| `sux:dropbox:full:token` | `_dropbox-full.ts` | access-token string, TTL'd | Mode B (whole-account) token — deliberately distinct key |
| `sux:fastmail:session` | `_jmap.ts` | JSON JMAP Session, TTL 3600 s | Cached session discovery (token-free; no mail PII cached) |
| `sux:kroger:token` / `sux:ebay:token` / `sux:tailscale:token` | resp. fns | token string | Client-credentials OAuth caches (Kroger kept warm by the daily cron) |
| `sux:watch:<keyId>` | `watch.ts` | content hash string | Change-detection state |
| `sux:metrics` + `sux:metrics:0..7` | `metrics.ts` | JSON `Metrics{…}`, TTL 30 d, `SHARDS=8` | Usage metrics (sharded RMW to reduce increment loss); powers `/metrics` & `/health` |
| `store:<uuid>` | `_util.ts` (`STORE_KV_PREFIX`) | JSON `{key,content_type,size,sha256,expiry?}` | uuid→R2-object handle behind `/s/<uuid>` |
| `cache:vault:git:<repo>@<branch>:head` | `obsidian.ts` | JSON `{sha, at}` | Cached vault HEAD sha (recheck ≤60 s, stale-ok ≤600 s) |
| `cache:vault:git:…:note:<path>` | `obsidian.ts` | JSON `{body, sha, at, src:"git"}` | Per-note read-through cache, HEAD-validated |
| `cache:vault:git:…:list:<filter>` | `obsidian.ts` | JSON `{payload, sha, at}` | Cached vault listing |
| `cache:vault:git:…:index` | `vault-mcp.ts` | JSON `VaultIndex{sha,at,total,truncated,records[]}` | The whole-vault derived index (§7.7) |
| `cache:vault:remote:note:<path>` | `obsidian.ts` | JSON `{body, sha:null, at, src:"remote"}` | Live-vault (remote backend) cache — separate namespace so a lagging git mirror can't clobber a fresher live copy |
| `kv:<user-key>` | `kv_*.ts` | user string (gzip-framed) | The general-purpose user KV surface (§9.6) |

### 9.2 R2 (`sux-mcp` bucket)

Two key families: `cas/<sha256>` (content-addressed dedup blob store behind `putBlob`/`store`/`/s/<uuid>`; may carry the `_gzip` frame) and `adblock/engine.bin` (the compiled adblock engine, cron-rebuilt). R2 is also the byte-store Fastmail attachments stream through (R2 → JMAP, never through model context) and the destination for `pdf`/`render` output refs.

### 9.3 The vault (source of truth = GitHub, NOT KV)

Git history *is* the undo/audit log; there is no separate vault undo log. KV's role is purely a HEAD-validated read-through cache, never a write path. See §7.7.

### 9.4 Undo mechanisms — three distinct designs, no shared code

1. **Vault** — git commit history IS the undo (revert the commit).
2. **Mail triage** — `sux:mail_triage:log`, a structured per-action log with explicit undo coordinates (`from_mailbox`/`keyword`) and a `bulkUndo(cycle)` reverser; the one built to reverse a whole autonomous cycle with one call.
3. **Stage/commit** (`stage.ts`) — not an undo but a **pre-commit** two-step gate (mint a `commit_token` bound to a payload hash, spend it once within 5 min); recoverability for the ops it gates comes from the underlying system (Dropbox "Deleted files", `/.sux-trash`).

A fourth, smaller primitive is generic idempotency (`ledger.ts`, `sux:ledger:<ns>:<id>`): "have I already processed this?" — it prevents *redoing* work, it does not *undo* it. (Non-atomic; KV has no CAS — accepted race.)

### 9.5 The tools/call result cache

`cacheKey(tool, args) = "cache:" + sha256(tool + ":" + stableStringify(args))` — deterministic, order-independent. Only `cacheable:true` fns get a key; `raw:true` fns and `isError`/`noCache` results are never written. SWR via a `CacheMeta{softExpiresAt}` KV-metadata marker. `CACHE_TTL_SECONDS=3600` (per-fn `Fn.ttl` override), `CACHE_STALE_GRACE_SECONDS=86_400` (hard-TTL extension). `fresh:true` bypasses the read (still writes through). Concurrent identical calls single-flight-coalesce in an in-isolate Map (not KV).

### 9.6 The user-facing `kv:` namespace

A deliberately guarded surface: any tool-supplied key is namespaced under `kv:`, and the resolver **refuses** a key that (after trim+lowercase) starts with `kv:` itself, or with any reserved prefix (`cache:`, `sux:`, `oauth`) — the entire internal state map above is unreachable through this generic tool. Large text values are gzip-framed; TTL floor is KV's own 60 s.

### 9.7 Dropbox Mode A vs Mode B — separate credentials, separate KV keys

See §7.4 and §10.8. `hasDropboxFull(env)` is the single fail-closed gate at every Mode-B entry point; the two credential sets never mix.

### 9.8 Compression convention

`_gzip.ts` (persistent stores) vs `cache-codec.ts` (KV cache) are **distinct** — see §7.4. Do not conflate the `0x00`-marker gzip frame with the `"sxz1"` zstd/brotli frame.

---

## 10. Design decisions and conventions

### 10.1 Git-is-the-undo / CI-is-the-gate / review-is-the-net

Stated verbatim in `CLAUDE.md` as *how we work* — the safety net is structural (revert = auto-redeploy fix), so the team moves fast and unblocked rather than asking permission per change.
- `main` auto-deploys to production on push (`.github/workflows/deploy.yml`) — **never commit to `main`**; every merge is a release.
- CI gates (`.github/workflows/ci.yml`, all required): `tsc --noEmit`, `vitest run`, `check:node` (node deploy blob sync), `npm run docs` (FUNCTIONS.md committed), `npm run gen:index` (fn index committed), `wrangler deploy --dry-run`.
- Branch protection: CI green + PR, **0 required human approvals** (the gate is CI, not a person); `enforce_admins` off so an emergency hand-merge is always possible.
- The **autonomous PR pipeline** (`docs/autonomous-pipeline.md`): push branch → open PR → CI + Claude review run async → Claude autofix on red (capped 4 attempts, then `needs-human`) → native auto-merge when green → `main` → auto-deploy. Named residual risk: a semantic bug passing all tests + dry-run could merge/deploy — mitigated by health checks + revert, not eliminated.
- Auto-merge eligibility by conventional-commit type (`fix|security|perf|refactor|chore|docs|test|build|ci|revert`) or label (`automerge`/`bug`/`security`/`chore-safe`). **Never auto-merged:** `feat:` titles, `feature` label, breaking `!`, or `hold` label. Kill switches: per-PR `hold` label; whole pipeline = disable the Actions workflow; self-improve = `SELF_IMPROVE_KILL`.

### 10.2 One-change-per-cycle / branch discipline

Branch per logical change (`<type>/<slug>`), Conventional Commits with scope, signed off `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Update a branch by **rebasing onto `main`** (never merge main back in). Integrate via PR + merge-commit with a curated title (`Merge #NN: …`); squash only trivial single-change PRs. Before merging anything substantial: `/code-review ultra`. One Claude session per branch/workstream — continuity lives in memory + docs, not the session transcript.

### 10.3 Stateless worker + KV/R2 as the only state

One Worker, one OAuth flow, N connector namespaces — adding a namespace costs a route + a plugin, not new infra. `/mcp` is explicitly the stateless query/compute plane. KV = result cache + learned vectors + cursors + gates + the HEAD-validated vault cache; R2 = content-addressed immutable machine-facing blobs; Dropbox app-folder = the human-facing sync tier. Fan-out stops dispatching new work at `FANOUT_BUDGET_MS=50 s` and returns **dense** partial results flagged `{truncated:true, reason:"time"}` rather than a zero-output timeout death (the scariest site — Mode-B apply loops that mutate real files — got this last and deliberately). Full Queues/Workflows durable execution is **deliberately deferred** — the verdict (`automations-architecture.md`) is: build automations on sux's own primitives, adopt only Cloudflare Workflows if a real caller strains the 60 s ceiling, not n8n/Huginn/Windmill/LangGraph.

### 10.4 Reversible-by-default — the Unblocked-vs-Gated law

The single mechanical rule that resolves every gating question:

> **Unblocked where git can undo; gated where the world can't.**

- Reversible (lands as a git commit, or lives inside a credential-scoped folder with its own version history) → runs freely, no confirm dance. Canonical: vault writes.
- Irreversible/outward-facing (send email, RSVP, mint masked address, destroy in a 3rd-party system) → an explicit boolean gate (`allow_send`, `allow_destroy`, enforced by `enforceGates()` in `_jmap.ts`; generalized by `stage.ts`).
- **Honesty clause**: these gates defend **accidental mutation only** — they are LLM-set booleans a prompt injection could flip, so they are *not* an injection boundary, and the docs say so. Real containment for genuinely irreversible acts is a scoped (ideally read-only) credential + out-of-band confirmation the MCP surface can't itself provide.
- Three transport classes every domain falls into: **A** cloud-native API (Fastmail/Dropbox/GitHub — worker conduit fn, token as secret, identical cloud/mobile path), **B** Mac-local surface (live vault REST, iMessage — Tailscale-direct locally / Funnel'd from cloud, degrades when the Mac is asleep), **C** open web (search/scrape/render ladder; joins the store only via explicit `capture`).
- **Handle Discipline** (companion, locked): every store-facing verb passes references, not payloads (`/s/<uuid>`, urls, git SHAs, vault paths, message-ids); every list-producing verb has a batch form.

### 10.5 Do-right + nudge (north-star principle #1)

sux should **judge, not just execute** — catch a bad email before send, suggest a better search, surface a filing you'd forget. Held in tension with #4 (high-signal, low noise — a nudge must be worth the interrupt) and #2 (zero-trust: every side-effect gated, every ingested byte untrusted-until-fenced, least-privilege creds, no ambient authority). The flagship day-1 experience (self-model → synthesis → gap-fill → vault init) is framed as **READ-ONLY synthesis, a mirror not an authority**, never a therapy replacement.

### 10.6 Mac-retire (the render/mac-node decommission)

Data-driven (`chunks/06-render-cf-ladder.md`): a live 2026-07-11 bot-detection matrix had the mac node 502/offline the whole session (0/6 sites) — a single point of failure (home-laptop fragility + public-Funnel SSRF exposure). cf-residential rendering cleanly serves Amazon (AWS WAF, now cf-first), Lowe's, Ace, Walmart (catalog reads only — PerimeterX blocks cart). Costco = flaky soft-block. **Home Depot = Akamai hard "Access Denied," the one site cf structurally can't crack.** Policy landed: cf-first everywhere; a **paid residential-unlocker API rung** (env-gated `UNLOCKER_*`, fail-closed) is the escalation for HD/Costco — **not** the home Mac. The mac path is demoted to a dormant, explicit-only backend (`backend:mac`), never hard-deleted (reversible-by-default applies to infra too). A live security fix shipped in the same lane: the mac render server's HMAC auth gained a `±300 s` timestamp-freshness window (captured signed requests were previously replayable).

### 10.7 The autonomous pipeline (self-improve + mail_triage bots)

Two bounded, gated-dormant chunks designed against the "lethal trifecta" (private data + untrusted content + egress):
- **`mail_triage`** reads untrusted email (2 of 3 legs) → **eliminates egress**: no send/reply/forward, no HTTP fetch, no filter/forwarding-rule creation, no URL-following. Email body is data, never instructions (quarantined lane, never concatenated into the tool-calling prompt); classifier output is a schema-validated enum+confidence. Reversible-only allow-list; delete/send/sharing are hard-denied and structurally unrepresentable. Suggest-only for the first N cycles; confidence threshold 0.75. Dormant by default (`MAIL_TRIAGE_ENABLED` unset = no-op).
- **`self-improve` loop** grades lanes by blast radius: only trivially-reversible lanes (docs/deps/test-fixes) are auto-merge-eligible; anything touching auth/secrets/bindings/deploy-config/namespaces is PR-only; security/permission changes are never auto. The kill-switch and arm-flag live in a binding the loop has no write credential to. Caps ≤5 open bot PRs, ≤10 commits/day. Because it's self-deploying, the loop itself is PR'd for Colin.

Both are "armed but safe": deployed live in code, dormant until an env flag is set. Deliberately **refused/held**, never built unattended: remote-exec shell (RCE surface), tailnet-only render migration (Funnel→Serve is deploy-risk), any secret rotation.

### 10.8 Mode-A / Mode-B Dropbox split

One `files` namespace, two structurally opposite safety models under the same unblocked/gated law, keyed on whether a scope wall exists:
- **Mode A — bidirectional blobs, unblocked.** Reach = `/Apps/sux/` only (+ R2). The App-folder scope structurally can't see outside the app folder, so writes are unblocked, no gates — same posture as vault writes. Dropbox version history + R2 immutability is the undo. R2 (`store`) is the machine-facing tier; the Dropbox app-folder is the human-facing tier.
- **Mode B — operations over the whole corpus, gated.** Reach = the entire account, nothing mirrored, operated in place. Safety = a read/write firewall: read verbs structurally can't mutate; the mutating verb defaults to a dry-run plan (`apply:false`) and only `apply:true`/explicit confirm crosses into mutate. Mutation order is always backup → write-new → move/delete-originals, each `rev`-conditioned (fails loudly on concurrent edit). Requires a **second, distinct full-scope credential** (`DROPBOX_FULL_*`); the two credentials never mix.
- **Hard boundary with the vault (LOCKED)**: `files` holds **bytes, never facts** — a distilled note *about* a file is `vault`'s job (via `vault_capture`), never written by `files_operate`. A hard path guard refuses any Mode-B write-back target under the vault mirror, preventing a fork of truth away from git. Local-disk reach is deferred, not v1.

### 10.9 Reproduce-before-theorize

The recurring blind spot (per memory + `session-knowledge.md`): verify against live ground truth — exact failing payload, live API object model, loaded launchd definition — before hypothesizing or mutating a *working* service. Several session hours have been burned by skipping this.

---

## 11. Numbers, constants, and limits

> As of this pass, subject to drift — regenerate the census via `npm run docs`.

| Constant | Value | Where |
|---|---|---|
| MCP protocol version | `2025-06-18` (pinned) | `handleRpc` initialize |
| Server info name | `research-tools` | `handleRpc` |
| Front-door functions | ~103 (~101 tested) | `FUNCTIONS.md` header |
| `FRONT_VERBS` advertised | 13 (`sux, fn, search, scrape, shop, ingest, recall, oracle, pipe, batch, store, preferences, issue`) | `registry.ts` |
| `CONNECTOR_PATHS` | 4: `["/mcp","/vault/mcp","/mail/mcp","/files/mcp"]` | `connectors.ts` (asserted in test) |
| `FN_DEADLINE_MS` | 60 000 | `index.ts` |
| `MAX_OUTPUT_CHARS` | 1 000 000 | `index.ts` |
| `MAX_ARG_BYTES` | 256 000 | `index.ts` (`checkArgs`) |
| `MAX_ARG_DEPTH` | 64 | `index.ts` (`checkArgs`) |
| Cache TTL (soft) | 3 600 s (per-fn `Fn.ttl` override) | `mcp-util.ts` |
| Cache stale grace (hard-TTL ext.) | 86 400 s | `mcp-util.ts` |
| Rate limiter | 120 / 60 s, base 1 token/request | `wrangler.jsonc` (`MCP_RATE_LIMITER`) |
| `FANOUT_BUDGET_MS` | 50 000 | `batch.ts`/`pipe.ts`/`_util.ts pool()` |
| `batch` MAX_CALLS / MAX_NESTED_CALLS | 100 / 25 | `batch.ts` |
| `pipe` MAX_STEPS | 25 | `pipe.ts` |
| Cron trigger | `0 13 * * *` (daily) | `wrangler.jsonc` |
| Mail triage confidence threshold | 0.75 | `_mail_triage.ts` |
| Self-improve caps | daily 3, open PRs 5 (compile-time literals) | `_self_improve.ts` |
| Vault HEAD recheck / stale | ≤60 s / ≤600 s | `obsidian.ts` |
| Vault index cap | 5 000 notes | `vault-mcp.ts` |
| Stage token TTL | 300 s | `stage.ts` |
| Mac render HMAC freshness | ±300 s | `mac-render` |
| `_gzip` compress floor / bomb cap | 256 bytes / 64 MB | `_gzip.ts` |
| Metrics shards / TTL | 8 / 30 d | `metrics.ts` |

---

## 12. Cross-cutting idioms

- **Untrusted-material discipline** is repo-wide, not just `_self_improve`: `oracle`/`preferences`/`recall`/`advise` all fence caller/web/mail-derived text through `llm()`'s `<<<DATA>>>` markers (`src/ai.ts`) and tell the model, in the trusted system role, to treat it as data, never instructions.
- **Fail-closed toggle parsing** (`flagOn`) is shared verbatim between `_mail_triage.ts` and `_self_improve.ts`: empty/`"0"/"false"/"no"/"off"` → off, so an explicit falsy override can never accidentally arm a gate (the bug a bare `!!env.X` would have).
- **Reversible-only autonomy** is the load-bearing safety pattern across both autonomous surfaces — every allowed action has a cheap inverse, and the *type system* (not just a runtime check) often makes the disallowed action unrepresentable (`TriageOp`'s union has no delete/move-to-junk variant; self-improve can only open PRs, never merge).
- **Dynamic imports break `index.ts` cycles** everywhere a fn needs `FUNCTIONS` (`batch`, `pipe`, `product_search`, `ingest`'s `fnByName`, `_mail_triage.ts`'s `defaultDeps`) — deliberate, not incidental; don't "fix" it into a static import.
- **Egress correlation**: `handleRpc` clones `env` per-request (`rtEnv = {...env, _egress:{ctx, reqId}}`) so concurrent `tools/call`s in the same isolate can't clobber each other's correlation id or `ctx.waitUntil` context — relevant if you ever touch `smartFetch`'s egress audit.
- **Registry `surface` field + `TOOL_ANNOTATIONS`** drive both front-door hiding and smart-guard staging — decisions are metadata-driven, not hand-listed, so new fns inherit correct behavior automatically.

---

## 13. Key files index

| File | Role |
|---|---|
| `sux/src/index.ts` | `fetch`/`scheduled` entrypoints, `handleRpc` (the `/mcp` dispatcher), dispatch-safety rails (`checkArgs`/`clampResult`/`withDeadline`), OAuth wiring, cron ticks, `/admin/tick`, `oauthErrorResponse` |
| `sux/src/connectors.ts` | The one connector-surface source (`CONNECTORS`, `CONNECTOR_PATHS`, `buildManifest`) |
| `sux/src/registry.ts` | `Fn`/`RtEnv`/`ToolResult`/`FAIL_CODES` types, `FRONT_VERBS`, `TOOL_ANNOTATIONS`, `findFn`, `unwrapFnCall` |
| `sux/src/fns/index.ts` | GENERATED `FUNCTIONS: Fn[]` — the front-door registry |
| `sux/src/fns/fn.ts`, `sux.ts` | The two `surface:"front"` self-declaring fns (escape hatch + capability map) |
| `sux/src/fns/_surface.ts` | `DOMAINS`/`NAMESPACES` — the map rendered by `sux()` and `GET /llms.txt` |
| `sux/src/mcp-util.ts` | JSON-RPC parsing, `sseResponse`, cache-key hashing, `deferCacheWrite`, TTLs |
| `sux/src/cache-codec.ts`, `fns/_gzip.ts` | KV-cache framing (zstd/brotli, `"sxz1"`) vs persistent-store gzip (`0x00`) |
| `sux/src/vault-mcp.ts`, `mail-mcp.ts`, `files-mcp.ts` | The three personal-namespace MCP servers (own `Tool` type, own `handle*Rpc`) |
| `sux/src/fns/obsidian.ts`, `vault-graph.ts`, `ingest.ts` | Vault backend client, graph/index helpers, intake |
| `sux/src/fns/_jmap.ts`, `_caldav.ts`, `_mail_triage.ts`, `_mail_triage_log.ts` | Mail engine, CalDAV, triage bot + undo log |
| `sux/src/fns/dropbox.ts`, `_dropbox-full.ts`, `_dropbox-core.ts` | Dropbox Mode A / Mode B / shared token plumbing |
| `sux/src/fns/oracle.ts`, `preferences.ts`, `_examples.ts`, `recall.ts`, `advise.ts`, `_self_improve.ts`, `_feedback.ts` | The learning spine |
| `sux/src/proxy.ts`, `cf-render.ts`, `mac-render.ts`, `retail-render.ts`, `unlocker-render.ts` | The web ladder transport + render backends |
| `sux/src/github-handler.ts`, `workers-oauth-utils.ts`, `utils.ts` | OAuth authorize/callback, CSRF/approval helpers, `isAllowedLogin` |
| `sux/src/stage.ts`, `ledger.ts` | Stage-then-commit guard + write-fingerprint/idempotency ledger |
| `sux/src/metrics.ts`, `observability.ts`, `grafana.ts` | Metrics shards, public observability endpoints, Loki shipping |
| `sux/src/ai.ts` | Guarded `llm()` with `<<<DATA>>>` fencing |
| `sux/src/fns/_util.ts`, `_adblock.ts`, `_source.ts`, `_markup.ts` | R2 CAS + `STORE_KV_PREFIX`, adblock engine, source chunk/embed, htmlToMd |
| `sux/wrangler.jsonc` | Bindings (`OAUTH_KV`, `AI`, `IMAGES`, `R2`, `BROWSER`, `MCP_RATE_LIMITER`), cron, vars |
| `sux/scripts/gen-index.mjs`, `gen-docs.mjs`, `importance.mjs` | Registry + `FUNCTIONS.md` generators (CI-enforced) + ordering source |
| `sux/node/server.mjs`, `sux/mac-render/render_server.py` | Off-Worker Tailscale fetch node + patchright/CapSolver render node |
| `.claude-plugin/marketplace.json` | Plugin marketplace: `sux-router` (the `/mcp` connector + `sux` skill), `sux-life` (memory-only skill) |
| `sux/docs/architecture.md` | Existing shorter deep-dive (consistent with this doc) |

---

*Regenerate the function census (`npm run docs`) before trusting any count above; the generated `sux/FUNCTIONS.md` and the `src/fns/*.ts` source are the ground truth this document summarizes.*
