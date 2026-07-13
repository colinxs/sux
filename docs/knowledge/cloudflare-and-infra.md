# Cloudflare & Infra — durable reference for sux

The whole app is **one Cloudflare Worker** (`sux/src/index.ts`) deployed from
`sux/wrangler.jsonc`. There is no separate server, container, or VM in the request
path — every function runs in the Worker isolate at the edge, and all state lives in
Cloudflare bindings (KV / R2) plus a handful of external HTTP services (Grafana Cloud,
Monarch, the Tailscale residential proxy / Mac render node).

This file exists so future sessions **don't re-fetch** these facts. Ground truth is
the code + `wrangler.jsonc`; the model ids, neuron costs, and limits below were
web-confirmed against Cloudflare docs (links in each Refs). If you change a binding,
update this file and `wrangler.jsonc` together.

---

## wrangler bindings map

From `sux/wrangler.jsonc` (Worker name `sux`, `main: src/index.ts`,
`compatibility_date: 2025-06-01`, flags `nodejs_compat` + `global_fetch_strictly_public`).

| Binding | Type | What it's for |
|---|---|---|
| `OAUTH_KV` | KV namespace (`id d0dadc11…`) | OAuth/MCP state **and** the content-addressed tool-result cache; also store-handle map, metrics counters, Kroger token, cron heartbeats, oracle/preferences KBs |
| `AI` | Workers AI | Edge inference: text (llm/summarize/classify), embeddings, vision OCR, translate |
| `IMAGES` | Cloudflare Images | `image_convert` — format convert / resize / adjust |
| `R2` | R2 bucket (`sux-mcp`) | `store` fn — content-addressed blob storage (sha256 key), served at `GET /s/<uuid>` |
| `BROWSER` | Browser Rendering | `render` fn — headless Chromium (`@cloudflare/puppeteer`) for JS-rendered scraping / screenshot / page→PDF. **Egresses from the CF datacenter, not the residential proxy.** |
| `MCP_RATE_LIMITER` | `ratelimit` (unsafe, ns 2001) | Per-user (login) limit on `tools/call`: **120 / 60 s** |
| `OBS_RATE_LIMITER` | `ratelimit` (unsafe, ns 2002) | Per-IP limit on anonymous obs/content routes (`/metrics`, `/logs`, `/feedback`, `/s/*`): **60 / 60 s** |

`vars`: `DEBUG_MCP=0`, `MAIL_TRIAGE_ENABLED=1`, `WEEKLY_RECALL_ENABLED=1`,
`SELF_IMPROVE_ENABLE=1`. `observability.enabled=true` (head sampling 1.0).
`triggers.crons`: `0 13 * * *` (daily maintenance) + `*/5 * * * *` (Prometheus snapshot push).

Secrets (NOT in wrangler; set via `wrangler secret` / dashboard — see `registry.ts` `RtEnv`):
`MAC_RENDER_URL`, `MAC_RENDER_SECRET`, `GRAFANA_LOKI_URL/USER/TOKEN`,
`GRAFANA_PROM_URL/USER` (bearer reuses `GRAFANA_LOKI_TOKEN`), `MONARCH_TOKEN`, plus the
per-fn API keys (Kagi, Tavily, Fastmail, Todoist, ControlD, Tailscale, …).

---

## Cloudflare platform

### Workers runtime (the whole app)
- **Purpose**: Serverless V8-isolate runtime; hosts the entire MCP server + personal namespaces on one Worker.
- **Auth / config**: `sux/wrangler.jsonc`; deploy = `wrangler deploy` (auto on push to `main` via `.github/workflows/deploy.yml`).
- **How sux uses it**: single `fetch()` + `scheduled()` handler in `sux/src/index.ts`; dispatch → `registry.ts` fn table (~95 fns).
- **Key config**: `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`. The `global_fetch_strictly_public` flag forces all `fetch()` egress onto the public internet (private/loopback/link-local refused at the platform level) — defense-in-depth over smartFetch's own SSRF guard, and it enables CIMD in the OAuth flow (`wrangler.jsonc:6-13`).
- **Limits/gotchas**: per-fn hard deadline `FN_DEADLINE_MS = 60_000` and output clamp `MAX_OUTPUT_CHARS = 1_000_000` (`index.ts:54-55`). Isolate CPU/memory limits apply; long work rides `ctx.waitUntil` off the response path. `upload_source_maps: true`.
- **Refs**: https://developers.cloudflare.com/workers/ · wrangler config: https://developers.cloudflare.com/workers/wrangler/configuration/

