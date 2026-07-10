---
title: Verb Algebra
status: parked
cluster: algebra
type: concept
tags: [sux, algebra, parked]
updated: 2026-07-09
related: ["[[records-envelope]]", "[[fanout]]", "[[two-hard-facts]]", "[[algebra]]"]
---

# Verb Algebra

**Source:** [[algebra]]

Four generic combinators — `map`, `filter`, `reduce`, `augment` — operating over the [[records-envelope]] instead of one bespoke fn per data shape. The structural thesis: every amplification cap that existed pre-design (`batch`, `pipe`, `batch_fetch`) existed because every map was assumed effectful — one element, one tool run, one upstream fetch. Splitting the envelope in two dissolves that assumption.

A **pure** algebra (`map`/`filter`/`reduce` over records already in hand) is single-invocation, fetches nothing, is cacheable like `json` (`ttl:86400`), and is freely composable inside `pipe`/`batch` — no cap applies. An **effectful** algebra (`batch`, `batch_fetch`, `crawl`, `augment`) keeps the sacred amplification caps, now denominated in *subrequests* rather than joins or steps, because subrequests are what Cloudflare actually counts.

Both sides are backstopped by one global mechanism: a per-request subrequest ledger, `env._budget` (`REQUEST_SUBREQ_BUDGET = 900`), decremented by every fan-out slot, handle resolution, and LLM inference call. The ledger soft-truncates a run — stamping `meta.truncated:true` — well before Cloudflare's hard 1102 subrequest limit fires, so composition never hard-fails; it degrades honestly. See [[two-hard-facts]] for the sibling deadline constant this ledger coexists with, and [[fanout]] for the shared dispatch core both algebra halves ride on.
