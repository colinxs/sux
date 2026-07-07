# sux — a residential caching web-fetch engine, served over MCP

**sux is a personal, self-owned web-access layer.** It caches and serves from Cloudflare's edge, but *queries the web from your own residential IP* through infrastructure you control — so it reaches sites that block datacenters, and it does the fetching, parsing, converting, and AI-summarizing at the edge instead of in your context window. It's exposed to any MCP client as ~53 small, composable tools.

> Living doc. Everything the project has learned — architecture, the bot-detection war, the fn catalog, ops, and inspiration — lives here.

---

## The three pillars (never break these)

1. **MCP serving** — OAuth-gated (GitHub) JSON-RPC dispatch. `sux/src/index.ts` (`handleRpc`).
2. **Residential egress** — outbound fetches route through a Tailscale residential exit, not Cloudflare's datacenter IPs. `sux/src/proxy.ts` (`smartFetch`/`willProxy`).
3. **Caching** — content-addressed KV cache, per-fn TTL, never caches upstream errors as success. `sux/src/mcp-util.ts` (`deferCacheWrite`).

Everything else — the ~53 fns — is built on top. Before shipping any change, confirm all three still hold (`/health` shows `routing:true`, unauth `/mcp` → 401, cache tests green).

---

## Architecture

```
MCP client ──HTTPS──▶ Cloudflare Worker "sux" (the edge)         Tailscale            open web
                       • GitHub OAuth gate                            │
                       • KV cache (per-fn TTL) ◀── read/write ──┐    │
                       • ~53 fns / JSON-RPC dispatch            │    │
                       • R2 store (CAS blobs, /s/<uuid>)        │    │
                       └── cache miss ─┬─ scrape ──▶ OpenWRT node ──▶ curl-impersonate ──▶ site
                                       │             (residential IP, Chrome JA3)
                                       └─ render:mac ▶ Mac render service ──▶ patched Chromium ──▶ site
                                                       (residential IP, real browser, solves JS challenges)
```

### The fetch ladder (bot-detection escalation)
Each rung costs more but defeats more protection. Pick the lowest rung that works:

| Rung | Path | Egress | Beats | Cost |
|---|---|---|---|---|
| 1. direct | Worker `fetch()` | CF datacenter | nothing hostile | fast/free |
| 2. **scrape** | `smartFetch` → OpenWRT `curl-impersonate` | **residential + Chrome JA3/HTTP2** | datacenter blocks + **passive** TLS/fingerprint (most Akamai/CF) | +1 hop |
| 3. render:cf | Cloudflare Browser Rendering | CF datacenter (browser reqs residential-routed) | client-rendered JS on non-hostile sites | slow |
| 4. **render:mac** | Mac patchright browser | **residential + real browser** | **active JS challenges** (Akamai `_abck` sensor, PerimeterX) | slowest |

### The three machines
- **Cloudflare Worker** (`sux/src/`) — the brain. KV cache, R2 store (`sux-mcp` bucket), Workers AI, Cloudflare Images, rate limiter, Browser Rendering binding.
- **OpenWRT node** (`sux/node/openwrt/`) — residential fetch proxy. `router.owl-tegu.ts.net`, x86_64 musl. uhttpd CGI (`fetch.sh`) calls **curl-impersonate** (Chrome TLS), HMAC-authed, exposed via Tailscale Funnel. This is rung 2.
- **Mac render service** (`sux/mac-render/`) — residential patched-browser render. `colins-macbook-pro.owl-tegu.ts.net`, async patchright (parallel, conc 4), HMAC-authed, Tailscale Funnel, launchd + caffeinate keep-alive. This is rung 4.

---

## The bot-detection war (hard-won knowledge)

**Detection is layered and must be *coherent*** — every layer must tell the same story:
- **IP reputation** — mobile > residential > datacenter. Datacenter is blocked on reputation alone.
- **TLS fingerprint** — JA3 (deprecated: Chrome permutes extensions since Chrome 110) → **JA4** (sorted, stable) from the ClientHello: cipher/extension order, curves, GREASE. Sent in cleartext before any data.
- **HTTP/2 fingerprint** — Akamai fingerprints the SETTINGS frame + WINDOW_UPDATE + pseudo-header order. Chrome: `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`. curl's is unmistakably different.
- **Header order/coherence** — a "Chrome" UA over a curl JA3 with 2 headers is an instant flag.
- **Active JS sensor** — Akamai `_abck`/`bmak`, PerimeterX: ~512KB of obfuscated JS that fingerprints canvas/WebGL/behavior and POSTs encrypted `sensor_data` to earn a clearance cookie, then reloads.