### KV — `OAUTH_KV`
- **Purpose**: OAuth/MCP state + the **content-addressed tool-result cache** + misc small persistent values.
- **Binding**: `OAUTH_KV` (namespace id `d0dadc11fdd64598992f4a84a958bafb`).
- **How sux uses it**:
  - Result cache: `index.ts:257` builds `key = cacheKey(name, args)` (sha256 of fn name + args) for `cacheable` fns; read at `index.ts:311-320` with `getWithMetadata` for stale-while-revalidate (soft-TTL marker in metadata); write off-path via `deferCacheWrite` (`index.ts:299`). Values are compressed frames (cache-codec: zstd/brotli/plain).
  - Store handle map: `store:<uuid> → {key,content_type,size,sha256}` (`store.ts`, `observability.ts:56`).
  - Also: metrics counters (`metrics.ts`), cron heartbeats (`cron-heartbeat.ts`), Kroger token (`index.ts:470`), stage tokens (`stage.ts`), oracle/preferences KBs, idempotency ledger (`ledger.ts`).
- **Code pattern**:
  ```ts
  await env.OAUTH_KV.put(key, JSON.stringify(v), { expirationTtl: TTL });
  const raw = await env.OAUTH_KV.get(key, "arrayBuffer");
  ```
- **Limits/gotchas**: value ≤ **25 MiB**, key ≤ 512 B, metadata ≤ 1024 B. Eventually consistent (writes take up to ~60 s to propagate globally); ~1 write/s **per key**. Don't store per-request hot mutable counters expecting strong consistency — sux tolerates this (metrics are approximate, cache is best-effort). `expirationTtl` minimum 60 s.
- **Refs**: https://developers.cloudflare.com/kv/ · limits: https://developers.cloudflare.com/kv/platform/limits/

### R2 — `R2` (`store` fn)
- **Purpose**: Object storage for arbitrary blobs; content-addressed (key = sha256 → identical content dedupes, Nix-store style). Backs `store` and every `as:"url"` binary delivery.
- **Binding**: `R2` → bucket `sux-mcp`.
- **How sux uses it**: `sux/src/fns/store.ts` — `put` writes bytes + mints a short uuid handle in KV, returns `{uuid,url,key,sha256,size}`; `GET /s/<uuid>` streams it back (`observability.ts:56-70`). Objects > 4 MiB are never inlined — `get` returns the streaming URL instead (`store.ts:14,93`). Blobs may be transparent-gzip framed (`_gzip.maybeDecompress`).
- **Code pattern**:
  ```ts
  const ref = await putBlob(env, bytes, ct, ttlSeconds ? { ttlSeconds } : undefined);
  const obj = await env.R2.get(r2key);            // .arrayBuffer() / .httpMetadata
  const res = await env.R2.list({ prefix, limit }); // objects[], truncated, cursor
  ```
