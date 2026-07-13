# Shopping, Places & Misc Integrations — durable reference

Ground-truth distillation of the sux edge-fn integrations for **shopping / retail**,
**places**, and **misc** (crypto, YouTube, Wayback, social scrapers). Written so future
sessions never re-fetch these. Code paths are `sux/src/fns/<fn>.ts`; line refs are
current as of this writing (verify with grep if a file moved).

All retailer fns emit ONE normalized shape (`_retail.ts`):
`{ retailer, action, count, products:[{ id, title, brand?, price?, promo_price?, currency, fulfillment?, size?, image?, url?, in_stock?, condition? }] }`.
`normalizeMoney` (`_retail.ts:37`) coerces `"$1.23"`/`"1.23"`/number → positive number, else `undefined` (0 = "no price").

---

## Shopping — the big picture

Two orchestrators sit over the per-retailer fns; neither scrapes itself:

- **`shop`** (`shop.ts`) — a **dispatcher/router**. Pick ONE `store`; it maps `{query, limit, zip}` → that retailer fn's args and returns the result verbatim. The old SerpAPI / Google Shopping path is **dead** (SerpAPI killed its product engine; Google Shopping needs JS + anti-bot). `store` enum: `amazon, walmart, home_depot, lowes, ace, costco, kroger, fred_meyer, deals`. `deals` → `weekly_ad` (Flipp), requires a 5-digit `zip`. `home_depot`→`homedepot` honors `zip`; `kroger`/`fred_meyer` `zip` auto-resolves a store for prices; `fred_meyer` = Kroger `chain` filter. `limit` 1..25 (default 10). Dispatch is a dynamic `import("./index")` to dodge the shop↔index cycle (`shop.ts:67`).
- **`product_search`** (`product_search.ts`) — a **fan-out**. One `term` across `[kroger, walmart, homedepot, amazon, lowes, costco, ace]` (`product_search.ts:18`) concurrently via `Promise.allSettled`; per-retailer failure is isolated into `errors[]`, never aborts the rest. `retailers` narrows the subset; `zip` only reaches kroger; `limit` 1..100 (default 30). Returns `{ term, count, by_retailer, products:[{…,retailer}], errors:[{retailer,error}] }`. (Note: fans across the 7 scrape/API retailers — **not** bestbuy/ebay.)

### API vs scrape — the load-bearing split

| Retailer | Path | Backend / wall | Auth |
|---|---|---|---|
| **Best Buy** | **API** | `api.bestbuy.com` REST, no bot wall | `BESTBUY_API_KEY` (query string) |
| **eBay** | **API** | `api.ebay.com` Browse REST | OAuth2 client-credentials |
| **Kroger** (+ banners) | **API** | `api.kroger.com` REST | OAuth2 client-credentials |
| **Amazon** | **scrape** | `retailRender` cf→mac ladder; AWS WAF / Robot Check | none |
| **Walmart** | **scrape** | `retailRender`; PerimeterX press-and-hold (mac `solve:true`) | none |
| **Home Depot** | **scrape** | `retailRender` → paid unlocker; Akamai `_abck` (hardest wall) | none (unlocker gated `UNLOCKER_API_*`) |
| **Costco** | **scrape** | `smartFetch` residential proxy (JA3/TLS) → unlocker; NO render backend | none |
| **Lowe's** | **scrape** | `retailRender` cf→mac; client-side React shell | none |
| **Ace** | **scrape** | `retailRender` cf→mac; Kibo/Mozu, invisible reCAPTCHA v3 | none |
| **weekly_ad** (Flipp) | **keyless API** | `backflipp.wishabi.com`, no wall | none |

Scrapers extract best-effort, per-tile try/catch, never throw; zero-products disambiguated (challenge vs layout change). Rendering ladder = Cloudflare Browser Rendering (residential + stealth) DEFAULT → mac node (headed patched browser + CapSolver) fallback → paid residential unlocker (HD/Costco only, gated). Walmart's real wall needs the mac press-and-hold gesture (`solve:true`) — no cf/puppeteer equivalent.

---

