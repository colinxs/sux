---
title: Records Envelope
status: parked
cluster: algebra
type: concept
tags: [sux, algebra, parked]
updated: 2026-07-09
related: ["[[verb-algebra]]", "[[fanout]]", "[[filter-dsl]]", "[[handle-discipline]]", "[[algebra]]"]
---

# Records Envelope

**Source:** [[algebra]]

The shared contract every algebra and retrieval verb emits: `{records: Rec[], meta}`, owned by `sux/src/fns/_records.ts`. `records` is always an array of JSON objects with parsed (never re-stringified) values. Failures never live in `records` — they land only in `meta.errors[]`, so "drop the failures" is a no-op by construction rather than a filter the caller has to write.

The module owns four exports: `toRecords` (the lenient reader that coerces arrays, `{records:[...]}` shapes, and `/s/<uuid>` handles into the envelope, and resolves the documented `records:[handleA,handleB]` union idiom), `okRecords` (the emitter wrapper), `safeStringify` (JSON-safe emission that escapes U+2028/U+2029 before the close-boundary's newline normalization can turn them into invalid unescaped control characters), and `dig()` (the one shared dotted-path resolver, replacing four hand-rolled copies across `pipe`/`batch`).

One reserved per-record key exists: `_src`, stamped by fan-out merges and unions for provenance, exempt from the otherwise-flat no-reserved-keys rule so a source-aware predicate survives a multi-backend union. Because every producer emits this same shape, [[verb-algebra]]'s combinators and [[fanout]]'s outcomes compose without per-verb glue.
