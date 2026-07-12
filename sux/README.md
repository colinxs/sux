# sux — a residential caching web-fetch engine, served over MCP

**sux is a personal, self-owned web-access layer.** It caches and serves from
Cloudflare's edge, but *queries the web from your own residential IP* through
infrastructure you control — so it reaches sites that block datacenters. It does
the fetching, parsing, converting, and AI-summarizing at the edge instead of in
your context window, and exposes the whole thing to any MCP client as a suite of
**small, composable tools** (the exact inventory lives in
[`sux/FUNCTIONS.md`](FUNCTIONS.md)).

> This README is the single source of truth. Everything the project has learned
> — architecture, the bot-detection war, the full function catalog, ops, and
> where it's going — lives here. Deeper dives live under [`docs/`](docs/):
> [architecture](docs/architecture.md), [retail](docs/retail.md),
> [ops](docs/ops.md), and the [retailer endpoint reference](docs/retail-endpoints.md).

---

## The core mission

Own the whole path — **fetch → process → store → search** — as a single-user,
private-by-default service made of small Unix-y primitives. sux is a *caching
residential proxy served over MCP*: it lets an LLM (or any MCP client) reach and
transform the open web from a home IP, cheaply and repeatably, without ever
leaving the MCP boundary.

## The three pillars (never break these)

Everything else is built on top of three load-bearing subsystems. Before
shipping any change, confirm all three still hold.

1. **MCP dispatch** — OAuth-gated (GitHub) JSON-RPC. Only your GitHub login gets
   in; unauth `/mcp` → 401. `sux/src/index.ts` (`handleRpc`),
   `sux/src/github-handler.ts` (`ALLOWED_GITHUB_LOGIN` gate).
2. **Residential egress** — outbound fetches route through a Tailscale
   residential exit, not Cloudflare's datacenter IPs. `sux/src/proxy.ts`
   (`smartFetch` / `willProxy`) for curl-impersonate; `sux/src/mac-render.ts`
   (`macRender`) for the patchright browser. `/health` must show `routing:true`.
3. **Content-addressed cache** — KV/R2 cache keyed on the input closure, per-fn
   TTL, **never caches an upstream error as success**. `sux/src/mcp-util.ts`
   (`deferCacheWrite`), R2 store in `sux/src/fns/store.ts`.

Sanity gate for any change: `/health` shows `routing:true`, an unauth `/mcp`
returns 401, and the cache tests stay green.

---

## Architecture

```
                          Cloudflare Worker "sux"  (the brain / the edge)
                          ┌───────────────────────────────────────────┐
 MCP client ──HTTPS/──▶   │ • GitHub OAuth gate  (ALLOWED_GITHUB_LOGIN) │
 (Claude, any    JSON-RPC │ • small fns / JSON-RPC dispatch             │
  MCP client)             │ • KV cache (per-fn TTL, CAS keys)           │
                          │ • R2 store  (sux-mcp bucket, /s/<uuid>)     │
                          │ • Workers AI · CF Images · Browser Rendering│
                          │ • rate limiter (120/60s per user)           │
                          └──────────────┬──────────────────────────────┘
                                         │ cache miss
                       ┌─────────────────┼──────────────────────────────┐
                       ▼                 ▼                              ▼
              (rung 1) direct    (rung 2) scrape          (rung 3/4) render
              Worker fetch()     Tailscale Funnel →        backend:cf  → CF Browser Rendering
              CF datacenter IP   OpenWRT node running      backend:mac → residential Mac running
                       │         curl-impersonate          patchright (+ CapSolver solver tier)
                       │         (residential IP,           (residential IP, real browser,
                       │          Chrome JA3/JA4/HTTP2)      solves active JS challenges)
                       └─────────────────┴──────────────────────────────┘
                                         ▼
                                     open web
```

### The three machines

