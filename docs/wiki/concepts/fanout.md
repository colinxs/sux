---
title: Fanout
status: parked
cluster: algebra
type: concept
tags: [sux, algebra, parked]
updated: 2026-07-09
related: ["[[records-envelope]]", "[[verb-algebra]]", "[[search]]", "[[shop]]", "[[algebra]]"]
---

# Fanout

**Source:** [[algebra]]

The shared parallel-dispatch core, `sux/src/fns/_fanout.ts`, extracted from three hand-rolled `Promise.allSettled` loops so every fan-out verb gets error isolation and ledger accounting for free. Two exported shapes carry the contract: `Slot<T>` (a keyed unit of work with an optional per-slot subrequest `weight`) and `FanoutOutcome<T>` (`{ok: [...], errors: [...], truncated?}`), plus the `fanout()` function that runs a slot array under a concurrency cap and soft deadline.

`FanoutOutcome` maps 1:1 onto the [[records-envelope]] — `ok[].value` becomes `records`, `errors` becomes `meta.errors` — so it *is* the partial-tolerant dossier shape that search and travel need without either owning it. The caller, not `_fanout`, states its own amplification cap; `_fanout` unifies only the mechanics and enforces the global ledger (`env._budget`), decrementing per started slot and refusing new slots once exhausted rather than dying at Cloudflare's 1102 subrequest wall.

Nesting is tracked on a shallow-cloned environment, never the shared binding: dispatch seeds `{...env, _depth:0, _budget}`, and each recursive call passes `{...env, _depth:_depth+1}` — closing a same-isolate cross-request race. Consumers after retrofit: [[search]], [[shop]], travel, and platform, alongside `batch`, `batch_fetch`, `crawl`, and `augment` from the [[verb-algebra]].
