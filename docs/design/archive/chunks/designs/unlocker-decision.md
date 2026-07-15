---
title: Paid unlocker rung — provider decision (render chunk arming)
status: reference — wire behind UNLOCKER_* secret, arm later
source: deep-research 2026-07-12 (adversarially verified; Proxyway, ScrapeOps, vendor docs)
---

For retail walls that CF Browser Rendering + residential proxy can't crack (Home Depot / Akamai,
Walmart / PerimeterX-HUMAN):

**PRIMARY: Zyte API.** Benchmarks: 100% on Lowe's (Akamai — only provider to hit perfect), 96% on
Walmart (PerimeterX); ScrapeOps names it best success + performance (99% / 5.1s, refreshed Jul 2026).
**Per-successful-request billing** (blocked/rate-limited = free, returned as HTTP 520). ~**$0.95/1k**
retail loads. Can return **structured product JSON** (`"product": true`).

**FALLBACK: Bright Data Web Unlocker.** Most dependable tested (zero failures), 98–99% Walmart,
~**$1.50/1k** PAYG. Distinct vendor/anti-bot stack → de-correlates failure from Zyte.

**CF-Worker integration — use the REST/Direct-API POST, NOT the HTTP-proxy shape.** A Worker's native
`fetch()` cannot route through an upstream authenticated HTTP proxy (brd.superproxy.io / Zyte proxy
mode), so wire the direct API:

```
// Zyte (primary)
POST https://api.zyte.com/v1/extract
Authorization: Basic <btoa(ZYTE_KEY + ":")>      // key as username, empty password
Content-Type: application/json
{ "url": "<target>", "httpResponseBody": true }   // + "product": true for structured extract

// Bright Data (fallback)
POST https://api.brightdata.com/request
Authorization: Bearer <BRIGHTDATA_KEY>
{ "zone": "web_unlocker1", "url": "<target>", "format": "raw" }
```

Both do proxy rotation + anti-bot challenge + CAPTCHA solving server-side in one call.

**Wiring for the render chunk:** the ladder's top rung calls Zyte (`env.UNLOCKER_ZYTE_KEY`), falls back
to Bright Data (`env.UNLOCKER_BRIGHTDATA_KEY`) on Zyte failure; **fail-closed when both unset** (skip
the rung, don't crash). Gate = presence of at least one key. Use for the retail sites cf can't crack
(Home Depot, Costco); Walmart reads only.

**Retire-mac: reinforced.** Per-success billing + single-fetch + proven success on exactly these stacks
means a self-hosted patched-browser node adds cost/maintenance with no capability edge. Paid unlocker
is the reliable rung; any home node is at most a best-effort cost-tier, never critical path.