### Best Buy
- **Purpose**: Product search + SKU detail across Best Buy's catalog (official Products API, free, clean REST, no bot wall).
- **Auth**: `BESTBUY_API_KEY` — single key on the **query string** (`apiKey=`), no OAuth. Free at developer.bestbuy.com.
- **Base URL**: `https://api.bestbuy.com/v1`
- **Endpoints sux calls** (`bestbuy.ts`): search → `/products((search=<term>))?...` (`bestbuy.ts:76`); detail → `/products/<sku>.json?...` (`bestbuy.ts:66`). `show` mask = `sku,name,salePrice,regularPrice,onlineAvailability,image,url,manufacturer` (`bestbuy.ts:10`).
- **Code pattern**:
  ```ts
  const p = new URLSearchParams({ apiKey: key, format: "json", show: SHOW, pageSize: String(limit) });
  const j = await api(`${API}/products((search=${encodeURIComponent(term)}))?${p}`);
  ```
- **Limits/gotchas**: promo_price only when salePrice < regularPrice. `limit` 1..50 (default 15). Not in `product_search`/`shop` fan-outs — call `bestbuy` directly. Free tier historically ~5 req/s, 50k/day.
- **Refs**: https://developer.bestbuy.com/ · API docs https://bestbuyapis.github.io/api-documentation/

### eBay
- **Purpose**: Search eBay's live marketplace listings by keyword (Browse API).
- **Auth**: `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — **OAuth2 client-credentials**. App token minted once, KV-cached (`OAUTH_KV`, key `sux:ebay:token`) until just before expiry via shared `_oauth.ts`. Scope `https://api.ebay.com/oauth/api_scope`, `defaultTtl` 7200. `api()` self-heals a 401/403 by deleting the KV token and re-minting directly (`ebay.ts:23-33`).
- **Base URL**: `https://api.ebay.com/buy/browse/v1` · token `https://api.ebay.com/identity/v1/oauth2/token`
- **Endpoints sux calls** (`ebay.ts`): search → `/item_summary/search?q=<term>&limit=<n>` (`ebay.ts:78`).
- **Code pattern**:
  ```ts
  const oauth = (env) => ({ tokenUrl: "https://api.ebay.com/identity/v1/oauth2/token",
    clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET,
    cacheKey: "sux:ebay:token", scope: "https://api.ebay.com/oauth/api_scope", defaultTtl: 7200 });
  ```
- **Limits/gotchas**: search-only (no product-detail action). `limit` 1..50 (default 15). `condition` field is populated (used vs new). Not in fan-outs. Production keyset needed (sandbox differs). Marketplace default US.
- **Refs**: https://developer.ebay.com/api-docs/buy/browse/overview.html · OAuth client-creds https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html · OpenAPI in the Buy Browse docs.

### Kroger
- **Purpose**: Product search, prices, store locations across Kroger + banners (QFC, Fred Meyer, Ralphs, Fry's, King Soopers, Smith's) via the `chain` filter.
- **Auth**: `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` — **OAuth2 client-credentials**, scope `product.compact`, KV key `sux:kroger:token`, `defaultTtl` 1800, `retry:true` (mint has no side effect). Shared `_oauth.ts`; same 401/403 delete-and-remint self-heal (`kroger.ts:32-44`). GETs wrapped in `withRetry` (idempotent).
- **Base URL**: `https://api.kroger.com/v1` · token `.../v1/connect/oauth2/token`
- **Endpoints sux calls** (`kroger.ts`): `search`→`/products?filter.term=&filter.limit=&filter.locationId=` (`:159`); `locations`→`/locations?filter.zipCode.near=&filter.limit=&filter.chain=` (`:46`); `product`→`/products/<id>?filter.locationId=` (`:146`). Prices/availability require a store, so `zip` auto-resolves a `locationId` first (`resolveLocationId` `:97`).
- **Code pattern**:
  ```ts
  if (!locationId && zip) locationId = (await resolveLocationId(env, zip, chain)) ?? "";
  const p = new URLSearchParams({ "filter.term": term, "filter.limit": String(limit) });
  if (locationId) p.set("filter.locationId", locationId);
  ```
- **Limits/gotchas**: no store → no prices (regular/promo blank). `limit` 1..50 (default 15). This is the ONE retailer in `product_search` that consumes `zip`. Public API tier is rate-limited (per-app quota; product.compact scope only). `fred_meyer` in `shop` = this fn + `chain:"Fred Meyer"`.
- **Refs**: https://developer.kroger.com/reference/ · OpenAPI/reference under Products + Locations APIs.

