---
title: Content-Addressed Cache
status: shipped
cluster: infrastructure
type: concept
tags: [sux, infrastructure, shipped]
updated: 2026-07-09
related: ["[[two-hard-facts]]", "[[fn-registry]]", "[[fetch-ladder]]", "[[Infrastructure-MOC]]"]
---

# Content-Addressed Cache

**Source:** [`sux/src/index.ts`](../../../sux/src/index.ts), [`sux/src/mcp-util.ts`](../../../sux/src/mcp-util.ts)

Every `cacheable` fn in the [[fn-registry]] gets a KV entry keyed by `cacheKey`: a sha256 of the fn name (namespaced `::summarize` when the universal `summarize` flag is set) plus a stably-stringified copy of its normalized arguments — same inputs, same key, regardless of key order. `singleFlight` coalesces concurrent identical calls onto one in-flight run so a burst of duplicate requests (or a foreground miss racing a background refresh) pays for exactly one execution. Entries carry a soft-TTL marker in KV metadata; once past it but still inside a **24-hour stale grace** (`CACHE_STALE_GRACE_SECONDS`), a hit is served immediately while `ctx.waitUntil` kicks off a background recompute — stale-while-revalidate, so no caller ever blocks on a refresh. Two invariants hold by construction: `isError` and `noCache` results are returned but never written to KV (an upstream 4xx/5xx never poisons the cache), and stored bytes are zstd/brotli-framed via the cache codec, not raw JSON. See [[two-hard-facts]] for why "never cache a failure" is treated as load-bearing.
