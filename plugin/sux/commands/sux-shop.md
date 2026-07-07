---
description: Product search across retailers (kroger/walmart/homedepot/costco/amazon/lowes/ace) via sux.
---

Find products matching **$ARGUMENTS** using the sux MCP connector's retailer
tools, and return a concise price/availability comparison.

Guidance:
- If the user named a retailer, call its dedicated tool with `action:"search"`
  and `term`: `kroger`, `walmart`, `homedepot`, `lowes`, `ace`, `amazon`, or
  `costco`. For `bestbuy`/`ebay` use those tools.
- For grocery prices, use `kroger` and pass a `zip` (or `location_id`) so prices
  resolve to a store; `chain` selects a banner (QFC, Fred Meyer, Ralphs, …).
- For "find a WinCo store", use `winco` with `action:"locations"` and `zip`/`state`
  (WinCo has no online catalog — locator only).
- If no retailer is specified, use `shop` (Google Shopping across all merchants).
- Each product tool returns the normalized shape
  `{ retailer, count, products:[{ id, title, brand?, price?, in_stock?, url? }] }`.
  Summarize the top matches with price and stock, and compare across retailers
  when several were queried.
- mac-render retailers are slower; if one returns a "blocked / no data" error,
  note it may be a transient backend issue and offer to retry.