### Amazon (scrape)
- **Purpose**: Search/product from Amazon's HTML (no usable free API — Product Advertising API needs affiliate approval).
- **Auth**: none. **Path**: `retailRender` cf→mac ladder (`amazon.ts:4`).
- **Wall/gotchas**: AWS WAF / "Robot Check". cf residential+stealth is the PROVEN default (verified live); mac is dormant fallback. Challenge markers: `Robot Check`, `Enter the characters you see`, `api-services-support` (`amazon.ts:27`) → reported distinctly from layout-change. ASIN = 10 uppercase alnum. Parses `data-asin`/`s-search-result` tiles, dedup by asin.
- **Refs**: internal `docs/retail.md`; no external API.

### Walmart (scrape)
- **Purpose**: Search/product from Walmart pages.
- **Auth**: none. **Path**: `retailRender` (cf first, mac fallback with `solve:true`).
- **Wall/gotchas**: PerimeterX JS challenge; real wall is a **press-and-hold gesture only the mac Python service passes** (`walmart.ts:56-64`). Extracts from `__NEXT_DATA__` JSON blob (`props.pageProps.initialData…`) — stable vs the rotating Orchestra GraphQL hashes. GUARDRAIL: any future cart/checkout action must use the mac path, not cf.
- **Refs**: internal `docs/retail.md`.

### Home Depot (scrape)
- **Purpose**: Search from HD pages (honors `zip`).
- **Auth**: none; unlocker gated on `UNLOCKER_API_*` (no-op when unset). **Path**: `retailRender` cf→mac → paid residential unlocker.
- **Wall/gotchas**: Akamai `_abck` — the **hardest** retailer wall. Extraction: `window.__APOLLO_STATE__` blob first (`homedepot.ts:120`), else product-pod anchors.

### Costco (scrape)
- **Purpose**: Search from Costco CatalogSearch HTML.
- **Auth**: none; unlocker gated `UNLOCKER_API_*`. **Path**: `smartFetch` **residential proxy** (curl-impersonate Chrome TLS/HTTP2) → unlocker. **NO render backend** (mac/cf never tried) — the wall is JA3/fingerprint-centric, not IP-centric.
- **Gotchas**: extracts embedded JSON first, product tiles fallback; zero-products disambiguated Akamai-block vs layout-change.

### Lowe's (scrape)
- **Purpose**: Search from Lowe's React app pages (no public API).
- **Auth**: none. **Path**: `retailRender` cf→mac; renders fine without captcha (no force-solve). Extraction: `"productId"` state-blob scan first, `/pd/…` anchors fallback. `BLOCKED_MSG` vs layout-change via `looksBlocked` (`lowes.ts`).

### Ace Hardware (scrape)
- **Purpose**: Search from Ace pages (Kibo/Mozu platform, no public API).
- **Auth**: none. **Path**: `retailRender` cf→mac. Invisible reCAPTCHA v3 scores but doesn't wall → never force-solve. Parses `mz-productlisting` tiles, `/p/<slug>/<sku>` anchors.

### weekly_ad (Flipp)
- **Purpose**: Grocery weekly-ad deals across every merchant Flipp indexes for a ZIP.
- **Auth**: none (keyless). **Base URL**: `https://backflipp.wishabi.com/flipp/items/search` (`weekly_ad.ts:749`).
- **Gotchas**: `term` + 5-digit `zip` required; `merchant` = case-insensitive substring filter; `limit` 1..50 (default 20). Carries Safeway/Albertsons/Fred Meyer/Kroger siblings; **NOT WinCo** (WinCo runs no flyer). Extra fields: `original_price, merchant, merchant_logo, valid_to`. Deals rotate weekly (modest ttl). `shop store='deals'` routes here.
- **Refs**: unofficial Flipp backend — no public docs.

---

## Places