- **Cloudflare Worker** (`sux/src/`) — the brain. OAuth, JSON-RPC dispatch, KV
  cache, R2 store (`sux-mcp` bucket), Workers AI, Cloudflare Images, per-user
  rate limiter, and the CF Browser Rendering binding. Deployed to
  `https://sux.colinxs.workers.dev`.
- **OpenWRT node** (`sux/node/openwrt/`) — the residential *fetch* proxy. x86_64
  musl box on the home network, reachable at
  `router.owl-tegu.ts.net`. A uhttpd CGI (`fetch.sh`) shells out to
  **curl-impersonate** (Chrome build), HMAC-authed, exposed via Tailscale
  Funnel on `:8787`. This is **rung 2** (`scrape`).
- **Mac render service** (`sux/mac-render/`) — the residential *browser* render.
  A real Mac on the home network (`colins-macbook-pro.owl-tegu.ts.net`) running
  async **patchright** (parallel, concurrency 4) behind a Tailscale Funnel on
  `:8790`, kept alive by launchd + `caffeinate`. This is **rung 4**
  (`render backend:mac`) and the **solver tier**.

---

## The fetch ladder (bot-detection escalation)

Each rung costs more but defeats more protection. **Pick the lowest rung that
works** for a given host, and let sites that don't fight you stay on rung 1.

| Rung | Path | Egress | Beats | Cost |
|---|---|---|---|---|
| 1. **direct** | Worker `fetch()` | CF datacenter | nothing hostile (APIs, friendly sites) | fast/free |
| 2. **`scrape`** | `smartFetch` → OpenWRT `curl-impersonate` | **residential IP + coherent Chrome JA3/JA4/HTTP2** | datacenter blocks + **passive** TLS/fingerprint walls (most Akamai/CF, Costco) | +1 hop |
| 3. **`render` backend:cf** | Cloudflare Browser Rendering | CF datacenter (subresources residential-routed) | client-rendered JS on **non-hostile** sites | slow |
| 4. **`render` backend:mac** | Mac patchright browser | **residential IP + real browser** | **active JS challenges** — Akamai `_abck` sensor, PerimeterX | slowest |
| 4s. **solver tier** | headed patchright + CapSolver extension on the Mac | residential real browser + human-like gestures | **captchas + press-and-hold** — PerimeterX, DataDome, reCAPTCHA, hCaptcha, Turnstile | slowest |

**`render backend:mac` auto-escalates to the solver tier** when a page looks
blocked (a captcha/challenge string is detected in the rendered DOM). You can
force it up front with `solve:true` for always-walled sites (e.g. Walmart's
PerimeterX) to skip the wasted headless pass.

Why rung 3 (`backend:cf`) rarely helps against hostile sites: CF Browser
Rendering's headless Chrome gets flagged by active sensors, and Workers can't
route its browser egress through a custom proxy (`proxyServer` is unsupported in
Workers). It's for JS-rendered *friendly* pages only. The real bot-wall answer
is rung 4.

---

## The bot-detection war (hard-won knowledge)

Detection is **layered and must be *coherent*** — every layer has to tell the
same story, or you're flagged:

- **IP reputation** — mobile > residential > datacenter. Datacenter IPs are
  blocked on reputation alone. This is why residential egress exists at all.
- **TLS fingerprint** — JA3 (now weak: Chrome permutes TLS extensions since
  Chrome 110) and **JA4** (sorted, stable) read from the ClientHello: cipher and
  extension order, curves, GREASE — sent in cleartext before any HTTP.
- **HTTP/2 fingerprint** — Akamai fingerprints the SETTINGS frame +
  WINDOW_UPDATE + pseudo-header order. Chrome's is a specific signature;
  vanilla `curl`'s is unmistakably different.
- **Header order / coherence** — a "Chrome" User-Agent riding a curl JA3 with
  two headers is an instant flag.
- **Active JS sensor** — Akamai `_abck`/`bmak`, PerimeterX: hundreds of KB of
  obfuscated JS that fingerprints canvas/WebGL/behavior, POSTs encrypted
  `sensor_data` to earn a clearance cookie, then reloads.

