# Retailer endpoint reference (for the sux retail fns)

Two fetch primitives available:
- **scrape** — residential IP + curl-impersonate (coherent Chrome JA3/HTTP2). Beats *passive* TLS/fingerprint bot walls. No JS.
- **render backend:"mac"** — patchright headless Chromium on a residential Mac. *Solves active JS challenges* (Akamai `_abck` sensor, PerimeterX press-and-hold). Returns rendered HTML/text/screenshot/pdf. Slower.

The render-based retail fns render via `retailRender` (mac→cf fallback): the Mac backend is primary, and when it's down the fn retries via Cloudflare Browser Run with residential routing + stealth. Proven for Amazon; excluded for Walmart (its press-and-hold needs the Mac gesture). See `docs/retail.md` → "Render resilience".

Difficulty ladder: **Kroger API (official) < Ace < Costco < Lowe's < Home Depot < Walmart < Amazon**.

## Kroger (QFC + Fred Meyer are Kroger banners) — OFFICIAL FREE API ✅
- `POST https://api.kroger.com/v1/connect/oauth2/token` — client-credentials, scope `product.compact`. Needs free `KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET`.
- `GET /v1/products?filter.term=&filter.locationId=&filter.limit=` — price/availability requires a locationId.
- `GET /v1/locations?filter.zipCode.near=&filter.chain=QFC|FRED` — banner via chain filter.
- Clean JSON; no bot wall. (Full details pending the Kroger research agent.)

## Ace Hardware — Kibo/Mozu REST, JA3-only → scrape ✅
- Search: `GET https://www.acehardware.com/api/commerce/catalog/storefront/productsearch/search?query=<q>&pageSize=30&startIndex=0`
- Detail: `GET /api/commerce/catalog/storefront/products/<productCode>` (SKU id, e.g. 7026319; url `/p/<skuId>`)
- May need a per-session anonymous shopper token; Akamai here is fingerprint-only. Highest-probability curl-impersonate win.
- Fields: `items[].productCode/content.productName/price.{price,salePrice}/inventoryInfo.onlineStockAvailable`.

## Costco — Akamai JA3-centric → scrape (validate live) ✅
- Search JSON: `https://search.costco.com/api/apps/www_costco_com/query/www_costco_com_navigation` (401 without warmed `_abck`/`bm_sz`) or HTML `costco.com/CatalogSearch?keyword=<q>`.
- Detail: `costco.com/<slug>.product.<id>.html`. Warehouse via store cookie.

## Lowe's — HTML + embedded JSON → scrape (JA3+IP) ⚠
- Search `www.lowes.com/search?searchTerm=<q>`; detail `www.lowes.com/pd/<slug>/<itemNumber>`.
- Data in `__PRELOADED_STATE__` embedded JSON, not DOM. Store cookie/`store_no`+zip for local price. Akamai + sometimes PerimeterX.

## Home Depot — GraphQL, active Akamai `_abck` → render:mac warmup ⚠
- `POST https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel`
- Headers: `x-experience-name: general-merchandise`, `x-hd-dc: origin`, Origin/Referer homedepot.com, Chrome UA. No API key.
- Ops: `searchModel` (search), `productClientOnlyProduct` (detail), `fulfillment` (stock), `reviews`.
- searchModel vars: `{keyword, storeId, deliveryZip, startIndex, pageSize, orderBy:{field:"BEST_MATCH",order:"ASC"}, storefilter:"ALL", channel:"DESKTOP"}`.
- Needs `_abck`/`ak_bmsc`/`bm_sz` warmed via homepage GET (mac render solves this). Response: `data.searchModel.products[]{itemId,identifiers,pricing,reviews,media}`.

## Walmart — `__NEXT_DATA__` JSON, PerimeterX → render:mac ⚠
- Search `walmart.com/search?q=<q>` → `<script id="__NEXT_DATA__">` → `props.pageProps.initialData.searchResult.itemStacks[0].items`.
- Detail `walmart.com/ip/<itemId>` → `…initialData.data.product` (priceInfo/availabilityStatus/imageInfo).
- Orchestra GraphQL uses rotating persisted-query hashes — impractical; use `__NEXT_DATA__`. PX challenge → mac render.

## Amazon — render:mac → cf fallback (proven) ⚠
- PA-API 5.0 (`webservices.amazon.com/paapi5/searchitems|getitems`, SigV4) needs an approved Associate account (closed to new users, deprecating 2026-05-15).
- Direct: `amazon.com/s?k=<q>` (search) and `amazon.com/dp/<ASIN>` (detail). AWS WAF + image CAPTCHA / Robot Check. Rendered via the Mac backend (auto-escalates to CapSolver on a Robot Check); products from `s-search-result` tiles by ASIN.
- **Fallback:** when the Mac node is down, `amazon` retries via Cloudflare Browser Run with residential routing + stealth — a **proven** pass for Amazon's wall (verified live), running the same extractor on the cf-rendered HTML.

## Build approach
Shared `_retail.ts` helper: pick primitive per retailer (scrape vs render:mac), extract structured products → `{title, price, currency, in_stock, url, image, id, rating}`. Store context (zip/store) as inputs. Fns: `kroger` (banner param), `ace`, `costco`, `lowes`, `homedepot`, `walmart`, `amazon` (best-effort).
