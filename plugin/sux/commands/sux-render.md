---
description: Fetch or screenshot a page through sux, escalating to the residential mac backend for bot-walled sites.
---

Retrieve **$ARGUMENTS** (a URL, or a URL plus what to capture) through the sux
MCP connector, escalating only as far as needed.

Escalation ladder (stop at the first rung that returns real content):
1. `scrape` — raw HTML via the residential proxy. Try this first for static or
   server-rendered pages.
2. `render` with `backend:"cf"` — headless Chromium that executes JS. Use when
   the page is empty without JavaScript. Options: `as` (`html`|`text`|
   `screenshot`|`pdf`), `wait_until`, `wait_ms`, `block_resources`.
3. `render` with `backend:"mac"` — residential patched browser (patchright) that
   solves active JS bot challenges (Akamai/PerimeterX/DataDome). Use for sites
   that return an empty shell or a challenge under `cf` (Home Depot, Walmart,
   Lowe's, Amazon, Google, etc.).
4. Add `solve:true` (mac only) to force the CapSolver headed tier if a captcha
   still blocks the page.

Notes:
- `render as:"screenshot"` / `as:"pdf"` returns a content-addressed `/s/<uuid>`
  URL by default (`delivery:"base64"` to inline).
- `residential` and `stealth` default to true — keep them on for walled sites.
- To read the fetched content, follow with `readability`, `extract`, `tables`,
  `metadata`, or `select` (each accepts the `html` you already rendered).