**What we learned the hard way:**

- **A residential IP alone is not enough.** `scrape` via *plain* curl on the
  residential node still drew Akamai 403s because curl's JA3/HTTP2 fingerprint
  screams "bot." Fixed by **curl-impersonate** (Chrome build, musl for OpenWRT),
  which matches JA3 + JA4 + HTTP/2 + header order coherently. Let the wrapper own
  the fingerprint headers; forward only *functional* ones (auth, content-type,
  cookie).
- **curl-impersonate beats *passive* detection (403 → 200) but cannot solve
  active JS challenges** — those need a real browser executing the sensor JS.
- **CF Browser Rendering can't beat active challenges either** (see rung 3
  above).
- **The Mac wins** because its public IP *is* a residential IP (it's on the home
  network), so a patched browser there is **real fingerprint + residential IP +
  native TLS — nothing spoofed**, exactly what the sensor is built to pass. We
  use **patchright** specifically because it dodges the CDP `Runtime.enable`
  automation leak that vanilla Playwright/Puppeteer emit. Confirmed pulling real
  Home Depot content where every other rung failed.
- **PerimeterX press-and-hold is SOLVED without CapSolver** — by a *real mouse
  hold gesture* from the residential browser: `page.mouse.move → mouse.down →
  hold for ~seconds with tiny jitter → mouse.up` (`sux/mac-render/render_server.py`).
  That is the exact human action the challenge asks for, so it just passes. This
  is a headline win: no third-party solver needed for Walmart.
- **DataDome / reCAPTCHA / hCaptcha / Turnstile fall to the CapSolver
  extension** loaded into the headed browser (the solver tier). CapSolver is
  headed-only, so this tier runs a headed patchright with a persistent profile.
- **uhttpd drops custom request headers on POST** → the HMAC `ts`+`sig` **ride
  the query string**, not headers (mirrored in headers too, but the query string
  is what always survives). Same scheme for both the OpenWRT node and the Mac.

See [`docs/retail-endpoints.md`](docs/retail-endpoints.md) for per-retailer
specifics.

---

## Function catalog

Auto-generated registry: add `sux/src/fns/<name>.ts` (`export const <name>: Fn`)
and run `npm run gen:index`; ordering is by `scripts/importance.mjs` so the most
useful tools surface first in `tools/list`. Cap is **100 fns** (a ceiling, not a
goal). `fresh:true` is a universal per-call **cache-bypass argument** on every
fn, not a separate tool.

> Six fns were **removed** and are gone for good: `wolfram`, `alphavantage`,
> `etsy`, `tmdb`, `nyt`, `guardian`.

The full, per-function catalog — every fn, its category, test status, and a
one-line summary — is **generated** into [`sux/FUNCTIONS.md`](FUNCTIONS.md) by
`npm run docs` (CI-enforced in sync with the sources). Read it there instead of
a hand-maintained copy here, which only ever drifted.

---

## Retail strategy

Route each retailer to the **lowest working rung** of the fetch ladder. The
shared `_retail.ts` helper normalizes everything to `{id, title, price,
currency, in_stock, url, image, rating}`.

