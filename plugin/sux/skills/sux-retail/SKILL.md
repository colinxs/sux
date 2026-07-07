---
name: sux-retail
description: >-
  Product search and price/availability lookups across major US retailers via
  the sux MCP connector — kroger, walmart, homedepot, costco, amazon, lowes,
  ace (products) and winco (store locator only). Use when the user wants to find
  a product, compare prices, check stock, or locate a store. Every retailer
  returns the same normalized product shape so results can be compared directly.
---

# sux-retail — retailer product search

The **sux** MCP connector exposes one tool per retailer. Prefer a dedicated
retailer tool over generic web search when the user names a store or wants
structured price/stock data — these return a **normalized JSON envelope**, not
scraped prose.

## Normalized shape

Every product tool returns:

```json
{ "retailer": "<name>", "action": "search|product", "count": <n>,
  "products": [
    { "id", "title", "brand?", "price?", "promo_price?", "currency",
      "fulfillment?", "size?", "image?", "url?", "in_stock?", "condition?" }
  ] }
```

`price`/`promo_price` are positive numbers (a non-positive retailer value — its
"no price for this store" signal — normalizes to absent). Because the shape is
shared, you can search several retailers and compare `price`/`in_stock` fields
across them directly.

## Retailer tools

| Tool | Backend | `action` | Key args | Notes |
|------|---------|----------|----------|-------|
| `kroger` | Official free API | `search`, `locations`, `product` | `term`, `zip`, `location_id`, `chain`, `product_id` | Covers QFC, Fred Meyer, Ralphs, Fry's, King Soopers, Smith's via `chain`. **Prices need a store** — pass `location_id` or a `zip` to auto-resolve one. Fast, no bot wall. |
| `walmart` | mac render (PerimeterX solve) | `search`, `product` | `term`, `item_id` | Products from embedded `__NEXT_DATA__`. Slower. |
| `homedepot` | mac render (Akamai) | `search` | `term`, `zip` | `zip` localizes the store. |
| `lowes` | mac render | `search`, `product` | `term`, `item_id` | Client-side React catalog. |
| `ace` | mac render (reCAPTCHA v3) | `search` | `term` | Kibo/Mozu product grid. |
| `amazon` | mac render (auto captcha solve) | `search`, `product` | `term`, `asin` | `id` = ASIN. |
| `costco` | Residential curl-impersonate proxy | `search` | `term` | JA3-centric wall — fetched via proxy, not a browser. If Akamai blocks, it hints to retry through `render backend:mac`. |
| `winco` | mac render | `locations` | `zip`, `state` | **Store locator ONLY — no online catalog.** Lists ~130 stores (id/name/address/city/state/zip/phone/hours). |

All product tools accept `limit` (default 15, max 40; kroger max 50). Search is
the default `action`.

## Broad / cross-merchant search

- **`shop`** — Google Shopping across all merchants (rendered in the mac backend;
  no SERP key). Args: `query`, `limit`. Best-effort (markup churns). If the user
  names a big retailer with a dedicated tool, `shop` redirects you there — use
  the dedicated tool instead for structured data.

## Related

- **`places`** — Google Places: local business / point-of-interest search from a
  free-text `query` (e.g. "hardware store near 98133") → name, address, rating,
  price level, phone, website, coordinates. Use for "find a store near me" when
  the retailer isn't one of the above (needs GOOGLE_MAPS_KEY).
- **`bestbuy`**, **`ebay`** also exist as dedicated tools (electronics /
  marketplace listings) with the same normalized shape.

## Routing guide

- "Cheapest \<product\> at Walmart / Home Depot / Lowe's / Ace / Amazon" →
  the matching retailer tool, `action:search`.
- "Grocery prices" → `kroger` with a `zip` (or `location_id`) so prices resolve.
- "Where's the nearest WinCo?" → `winco action:locations` with `zip`/`state`.
- "Compare price across stores" → run several retailer tools, compare `price`.
- "Just find this product somewhere" → `shop`.
- Costco returns a "blocked, try render backend:mac" hint → fall back to the
  **sux-web** skill's `render backend:mac`.

## Caveats

- mac-render retailers (walmart/homedepot/lowes/ace/amazon/winco) are slower and
  depend on the residential mac backend being up; a `blocked`/`no data` failure
  usually means the backend is down or the site challenged the request — retry.
- Prices/availability are live and briefly cached — treat them as approximate.
