---
title: Filter DSL
status: parked
cluster: retrieval
type: concept
tags: [sux, retrieval, parked]
updated: 2026-07-09
related: ["[[records-envelope]]", "[[verb-algebra]]", "[[search]]", "[[algebra]]"]
---

# Filter DSL

**Source:** [[search]]

A string WHERE-expression grammar, `sux/src/fns/_filter.ts`, owned by [[search]] and consumed by the [[verb-algebra]]'s standalone `filter` fn as a co-signed freeze — one grammar, two callers, never two forks. `compileFilter(expr) -> Predicate & {paths}` compiles clauses like `price < 100 and rating > 4.5` into a predicate that also carries every dotted field path it touches, which is what powers the closed-loop `meta.paths_missing` self-diagnosis on a surprise `out:0`.

The string form won decisively over a lambda (banned — no `eval` on Workers) and over a JSON AST (roughly 5x the tokens, brace-mismatch on nearly every call). A synonym lexer absorbs the likeliest LLM slips — `==`, `&&`, `||`, `contains` — normalizing them to canonical `=`/`and`/`or`/`has` before parsing, so no new grammar production is needed. Operators are `= != > >= < <= has in exists`; a field missing from a record makes its clause **false** for every op except `exists`, which is prefix (`exists price`, `not exists price`) to match the natural negation idiom.

The `~` regex operator is deferred out of v1 — reserved in the grammar, returns a teaching error today — because the only safe implementation is a Thompson NFA (linear, immune to catastrophic backtracking); an unbounded `new RegExp` is explicitly ruled out as unsafe over caller-supplied patterns. See [[records-envelope]] for the output shape `filter` produces.
