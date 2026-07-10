---
title: The Fn Contract
status: shipped
cluster: infrastructure
type: concept
tags: [sux, infrastructure, shipped]
updated: 2026-07-09
related: ["[[content-addressed-cache]]", "[[two-hard-facts]]", "[[Functions-MOC]]", "[[fetch-ladder]]"]
---

# The Fn Contract

**Source:** [`sux/src/registry.ts`](../../../sux/src/registry.ts), [`sux/src/index.ts`](../../../sux/src/index.ts)

Every one of sux's fns is a single `Fn` object: `{name, description, inputSchema, cacheable?, cost?, ttl?, raw?, run}` (`registry.ts`). `description` is the verbatim text a client sees in `tools/list`, so it doubles as documentation. Failures are typed, not free-text: `FAIL_CODES` (`not_configured`, `blocked`, `timeout`, `rate_limited`, `not_found`, `upstream_error`, `bad_input`, `layout_change`) and the `failWith(code, text)` helper prefix the code onto the message and attach it as a structured `errorCode`. `handleRpc` in `index.ts` runs every call through the same dispatch rails regardless of fn: strip the universal `fresh` (cache bypass) and `summarize` (Workers-AI compression) args before the fn ever sees them, run `checkArgs` (256KB / depth-64 guard), wrap `fn.run` in `withDeadline` at `FN_DEADLINE_MS` = 60s, and `clampResult` the output at 1,000,000 chars. `fn.raw` opts a byte-exact fn (hash/encode/compress/kv/…) out of text normalization. `sux/src/fns/index.ts` and [[Functions-MOC|FUNCTIONS.md]] are both generated from this registry — never hand-edited.