### Google Places (Maps)
- **Purpose**: Local business / point-of-interest text search from a free-text query.
- **Auth**: `GOOGLE_MAPS_KEY` — key on the **`X-Goog-Api-Key` header** (Places API New). Free credit at console.cloud.google.com.
- **Base URL**: `https://places.googleapis.com/v1/places:searchText` (`places.ts:285`) — one POST.
- **Endpoints/pattern**: POST with a **field mask** naming exact fields: `places.displayName,places.formattedAddress,places.rating,places.priceLevel,places.location,places.websiteUri,places.nationalPhoneNumber` (`places.ts:286`). Returns normalized `{ name, address, rating, price_level, phone, website, lat, lng }`.
- **Limits/gotchas**: `max_results` 1..20 (default 10). Field mask is REQUIRED and controls billing SKU tier — keep it minimal. `GOOGLE_MAPS_KEY` is the **same key** the `youtube` fn's Data API uses if enabled on one project. ttl 900.
- **Refs**: https://developers.google.com/maps/documentation/places/web-service/text-search · OpenAPI in the Places API (New) reference.

---

## Misc

### CoinGecko (crypto)
- **Purpose**: Crypto spot prices + coin search.
- **Auth**: **keyless** free tier (no proxy — public market-data API, no wall).
- **Base URL**: `https://api.coingecko.com/api/v3` (`coingecko.ts:332`).
- **Endpoints sux calls**: price → `/simple/price?ids=&vs_currencies=&include_24hr_change=true` (`coingecko.ts:366`); search → `/search?query=` → `{ id, name, symbol, market_cap_rank }`.
- **Gotchas**: `action` price needs comma-separated `ids` (e.g. `bitcoin,ethereum`), search needs `term`; `currency` default `usd`. Prices volatile → ttl 120. Keyless tier rate-limited (~5-15 calls/min public) — no key config wired.
- **Refs**: https://docs.coingecko.com/reference/introduction · OpenAPI at https://docs.coingecko.com/openapi

### YouTube
- **Purpose**: Video **search + metadata** (view/like counts, duration).
- **Auth**: `YOUTUBE_API_KEY` — Data API v3 key on the **query string**. Free at console.cloud.google.com (enable YouTube Data API v3). Distinct env var from `GOOGLE_MAPS_KEY` though both are Google Cloud keys.
- **Base URL**: `https://www.googleapis.com/youtube/v3` — `/search` + `/videos` (`youtube.ts:377-378`).
- **Endpoints/pattern**: `search` → `/search?q=&type=video`; optional enrich → `/videos?id=&part=statistics,contentDetails`. Returns `{ id, title, channel, published, description, thumbnail, url, views?, likes?, duration? }`.
- **Gotchas**: Data API v3 has a **hard 10,000 units/day quota** — a `search.list` costs 100 units, so ~100 searches/day. Enrichment adds a `videos.list` call. **Subtitle fetching is NOT here** — the `subtitles` fn (`subtitles.ts`) is a pure **SRT↔VTT format converter**, and YouTube transcript summarization goes through **Kagi's summarizer** (`summarize.ts:6` — Kagi pulls the transcript; the local path has none). The `www.youtube.com` mention refers to public watch-page URLs the metadata references, not a subtitle scrape.
- **Refs**: https://developers.google.com/youtube/v3/docs · quota https://developers.google.com/youtube/v3/getting-started#quota

### Wayback (Internet Archive)
- **Purpose**: Archived-snapshot lookup + capture history (great for price/change history).
- **Auth**: none (keyless, public).
- **Base URLs**: availability `https://archive.org/wayback/available?url=&timestamp=` (`wayback.ts:502`); history CDX `https://web.archive.org/cdx/search/cdx?...` (`wayback.ts:487`).
- **Endpoints/pattern**: `mode='snapshot'` (default) → closest capture to `at` (YYYYMMDD[hhmmss], default latest) → `{ available, url, raw_url, timestamp }`. `mode='history'` → CDX list (`collapse=digest`, `fl=timestamp,original,statuscode,digest`, `limit` 1..500 default 50) → `{ count, captures:[{timestamp,statuscode,url}] }`.
- **Gotchas**: 20s fetch timeout; ttl 300 (latest shifts as captures land). Snapshot URL form `https://web.archive.org/web/<ts>/<original>`.
- **Refs**: availability API https://archive.org/help/wayback_api.php · CDX https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md