| Retailer | Method | Why / how |
|---|---|---|
| **Kroger** (+ QFC / Fred Meyer / Ralphs / Fry's / King Soopers / Smith's) | **official API** | `api.kroger.com` client-credentials OAuth, zero bot protection. Banners resolve via the `chain` filter. Cleanest by far. Needs free `KROGER_CLIENT_ID`/`SECRET`. |
| **Costco** | **`scrape`** (curl-impersonate) | Akamai wall is JA3/fingerprint-centric → passive; residential Chrome-JA3 fetch of `CatalogSearch` HTML → extract. Falls back with a hint to try `render:mac`. |
| **Ace** | `render:mac` | Kibo/Mozu client-side product grid; invisible reCAPTCHA v3 doesn't block. Extracts `mz-productlisting` tiles. |
| **Lowe's** | `render:mac` | No public API; React catalog returns an empty shell to plain fetch. Renders `/pd/<slug>/<id>` tiles + embedded state. |
| **Home Depot** | `render:mac` | Active Akamai `_abck` sensor → needs a real browser to warm it. Product-pod tiles / `__APOLLO_STATE__`. |
| **Walmart** | **`render:mac` + solver** | PerimeterX **press-and-hold**, forced with `solve:true`. Solved by a real mouse hold gesture (not CapSolver). Lifts `__NEXT_DATA__`. |
| **Amazon** | `render:mac` | No usable free API (PA-API needs an approved Associate account). Renders `s-search-result` tiles by ASIN; auto-escalates to the solver on a Robot Check. |
| **WinCo** | **store-locator ONLY** | See below. |
| Best Buy / eBay | official API (later) | Fns exist and are wired to official APIs, kept dormant until keys are set. |

### WinCo: no product catalog is achievable

**WinCo Foods is a warehouse-style grocer with no e-commerce site** — there is
no online product catalog to fetch, at any rung. It is also **not indexed by
Flipp** (unlike Safeway/Albertsons/Fred Meyer), so there's no weekly-ad backdoor
either. `wincofoods.com` even 403s plain/datacenter fetches, so the `winco` fn
renders the client-side `/stores` directory through `render:mac` and returns
**store locations only** (`id/name/address/city/state/zip/phone/hours`), with
optional `zip`/`state` filters. A WinCo product catalog is **not a solvable
problem** and should not be attempted.

---

## Config / secrets

Set secrets with **`npm run secret:sux <NAME>`** (= `wrangler secret put
--config sux/wrangler.jsonc`). All keys are **optional** — a fn that needs a
missing key degrades to a clear "not configured" message; the rest keep working.

> **Gotcha:** the repo root also contains a *separate, stale* `kagi-mcp` worker
> whose `wrangler.jsonc` is at the repo root. Running a bare
> `wrangler secret put` (no `--config`) targets **that** worker, not sux. Always
> go through `npm run secret:sux` / `npm run deploy:sux` so the `--config
> sux/wrangler.jsonc` flag is applied. (The root worker is slated for
> decommissioning — see Future directions.)

**Auth / core**
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`,
  `ALLOWED_GITHUB_LOGIN` — the OAuth gate (pillar 1).

**Egress (pillar 2)**
- `TAILSCALE_PROXY_URL`, `TAILSCALE_PROXY_SECRET` — the OpenWRT curl-impersonate
  node (rung 2). `TAILSCALE_PROXY_ALL=0` forces direct as an escape hatch.
- `MAC_RENDER_URL`, `MAC_RENDER_SECRET` — the Mac patchright render service (rung 4).
- `GITHUB_TOKEN` — attached only to github.com fetches (lifts 60/hr → 5000/hr);
  also enables private-repo reads + writes for the `obsidian` git backend.

**Search**
- `KAGI_API_KEY` — `search`, `web_search` (kagi engine), `summarize` (URL mode).
- `BRAVE_API_KEY` — `web_search` brave engine. (`web_search` also uses keyless
  DuckDuckGo and a JS-rendered native Google, no SERP-API key needed.)
- `TAVILY_API_KEY` — `tavily`. `EXA_API_KEY` — `find_similar`.

**Retail / places / social**
- `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` — `kroger` (and the daily
  token-warm cron).
- `GOOGLE_MAPS_KEY` — `places`. `BESTBUY_API_KEY` — `bestbuy`.
  `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` — `ebay`. `FACEBOOK_TOKEN` —
  `facebook`. `YOUTUBE_API_KEY` — `youtube`.

**Academic (all optional, raise rate limits only)**
- `NCBI_API_KEY` (`pubmed`), `S2_API_KEY` (`semantic_scholar`),
  `STACKEXCHANGE_KEY` (`stackexchange`).

**Obsidian**
- `OBSIDIAN_VAULT_REPO` (`owner/repo`, live = `colinxs/obsidian-vault`), optional
  `OBSIDIAN_VAULT_BRANCH` / `OBSIDIAN_VAULT_DIR`; or the remote backend's
  `OBSIDIAN_REMOTE_URL` + `OBSIDIAN_REMOTE_KEY`.

**Bindings** (`sux/wrangler.jsonc`, not secrets): `OAUTH_KV` (KV), `AI`,
`IMAGES`, `R2` (`sux-mcp` bucket), `BROWSER` (Browser Rendering),
`MCP_RATE_LIMITER` (120 req / 60 s per user), observability enabled, and a daily
cron trigger `0 13 * * *`.

---

## Operations

### Endpoints (`https://sux.colinxs.workers.dev`)
- `/mcp` — the OAuth-gated JSON-RPC MCP endpoint (unauth → 401).
- `/health` — the three pillars + cache hit-rate + residential-route ratio
  (`routing:true` means requests really exit via the residential IP).
