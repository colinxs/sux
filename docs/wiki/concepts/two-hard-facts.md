---
title: The Two Hard Facts
status: meta
cluster: infrastructure
type: concept
tags: [sux, infrastructure, meta]
updated: 2026-07-09
related: ["[[content-addressed-cache]]", "[[fn-registry]]", "[[verb-algebra]]", "[[ROADMAP]]"]
---

# The Two Hard Facts

**Source:** [[ROADMAP]]

Two Worker platform constants that every fan-out and every caching decision in the sux design has to respect, because nothing about them can be negotiated away.

**Fact one — `FN_DEADLINE_MS = 60_000`.** This wraps every `fn.run` call (`index.ts:41,252`) and abandons the entire run on timeout with **zero partials** — a bare error, nothing salvageable. Every fan-out verb therefore runs its own internal ~45–50s soft budget, races its slots, and returns whatever settled as a **success envelope** well before the hard wrapper can fire. This is why [[fanout]] and the effectful half of the [[verb-algebra]] treat "soft-truncate with `meta.truncated:true`" as the default failure mode rather than an edge case — the alternative is losing everything.

**Fact two — `CACHE_STALE_GRACE_SECONDS = 86_400`.** A result cached with `ttl:300` is still served stale for up to 24 hours past that ttl (`mcp-util.ts:58`). For a live-data verb this is dishonest by default, so such verbs must explicitly override it — either `Fn.staleGrace` (e.g. 600 for search/shop) to cap the stale window, or `cacheable:false` outright (teach/ask/edit, jmap). Partial-error envelopes are always marked `noCache`, never allowed to freeze a transient failure into the response cache.

Together these two constants are the honesty contract every verb's docstring implicitly promises: bounded wall-time with graceful partials, and freshness that means what it says.