### Reddit (non-research scraper)
- **Purpose**: Read-only Reddit (posts/comments/about).
- **Auth**: **KEYLESS-FIRST** — Reddit blocks self-serve OAuth app creation, so default appends `.json` to any public path (same JSON shape as the OAuth API). Keyless fetch MUST go through the **residential proxy** (`smartFetch` route `proxy`) with a descriptive `User-Agent` — datacenter IPs are blocked; the residential exit is why keyless works (`reddit.ts:517`). If `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are set → auto-upgrade to app-only OAuth (KV `sux:reddit:token`, mint at `www.reddit.com/api/v1/access_token`, calls to `oauth.reddit.com`) for higher rate limits.
- **Base URLs**: keyless `https://www.reddit.com` (+`.json`); OAuth `https://oauth.reddit.com` (`reddit.ts:530,535`).
- **Gotchas**: a stable descriptive UA rides EVERY request (both paths) — the generic UA is blocked outright. `RedditBlocked` sentinel maps a 403/challenge to `failWith("blocked", …)` with actionable "try again or set creds". (Distinct from the research-DB Reddit surface in the `search` skill.)
- **Refs**: https://www.reddit.com/dev/api/ · OAuth https://github.com/reddit-archive/reddit/wiki/OAuth2

### Facebook
- **Purpose**: Fetch a Graph node/edge (pages, posts, public profile).
- **Auth**: `FACEBOOK_TOKEN` — a Graph API **access token** (on the query string) with scopes for what you read. Egresses direct (authenticated API, no proxy), 20s timeout.
- **Base URL**: `https://graph.facebook.com/v21.0` (`facebook.ts:561`).
- **Endpoints/pattern**: `/<path>?access_token=&fields=&limit=` where `path` is a node id (`me`, `{page-id}`) or edge (`{page-id}/posts`, `{page-id}/feed`). `path` must be a bare graph path (rejects URLs / `..`). `fields` comma-list; `limit` 1..100. Returns raw Graph JSON.
- **Gotchas**: token scoping is the caller's job; ttl 300. Get a token at developers.facebook.com/tools/explorer. Tokens expire (short-lived unless exchanged).
- **Refs**: https://developers.facebook.com/docs/graph-api · Explorer https://developers.facebook.com/tools/explorer

### LinkedIn (scrape)
- **Purpose**: Public profile/company data.
- **Auth**: none for LinkedIn itself, but needs the **mac render backend** configured (`MAC_RENDER_URL`/`MAC_RENDER_SECRET`). The old Proxycurl API path is **dead** (shut down July 2025 after LinkedIn sued Nubela) (`linkedin.ts:5`).
- **Path/pattern**: renders the public page through the residential `render` **mac backend** (headed browser + CapSolver to clear the bot wall) via `renderHtml` (`linkedin.ts:84`), then extracts **schema.org JSON-LD** (Person/Organization) + `og:` meta, distilled to token-cheap fields (`extractPerson` `:632`).
- **Gotchas**: `action` person (default) or company. Public-page fields ONLY — deeper data needs an authenticated session (not wired). cost 5 (heavy headed render); ttl 86400 (cache hard). Also surfaced as a source inside `people_finder` (`people_finder.ts`).
- **Refs**: no official public-scrape API; JSON-LD is what LinkedIn publishes on the page.

### Related people fns (context)
- **`people`** (`people.ts`) — Kagi people/directory search (`source=web`) or USA.gov federal directory (`source=usagov`); optional `extract_contacts` pulls emails/phones from the top hit via residential proxy. UW-specific → use `uw` fn.
- **`people_finder`** (`people_finder.ts`) — public-source aggregator fanning UW directory (POST to `directory.uw.edu`) + `linkedin` + `facebook` + `web_search`, merged/deduped, per-source errors isolated. Public-only by design (student/suppressed records behind UW-NetID SAML deliberately NOT wired).

---

## Shared plumbing (don't re-derive)
- **`_oauth.ts`** — the mint-once + KV-cache client-credentials lifecycle shared by ebay/kroger/tailscale. `auth:"basic"` (HTTP Basic header, default) vs `"body"` (client_id/secret in form). TTL = `expires_in - 60`, clamped to KV's 60s floor. Per-provider `api()` wrappers own their own 401/403 delete-and-remint self-heal.
- **`_retail.ts`** — `RetailProduct`/`RetailResult` shapes, `normalizeMoney`, `decodeEntities`.
- **Render/proxy ladder** — `retailRender` (cf→mac), `smartFetch`/`withRetry` (`../proxy`), `unlockerRender` (`../unlocker-render`, gated `UNLOCKER_API_*`), `renderHtml`/`macRender`. Detail in `docs/retail.md`.
</content>
</invoke>
