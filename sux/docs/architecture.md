# Architecture (deep dive)

This complements the [README](../README.md). Read the README first for the
three pillars, the fetch ladder, and the bot-detection war; this file drills into
the mechanics.

## The request lifecycle

```
MCP client
  │  JSON-RPC over HTTPS, OAuth bearer
  ▼
Cloudflare Worker (sux/src/index.ts)
  │  1. handleObservability() — public /health /metrics /logs /feedback /s/<uuid>
  │  2. OAuth provider (github-handler.ts) — gate on ALLOWED_GITHUB_LOGIN
  │  3. handleRpc() — dispatch tools/list, tools/call
  ▼
Fn.run(env, args)  (sux/src/fns/<name>.ts)
  │  cache lookup (KV, CAS key) — hit → return cached ToolResult
  │  miss → do the work:
  │     • smartFetch()      — proxy.ts, rung 1/2 (direct | curl-impersonate)
  │     • macRender()       — mac-render.ts, rung 3/4 (cf | mac browser)
  │     • AI / IMAGES / R2  — Cloudflare bindings
  ▼
deferCacheWrite() — write success to cache with per-fn TTL (never cache errors)
  ▼
ToolResult → JSON-RPC response
```

## Pillar 1 — MCP dispatch & the OAuth gate

- `sux/src/index.ts` owns the `fetch` and `scheduled` entrypoints. Observability
  routes are served *before* the OAuth provider claims every path, so `/health`
  et al. stay public.
- `sux/src/github-handler.ts` runs the GitHub OAuth flow and enforces
  `ALLOWED_GITHUB_LOGIN` — only that login can complete auth, so the whole tool
  surface is single-user by construction.
- The OAuth library is wrapped so malformed requests become clean JSON 400/500s
  instead of Cloudflare's raw 1101 error page.
- Per-user rate limiting via the `MCP_RATE_LIMITER` binding (120 req / 60 s).

## Pillar 2 — residential egress

Two independent residential paths, both HMAC-signed with the same scheme
(`hmacHex(secret, "${ts}\n${payload}")`, with `ts`+`sig` on the **query string**
because uhttpd drops custom POST headers).

- **`smartFetch` (`sux/src/proxy.ts`)** — the drop-in `fetch` for pages. Decides
  proxy vs direct via `willProxy()`:
  - `DIRECT_HOST_RE` short-circuits hosts that gain nothing from residential
    egress (kagi.com, DoH resolvers, ip-geo APIs) — direct is a hop faster and
    they never block datacenter IPs.
  - Everything else proxies through the OpenWRT curl-impersonate node when the
    proxy is configured and not force-disabled (`TAILSCALE_PROXY_ALL=0`).
  - **Never takes the Worker down:** if the proxy errors, it falls back to a
    direct fetch (`proxy_fallback`); if a legacy proxy mangles a binary body, it
    refetches direct (`binary_refetch`). Bounded retries (3 attempts, jittered
    backoff, honors `Retry-After`) on transient 408/429/502/503/504.
  - Route accounting (`proxied`/`direct`/`proxy_fallback`/`binary_refetch`) is
    tallied per-isolate and drained into metrics + the structured `sux` log line.
- **`macRender` (`sux/src/mac-render.ts`)** — the client for the patchright
  render service. Never throws: unconfigured backend, transport error, non-200,
  unreadable body, or a node-side `{error}` all resolve to `{ok:false, error}`.
  The Worker's abort is bounded (nav budget + 15 s margin, capped at 80 s) so a
  hung Mac can never hang the tool call.

## Pillar 3 — the cache

- Content-addressed: the cache key is the input closure (fn + normalized args).
  `fresh:true` bypasses the lookup on any call.
- Per-fn `ttl` and `cacheable` flags on the `Fn` descriptor drive expiry.
- **Errors are never cached as success** — only `ToolResult`s without `isError`
  (and without `noCache`) are written, via `deferCacheWrite`.
- Binary artifacts live in R2 (`sux-mcp` bucket), content-addressed by sha256
  with a short uuid handle in KV; `/s/<uuid>` streams them back.

## The `Fn` contract (`sux/src/registry.ts`)

```ts
type Fn = {
  name: string;
  description: string;   // shown verbatim in tools/list — this is the fn's docs
  inputSchema: unknown;  // JSON Schema
  cacheable?: boolean;
  cost?: number;
  ttl?: number;
  raw?: boolean;
  run: (env: RtEnv, args: any) => Promise<ToolResult>;
};
```

Registry is generated: `FUNCTIONS[]` in `sux/src/fns/index.ts` is emitted by
`scripts/gen-index.mjs` and ordered by `scripts/importance.mjs`. Add a fn →
create `fns/<name>.ts` exporting `export const <name>: Fn` → `npm run gen:index`.

## Composition primitives

- **`pipe`** (COMPOSE) — sequential; each step's text output feeds the next via
  `{{prev}}` / `{{prev.a.b}}`. Runs entirely server-side (no model round-trips),
  stops at the first failing step.
- **`batch`** (MAP + reduce) — run one tool over many inputs (`calls`, or
  `over`+`args` with `{{item}}` templating), capped concurrency, per-item failure
  tolerated. Reduce server-side (`none`/`concat`/`summarize`) or with a
  tool-based `reduce_with` (`{{items}}`/`{{items.path}}`) so results don't all
  return to context. Mapping `tool:pipe` gives per-item pipelines.

## Design notes / longer-horizon ideas

- **`answer` (Perplexity-style)** — `web_search` → residential `scrape`/`render`
  top-N → embed + highlight → `summarize` into a grounded, inline-cited answer.
  Pure composition of existing primitives.
- **search-over-`store`** — a full-text index over R2 blobs, turning `store`
  into a personal, searchable document DB (the biggest missing capability). Pairs
  with a `scrape/render → pdf → ocr → extract → classify → store` pipeline preset.
- **`convert(from,to)` dispatch** — collapse the converter fns (`json`/`csv`/
  `xml`/`yaml`/`html`/`markdown`) into one generic fn dispatched on `(from,to)`
  via a canonical hub type; auto-insert conversions in `pipe` when stage types
  mismatch.
- **Content-addressed caching (Nix-style)** — key on the full input closure incl.
  fn version + upstream ids; per-fn `pure` flag drives TTL; early-cutoff
  memoization in `pipe`.