- `/metrics`, `/logs`, `/feedback` — observability (logging/metrics by design,
  no dashboard UI). `/feedback?type=issue` surfaces `issue`-logged reports.
- `/s/<uuid>` — streams content-addressed R2 blobs (the refs `store`/`pdf`/
  `render` mint).

### Deploy & gate
- Deploy: `npm run deploy:sux`. Gate before deploying: `npm run type-check &&
  npm test` (both must be green). Regenerate docs: `npm run docs`. Regenerate
  the fn registry after adding/removing a fn: `npm run gen:index`.

### Mac render service
- `sux/mac-render/render_server.py` (async patchright, `PORT=8790`,
  `CONCURRENCY=4`). launchd job **`com.sux.render`** (RunAtLoad + KeepAlive)
  runs `run.sh` → `caffeinate -s python3 render_server.py`, so the Mac keeps
  serving even when idle.
- Secrets/keys on the Mac: the HMAC secret at `~/.sux-render.secret`; the
  **CapSolver key at `~/.sux-capsolver.key`**; a persistent browser profile at
  `~/.sux-render-profile`.
- **The CapSolver browser extension is downloaded to
  `sux/mac-render/extensions/` and is gitignored — it must NEVER be committed**
  (it embeds the CapSolver key). That directory is in `.gitignore`; keep it that
  way.
- Exposed via `tailscale funnel --bg 8790`.
- **Restart:** `launchctl kickstart -k gui/$(id -u)/com.sux.render`. Logs at
  `/tmp/sux-render.log` and `/tmp/sux-render.err`.

### OpenWRT node
- curl-impersonate (Chrome, **musl** build) behind a uhttpd CGI at `/fetch`,
  HMAC-authed (secret in `/etc/sux-proxy.secret`), exposed via
  `tailscale funnel --bg 8787`. Build/deploy helpers: `npm run build:node` /
  `npm run check:node`.

### After a schema-changing deploy
The MCP client caches `tools/list`. **Reconnect the MCP connector** after adding
or changing fns/params, or it won't see them.

---

## CI/CD

GitHub Actions + a Cloudflare cron cover regression and liveness (workflows
under `.github/workflows/`):

- **`ci.yml`** — on every push and PR: `type-check` (`tsc --noEmit`) + the full
  test suite. Fails the build on any error.
- **`deploy.yml`** — deploys to Cloudflare on `main`.
- **`health.yml`** — a **daily** (09:17 UTC) regression canary: re-runs the
  tests and smoke-checks the live Worker, opening/updating a tracking issue on
  failure so a broken deploy or drifted dependency is caught even on a quiet day.
- **Cloudflare cron** (`0 13 * * *`, `scheduled()` in `sux/src/index.ts`) — a
  best-effort daily maintenance tick that keeps the Kroger client-credentials
  OAuth token warm in KV so the first `kroger`/`shop` call of the day skips the
  mint latency. Wrapped so it can never throw.