- **Limits/gotchas**: **zero egress fees** (R2's whole point). Handle self-expires via KV TTL but the deduped blob is **retained** on `delete` (may be shared). Single object up to ~4.995 TiB; multipart for large uploads. Strongly-read-after-write consistent (unlike KV).
- **Refs**: https://developers.cloudflare.com/r2/ · limits: https://developers.cloudflare.com/r2/platform/limits/

### Workers AI — `AI`
- **Purpose**: Edge inference (~300× cheaper than calling a frontier API per the wrangler note). Four models, all `@cf/*`, invoked via `env.AI.run(model, inputs)`.
- **Binding**: `AI` (`"ai": { "binding": "AI" }`). `hasAI(env)` guards every call (`ai.ts:13`).
- **Model registry** (`ai.ts:6-11`, `MODELS`):

  | Key | Model id | Purpose (fn) | Cost note |
  |---|---|---|---|
  | `text` | `@cf/meta/llama-3.2-3b-instruct` | `llm()` — summarize / classify / any text gen (`ai.ts:50`; auto-summarize `index.ts:281`) | 80k ctx; $0.051 /M in, $0.34 /M out |
  | `embed` | `@cf/baai/bge-base-en-v1.5` | `embed()` embeddings, 768-dim, **batched** (`fns/_embed.ts:14`) | $0.067 /M in tok = 6058 neurons/M |
  | `vision` | `@cf/meta/llama-3.2-11b-vision-instruct` | `ocr` — image→text transcription (`fns/ocr.ts:34`) | vision LLM; see model page |
  | `translate` | `@cf/meta/m2m100-1.2b` | `translate` — `{text,target_lang,source_lang?}` → `translated_text` (`fns/translate.ts:33`) | small; ~cheap |

  Workers AI billing: **$0.011 / 1,000 Neurons**, **10,000 Neurons/day free** (resets 00:00 UTC), then Workers Paid. Neuron = normalized GPU-compute unit.
- **Code pattern**:
  ```ts
  const r = await env.AI.run(MODELS.text, { messages: [...], max_tokens });
  const v = await env.AI.run(MODELS.embed, { text: texts });     // { shape:[n,768], data:number[][] }
  const t = await env.AI.run(MODELS.translate, { text, target_lang, source_lang });
  ```
- **Limits/gotchas**:
  - **Prompt-injection fence**: everything `llm()` processes is untrusted (scraped pages). The guard rides in the trusted `system` role; user content is wrapped `<<<DATA>>>…<<</DATA>>>` with embedded markers defused via zero-width space (`ai.ts:24-46`). `translate` deliberately does NOT fence (would corrupt output — `translate.ts` comment).
  - Some models return `response` as an object, not a string → `llm()` JSON-encodes non-strings (`ai.ts:60-63`).
  - Empty `translated_text` is treated as failure (not cached) so the next call retries (`translate.ts`).
  - `embed` supports batched input — pass all texts in one `run` (N examples = 1 round-trip).
- **Refs**: pricing https://developers.cloudflare.com/workers-ai/platform/pricing/ · models https://developers.cloudflare.com/workers-ai/models/ · llama-3.2-3b https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/

### Browser Rendering — `BROWSER`
- **Purpose**: Headless Chromium for `render` (JS-rendered pages, screenshots, page→PDF).
- **Binding**: `BROWSER` (`"browser": { "binding": "BROWSER" }`).
- **How sux uses it**: `sux/src/cf-render.ts` — one shared `@cloudflare/puppeteer` driver (`puppeteer.launch(env.BROWSER)` at `cf-render.ts:169`). Applies stealth UA/viewport/`navigator.webdriver` masking + resource blocking (image/media/font/stylesheet). Retailer fns fall back to this only when the Mac backend is down.
- **Code pattern**:
  ```ts
  if (!env.BROWSER) return { ok:false, error:"Browser Rendering is not configured (BROWSER binding)." };
  const browser = await puppeteer.launch(env.BROWSER);
  ```
- **Limits/gotchas**: **Egresses from the CF datacenter IP, not the residential proxy** — so datacenter-IP bot walls still block it; that's why the fetch ladder escalates to the Mac render node for Akamai/PerimeterX. Never-throw envelope: missing binding / launch / nav error → `{ok:false,error}`. Account limits (2026): **120 concurrent browsers/account, 1 new instance/sec**, REST 10 req/s. Use Puppeteer wait vocab (`networkidle0/2`) here — the Mac (Playwright) backend needs `networkidle` (normalized in `mac-render.ts`).
- **Refs**: https://developers.cloudflare.com/browser-rendering/ · limits https://developers.cloudflare.com/browser-rendering/platform/limits/

### Cloudflare Images — `IMAGES`
- **Purpose**: Format-convert / resize / adjust for `image_convert` (png/jpeg/webp/avif).
- **Binding**: `IMAGES` (`"images": { "binding": "IMAGES" }`).
- **How sux uses it**: `sux/src/fns/image_convert.ts:60-74` — `env.IMAGES.input(bytes).transform(t).output({format,quality})`. Transform opts: width/height/rotate/blur/sharpen/brightness/contrast/gamma/fit.
- **Code pattern**:
  ```ts
  const result = await env.IMAGES.input(bytes).transform(t).output({ format: MIME[to], quality });
  const bytes = new Uint8Array(await result.response().arrayBuffer());
  ```
- **Limits/gotchas**: images-binding transforms (not the URL-based Image Resizing product). Video input is refused (would need Media Transformations — `image_convert.ts:57`). Input/output size + format constraints apply.
- **Refs**: https://developers.cloudflare.com/images/transform-images/bindings/

### Rate limiters — `MCP_RATE_LIMITER`, `OBS_RATE_LIMITER`
- **Purpose**: Backpressure. `MCP_RATE_LIMITER` = per-user ceiling on `tools/call`; `OBS_RATE_LIMITER` = per-IP ceiling on the anonymous obs/content routes the MCP gate never sees.
- **Binding**: `unsafe.bindings` type `ratelimit` — `MCP_RATE_LIMITER` ns 2001 (120/60 s), `OBS_RATE_LIMITER` ns 2002 (60/60 s).
- **How sux uses it**: MCP gate `index.ts:392-397` + `rate-limit.ts:28` (`key = login`, only on `tools/call`); obs gate `observability.ts:32-36` (`key = cf-connecting-ip`).
- **Code pattern**:
  ```ts
  const { success } = await env.MCP_RATE_LIMITER.limit({ key: login });
  ```
- **Limits/gotchas**: `unsafe` binding — the rate-limiting API is not GA-stable; `namespace_id` must be unique per limiter. Sliding-window, per-colo (not globally exact). Absent binding → sux fails open (no limit).
- **Refs**: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

### Workers Observability + cron
- Persistent logs enabled (`observability.enabled`, head sampling 1.0) — queryable in the dashboard / via the Workers Observability MCP.
- Cron: `scheduled()` in `index.ts` branches on `event.cron`. `0 13 * * *` = daily maintenance (Kroger token warm, mail triage, adblock, metrics snapshot). `*/5 * * * *` = push the Grafana Prometheus snapshot only (dormant until `GRAFANA_PROM_*` set).

---

## Supporting infra (external HTTP services)

### Tailscale residential proxy + Mac render node
- **Purpose**: Residential-IP egress (clears datacenter-IP bot walls) + a patched-browser render backend (Akamai/PerimeterX + captcha solving). This is the top rung of the fetch ladder (`scrape` → CF `render` → `render {backend:"mac"}`).
- **Auth**: HMAC-signed requests — `MAC_RENDER_SECRET` signs `ts\npayload`; `ts`+`sig` ride the query string (some CGI hosts drop custom POST headers). Node lives at `MAC_RENDER_URL`.
- **Base URL / node**: `router@100.98.238.70` (owl-tegu), reachable via Tailscale + Funnel (`.ts.net` public URL). It's uhttpd-CGI, **Playwright/patchright** (not Puppeteer) — hence the `networkidle0/2 → networkidle` wait-vocab normalization.
- **How sux uses it**: `sux/src/mac-render.ts:94-110` (`macRender`), routed via `sux/src/proxy.ts` `smartFetch`. Rotate the secret via `TAILSCALE_PROXY_SECRET` on the node (memory `residential-proxy-node`).
- **Code pattern**:
  ```ts
  if (!env.MAC_RENDER_URL || !env.MAC_RENDER_SECRET) return { ok:false, error:"Mac render backend not configured." };
  const sig = await hmacHex(env.MAC_RENDER_SECRET, `${ts}\n${payload}`);
  const endpoint = `${new URL("/render", env.MAC_RENDER_URL).href}?ts=${ts}&sig=${sig}`;
  ```
- **Limits/gotchas**: shared + slow — don't start the ladder here. Circuit breaker fast-fails `circuit-open` after repeated failures (`mac-render.ts` `macBreaker`); timeout capped `MAC_TIMEOUT_CAP_MS`. Node is a **dumb residential exit**, not an orchestrator — latency optimization, not a correctness dependency.
- **Refs**: memory `residential-proxy-node`, `owl-tegu-luci-apps`; Tailscale Funnel https://tailscale.com/kb/1223/funnel

### Grafana Cloud — Loki (logs) + Prometheus (metrics)
- **Purpose**: Observability sink. Loki = per-event tool-call + egress-audit stream; Prometheus = low-cardinality long-retention counters + SLO/latency gauges.
- **Auth**: HTTP Basic — `Authorization: Basic base64(user:token)`. Loki: `GRAFANA_LOKI_USER` + `GRAFANA_LOKI_TOKEN`. Prometheus: `GRAFANA_PROM_USER`, bearer **reuses `GRAFANA_LOKI_TOKEN`** (scope it `+metrics:write`) — no second key.
- **Base URL**: `GRAFANA_LOKI_URL` (Loki push endpoint) / `GRAFANA_PROM_URL` (Prometheus push).
- **How sux uses it**: `sux/src/grafana.ts` — `shipToLoki` (`:22`, one JSON POST per tool call), `shipEgress` (`:85`, one line per outbound fetch decision — host only, never full URL), `shipMetricsSnapshot` (`:183`, once per `*/5` cron tick, **Influx line protocol** not remote-write). All fire-and-forget via `ctx.waitUntil`, never on the response path, never throw.
- **Code pattern**:
  ```ts
  const authorization = `Basic ${btoa(`${user}:${token}`)}`;
  ctx.waitUntil(fetch(url, { method:"POST", headers:{ "content-type":"application/json", authorization }, body }));
  ```
- **Limits/gotchas**: no-op unless all three Loki secrets set (Prometheus needs `GRAFANA_PROM_*` too) — inert by default. Loki wants **nanosecond string timestamps** and **low-cardinality labels** — tool name is a label (~78 values ok), everything else rides the JSON line. Errors clipped to ~200 chars before shipping (no HTML error page / secret leak). Egress lines ship **host only**, never paths/queries.
- **Refs**: Loki push https://grafana.com/docs/loki/latest/reference/loki-http-api/ · Prometheus push (Influx line protocol) https://grafana.com/docs/grafana-cloud/

### Monarch Money — billing / personal finance (read-only)
- **Purpose**: READ-ONLY personal finance (accounts, balances, transactions, budgets, cashflow, holdings). Used for billing-aware autonomy and the finance surface of recall/briefing.
- **Auth**: `MONARCH_TOKEN` (secret; `registry.ts:141`).
- **How sux uses it**: `sux/src/fns/monarch.ts` — GraphQL conduit. **sux NEVER moves money**: no transfer/trade op exists and the raw `graphql` escape refuses mutations.
- **Limits/gotchas**: read-only by construction; fails cleanly when `MONARCH_TOKEN` is unset. Unofficial GraphQL API — brittle to upstream schema changes.
- **Refs**: (unofficial) MonarchMoney GraphQL; memory `billing-aware-autonomy`.

---

## Quick facts to not re-derive
- The Worker **is** the app; state = KV + R2 only. No DB, no queue, no Durable Object in the path.
- Cache key = sha256(fn name + args); cacheable fns memoize in `OAUTH_KV` with stale-while-revalidate. Repeat calls are free.
- Fetch ladder: `scrape` (residential proxy, cheapest) → `render` (CF Browser Rendering, **datacenter IP**) → `render {backend:"mac"}` (residential patched browser, slow, shared).
- Everything Workers-AI-facing is treated as untrusted and fenced (`ai.ts`), except `translate`.
- All Grafana/Monarch/Mac-render integrations are **secret-gated + fail-closed**: unset secret → the feature is a silent no-op, never an error.