**What we learned the hard way:**
- A **residential IP alone is not enough** — `scrape` via plain curl on the residential node still got Akamai 403s because curl's JA3/HTTP2 fingerprint screams "bot." Fixed by **curl-impersonate** (Chrome build, musl for OpenWRT) — matches JA3+JA4+HTTP2+headers coherently. Let the wrapper own the fingerprint headers; forward only functional ones (auth/content-type/cookie).
- **curl-impersonate beats *passive* detection** (403→200) but **cannot solve active JS challenges** — those need a real browser.
- **Cloudflare Browser Rendering can't beat active challenges either** — its headless Chrome gets flagged by Akamai's sensor, and Workers can't route its egress through a custom proxy (proxyServer is unsupported in Workers).
- **The Mac wins** because its public IP *is* the residential IP (it's on the home network), so a **patched browser (patchright, which dodges the CDP `Runtime.enable` automation leak) there is real fingerprint + residential IP + native TLS — nothing spoofed**, exactly what the sensor is built to pass. Confirmed: real Home Depot content where every other rung failed.

See `sux/docs/retail-endpoints.md` for per-retailer specifics.

---

## Function catalog (~53)

- **Search / web** — `search` (simple Kagi), `web_search` (Kagi + native Google, map-reduce synthesis), `scrape` (residential curl-impersonate), `render` (JS render; `backend: cf|mac`, `as: html|text|screenshot|pdf`), `crawl`, `sitemap`, `feed`, `wayback`, `robots`, `redirects`, `batch_fetch`, `geo_fetch`, `proxy`.
- **Extract** — `extract`, `readability`, `tables`, `metadata`, `contacts`, `select`, `grep`, `declutter`, `entities`.
- **Convert** (bidirectional `from`/`to`) — `json` `csv` `xml` `yaml` `markdown` `html`, `subtitles`, `image_convert`, `pdf` (build/fill/ocr/compress + as:url), `fillable`, `fontcase`.
- **AI** (Workers AI) — `summarize`, `translate`, `classify`, `ocr`, `redact`.
- **Compress/encode** — `compress`, `archive`, `encode`, `hash`, `pack`.
- **Store/cache** — `store` (R2 CAS), `kv_get/put/list/delete`.
- **Compose** — `pipe` (COMPOSE), `batch` (MAP + reduce), `fresh` (universal cache-bypass arg).
- **Retail** — `kroger` (official API; QFC + Fred Meyer via chain), `walmart`, `homedepot`, `costco` (+ `ace`, `lowes`, `amazon`, `winco` planned). See retail section.
- **Meta** — `issue`, `shop`.

Registry is auto-generated: add `sux/src/fns/<name>.ts` (`export const <name>: Fn`) → `npm run gen:index`. Cap: **100 fns** (upper limit, not a goal).

---

## Retail fns strategy

Route each retailer to the lowest fetch-ladder rung that works:

| Retailer | Method | Notes |
|---|---|---|
| **Kroger / QFC / Fred Meyer** | official free API (`api.kroger.com`) | OAuth client-creds, zero bot protection. Needs free `KROGER_CLIENT_ID/SECRET`. Cleanest. |
| **Costco** | `scrape` (curl-impersonate) | Akamai JA3-centric → passive; HTML search + extract. |
| **Ace** | needs Kibo session token | Kibo REST 401s without a warmed token → render:mac. |
| **Home Depot** | `render:mac` | active Akamai `_abck` → real browser. GraphQL `federation-gateway` or rendered tiles. |
| **Walmart** | `render:mac` (⚠ blocked) | PerimeterX press-and-hold captcha challenges even the headless patched browser → fn fails gracefully. Would need a *headed* real-Chrome or a captcha step. |
| **Lowe's** | `render:mac`/scrape | embedded `__PRELOADED_STATE__` JSON. |
| **Amazon** | best-effort | PA-API needs an Associate account; direct scrape hits WAF+CAPTCHA. |
| **WinCo** | store-locator only | no online product catalog exists. |

---

## Config / secrets (`wrangler secret put --config sux/wrangler.jsonc`)

Core: `GITHUB_CLIENT_ID/SECRET`, `COOKIE_ENCRYPTION_KEY`, `ALLOWED_GITHUB_LOGIN`, `KAGI_API_KEY`, `TAILSCALE_PROXY_URL/SECRET`.
Render: `MAC_RENDER_URL` (Mac funnel), `MAC_RENDER_SECRET`.
Optional: `GITHUB_TOKEN` (GitHub scraping), `SERPAPI_KEY` (Google in web_search), `KROGER_CLIENT_ID/SECRET`.

Bindings (`sux/wrangler.jsonc`): OAUTH_KV, R2 (`sux-mcp`), AI, IMAGES, BROWSER, MCP_RATE_LIMITER.

---

## Operations

- **Deploy:** `npm run deploy:sux`. **Gate:** `npm run type-check && npm test` (must be green). **Docs:** `npm run docs`.
- **OpenWRT node:** curl-impersonate musl build in `/opt/curl-impersonate`; CGI at `/srv/suxproxy/fetch` (uhttpd, procd `suxproxy`); Funnel `tailscale funnel --bg 8787`. HMAC secret in `/etc/sux-proxy.secret`.
- **Mac render:** `sux/mac-render/render_server.py` (async patchright). launchd `com.sux.render` (RunAtLoad+KeepAlive) runs `run.sh` → `caffeinate -s python3 render_server.py`. Funnel `tailscale funnel --bg 8790`. Secret in `~/.sux-render.secret`. Install: `pip3 install --user patchright aiohttp && python3 -m patchright install chromium`.
- **/health** shows all three pillars + cache hit-rate + residential-route ratio. `/metrics`, `/logs`, `/feedback` for observability. `/s/<uuid>` serves CAS blobs.
- **After a schema-changing deploy, reconnect the MCP connector** — it caches `tools/list`.

### Endpoint reference
`https://sux.colinxs.workers.dev` — `/mcp` (OAuth), `/health`, `/metrics`, `/logs`, `/feedback`, `/s/<uuid>`.

---

## Lessons learned (gotchas that cost hours)
- **uhttpd drops custom request headers on POST** → HMAC `ts`+`sig` ride the query string, not headers.
- **OpenWRT is musl** → the curl-impersonate `-gnu` build won't run ("required file not found" = missing glibc interpreter); use `-musl`.
- **`base64` isn't installed on the OpenWRT box** → the CGI encodes with `openssl base64`.
- **Tailscale Funnel needs the tailnet HTTPS/funnel feature enabled** + a provisioned cert (`tailscale cert <node>`), not just the ACL nodeAttr.
- **patchright sync API isn't thread-safe** → the render server uses the async API for parallel serving.
- The MCP client caches tool schemas — reconnect after adding params/fns.

---

## Inspiration / roadmap (researched, not yet built)

- **`answer` fn (Perplexity-style)** — the headline idea: `web_search` → residential `scrape`/`render` top-N → `embed`+highlights → `summarize` into a grounded answer with **inline citations**. Pure composition of existing primitives; highest-value addition.
- **`find_similar` fn (Exa-style)** — scrape a URL → `embed` → rank semantically related pages (from crawl/links/entities-seeded search). Neural "more like this."
- **`web_search` upgrades (Tavily-style)** — optional `include_answer` (map-reduce the hits into one answer) and `raw_content` (attach cleaned scraped bodies), cached per URL.
- **`document` pipeline (paperless-ngx / PDF-Tools)** — `scrape/render → pdf → ocr → extract/tables → classify/tag → store` as a named `pipe` preset; plus **search-over-`store`** (full-text index over R2 blobs) — the biggest missing capability, turning `store` into a personal document DB. Searchable-PDF (invisible OCR layer) output.
- **`convert(from,to)` dispatch (Julia multiple-dispatch)** — collapse the converter fns into one generic dispatched on `(from,to)` via a canonical hub type; auto-insert conversions in `pipe` when stage types mismatch.
- **Content-addressed caching (Nix)** — key the cache on the full input closure (fn version + args + upstream ids); per-fn `pure` flag drives TTL; "early cutoff" memoization in `pipe`.
- **Declarative manifest (Nimble)** — per-fn descriptors (`{description, schema, pure, ttl, tags}`) collected by `gen:index`, with `before`/`after` fn lifecycle hooks.
- **Self-hosted ethos** — own the whole path (fetch→process→store→search), single-user, private-by-default, composable Unix-y primitives.