### Observability → Grafana Cloud

Every tool call is recorded by `recordCall` (structured Workers log + folded into
KV metrics, exposed at `/metrics` in Prometheus format). When the three
`GRAFANA_LOKI_*`/`GRAFANA_LOKI_TOKEN` secrets are set, `sux/src/grafana.ts` also
ships each call event to **Grafana Cloud Loki** as a JSON line (labels
`service="sux"`, `tool`, `level`) — fire-and-forget via `ctx.waitUntil`, so it
adds no request latency and is inert until configured. Derive rate/latency/error
panels in Grafana with LogQL (e.g. `quantile_over_time` on the unwrapped `ms`).
Set it up: `npm run secret:sux GRAFANA_LOKI_URL` (the `…/loki/api/v1/push` URL),
`GRAFANA_LOKI_USER` (numeric instance ID), `GRAFANA_LOKI_TOKEN` (Access Policy
token, `logs:write`).

---

## Gotchas that cost hours

- **uhttpd drops custom request headers on POST** → HMAC `ts`+`sig` ride the
  query string, not headers (full rationale under [The bot-detection war](#the-bot-detection-war-hard-won-knowledge)).
- **OpenWRT is musl** → the curl-impersonate `-gnu` build won't run ("required
  file not found" = missing glibc interpreter); use the `-musl` build.
- **`base64` isn't installed on the OpenWRT box** → the CGI encodes with
  `openssl base64`.
- **Tailscale Funnel needs the tailnet's HTTPS/funnel feature enabled** + a
  provisioned cert (`tailscale cert <node>`), not just the ACL nodeAttr.
- **patchright's sync API isn't thread-safe** → the render server uses the async
  API to serve in parallel.
- **CapSolver is headed-only** → the solver tier runs a headed patchright with a
  persistent profile; it can't run in a pure-headless pass.
- **The MCP client caches tool schemas** → reconnect after changing fns/params (see [After a schema-changing deploy](#after-a-schema-changing-deploy)).

---

## Future directions / suggestions

- **`weekly_ad` fn backed by Flipp** — a real, untapped opportunity: Flipp
  *does* index weekly circulars with prices for Safeway, Albertsons, and Fred
  Meyer (among others). A `weekly_ad` fn could surface real weekly deal prices
  for those chains cheaply. **WinCo stays blocked** (not on Flipp, no catalog) —
  don't chase it.
- **Broader solver coverage** — extend the mac solver tier (block detection +
  CapSolver task types) to more captcha variants as new retailers/sites are
  added; keep the "real gesture beats the challenge" pattern where it applies.
- **Wire `bestbuy` / `ebay`** (and `facebook`/`youtube`) — the fns are built and
  point at official APIs; they just need keys set to go live.
- **Decommission the stale root `kagi-mcp` worker** — the MCP connector uses
  sux; the root worker is legacy and its bare-`wrangler` config is a footgun
  (see the secrets gotcha). Retire it.
- **Grow test coverage** — every fn has a `*.test.ts`; keep the ratio up as fns
  are added, and lean on the daily `health.yml` canary.
- **Rotate the CapSolver key** — a CapSolver key briefly landed in the private
  repo before the extension dir was gitignored. Rotate it and keep
  `sux/mac-render/extensions/` out of git permanently.
- **Reconnect reminder** — bake an operational habit of reconnecting the MCP
  connector after any schema-changing deploy.

Longer-horizon ideas (composition-first, all built from existing primitives): an
`answer` fn (Perplexity-style `web_search → scrape/render top-N → summarize`
with inline citations); search-over-`store` (full-text index over R2 blobs,
turning `store` into a personal document DB); and a generic
`convert(from,to)` dispatch collapsing the converter fns into one. See
[`docs/architecture.md`](docs/architecture.md) for the design notes.
