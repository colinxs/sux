# Retail strategy (deep dive)

Complements the retail section of the [README](../README.md) and the
[endpoint reference](retail-endpoints.md). The rule is one line: **route each
retailer to the lowest fetch-ladder rung that works**, and normalize every
result to the shared retail shape.

## The shared shape (`sux/src/fns/_retail.ts`)

```
{ id, title, price, currency, in_stock, url, image, rating }
```

Every retail fn extracts to this, so a caller gets the same structure whether
the data came from an official API, a curl-impersonate HTML scrape, or a
rendered page.

## Difficulty ladder

```
Kroger API (official)  <  Ace  <  Costco  <  Lowe's  <  Home Depot  <  Walmart  <  Amazon
     easiest / cleanest                                                    hardest
```

## Per-retailer

| Retailer | Rung | Wall | Extraction |
|---|---|---|---|
| **Kroger** (+ QFC, Fred Meyer, Ralphs, Fry's, King Soopers, Smith's) | official API | none | `api.kroger.com` client-credentials OAuth; banners via `chain`; prices need a `location_id` (or a `zip` to auto-resolve). |
| **Ace** | `render:mac` | invisible reCAPTCHA v3 (doesn't block) | Kibo/Mozu `mz-productlisting` tiles from the rendered grid. |
| **Costco** | `scrape` (curl-impersonate) | Akamai, JA3/fingerprint-centric → **passive** | `CatalogSearch` results HTML; fails with a hint to try `render:mac` if Akamai serves the challenge page. |
| **Lowe's** | `render:mac` | Akamai (± PerimeterX); React shell | embedded state blob when present, else `/pd/<slug>/<id>` tiles. |
| **Home Depot** | `render:mac` | **active Akamai `_abck` sensor** | warm the sensor via a real browser, then read the product-pod tiles / `__APOLLO_STATE__`. |
| **Walmart** | `render:mac` + **solver** | **PerimeterX press-and-hold** | force `solve:true`; a real mouse hold gesture passes the challenge (no CapSolver); products from `__NEXT_DATA__`. |
| **Amazon** | `render:mac` | AWS WAF + image CAPTCHA / Robot Check | `s-search-result` tiles by ASIN; auto-escalates to the solver on a Robot Check. No usable free API (PA-API needs an approved Associate account, deprecating 2026-05-15). |
| **WinCo** | `render:mac`, **locations only** | 403s plain fetches | **no online product catalog exists** — renders `/stores` and returns store locations only. |
| **Best Buy** | official API (dormant) | none | Best Buy Products API; needs `BESTBUY_API_KEY`. |
| **eBay** | official API (dormant) | none | eBay Browse API; needs `EBAY_CLIENT_ID`/`SECRET`. |

## Why the press-and-hold win matters

Walmart's PerimeterX challenge asks a human to press and hold a button. Instead
of paying a captcha solver, the Mac render service performs the *actual* gesture
from the residential browser (`sux/mac-render/render_server.py`):

```
mouse.move(near button, jittered)
mouse.down()
  hold ~seconds, nudging by a pixel or two every few hundred ms
mouse.up()
```

Because it's a real gesture from a real browser on a residential IP, it simply
satisfies the challenge. CapSolver is reserved for the captcha families that
*can't* be gestured away — DataDome, reCAPTCHA, hCaptcha, Turnstile.

## WinCo: not a solvable catalog

WinCo Foods is a warehouse-style grocer with **no e-commerce catalog** and it is
**not indexed by Flipp**. There is no rung of the ladder that yields products,
because there are no online products to fetch. The `winco` fn is deliberately
locations-only. Do not spend effort trying to build a WinCo product catalog.

## Opportunity: a Flipp-backed `weekly_ad` fn

Flipp *does* index weekly circulars with prices for **Safeway, Albertsons, and
Fred Meyer** (among many chains). A `weekly_ad` fn over Flipp would surface real
weekly deal prices for those retailers cheaply — a genuine, untapped opening.
WinCo remains out of reach (see above).
