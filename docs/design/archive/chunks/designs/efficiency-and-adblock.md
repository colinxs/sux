---
title: Efficiency wins + adblock + storage compression (80/20, KISS)
status: reference — ship the top few, hold the tail
source: audit + research 2026-07-12
---

Filter everything here through [[sux-engineering-taste]]: obvious-good-not-best, ship the top few.
sux is **already good** on caching (in-isolate fetch dedup + 30s TTL, KV result cache w/
stale-while-revalidate + single-flight, `/s/<uuid>` immutable blob cache, `recall`/`search` return
pointers+excerpts). So this is NOT "cache everything" — it's a few targeted wins.

## Top 3 (do first)
1. **Compact JSON on LLM-facing outputs — drop `JSON.stringify(x, null, 2)`.** ~122 sites across ~60
   fns pretty-print to the model. Shared `oj()` helper in `_util.ts`; keep `observability.ts`
   (/metrics,/logs,/feedback) pretty (browser-rendered). **FIX → merge+deploy.** ~5–15% token cut on
   every JSON call; verified low test-risk (tests `JSON.parse`, none assert indentation). Broadest lever.
   ⚠ Sequence AFTER the build fleet lands — it touches mail-mcp/render/etc. that fleet branches also edit.
2. **Vault content index** — `scanVault` (`vault-mcp.ts:43-61`) does up to 500 KV reads + 500 parses
   per `vault_tags`/`vault_query`/`vault_backlinks` call. Cache the derived `{path,fm,tags,links}` array
   (not content) in one KV blob keyed by vault HEAD sha; rebuild only on HEAD change. **FEATURE → PR.**
   ~500 round-trips → 1. This is the "vault indexing" Colin named.
3. **`llms.txt` + shared surface module** — extract the inline `DOMAINS` map (`fns/sux.ts:19-70`) to
   `fns/_surface.ts`, render it as the `sux` tool AND a public `GET /llms.txt` (no secrets,
   `cache-control: public, max-age=3600`). **FEATURE → PR.** Cheap; kills drift; CDN-cacheable tool map.

**Held (lower payoff÷effort, per KISS):** auto-offload oversized binary output to `as:"url"` (#4, decent
but `as:"url"` already exists); auto-pack record arrays to TSV (#5, risks LLM mis-parse — keep opt-in).

## Adblock (token + privacy + quality)
Engine: **`@ghostery/adblocker`** (pure JS, no WASM, runs on Workers; ~1.8MB startup). Keep the
serialized EasyList+EasyPrivacy engine blob in **R2** (already bound), `deserialize` per-request cached
in module scope; **refresh weekly via a Cron Trigger** (don't parse lists per-request; don't bundle the
>1MB blob into the script).
- **Phase 1 (the token win, no browser): cosmetic strip in `declutter`/`scrape`.** `engine.getCosmeticsFilters({url,hostname,domain})` → feed the plain CSS selectors into native **`HTMLRewriter`** `element(el){el.remove()}` to DELETE ad DOM before token-pack. Replaces `declutter.ts`'s hand-rolled `CLUTTER` regex. Skip uBO procedural filters (`:has`/`:xpath`/`+js`) — HTMLRewriter can't do them.
- **Phase 2: render-time network block** — fold `engine.match(...)` into `render.ts`'s `block_resources` interception to drop ad/tracker requests of any type (precise; faster/cheaper residential renders).
**FEATURE → PR.** Files: `declutter.ts`, `render.ts`, `_util.ts` (shared loader), `wrangler.jsonc` (cron).

## Storage compression (Dropbox/R2/KV into/out) — gzip, KISS
**Default: gzip via native `CompressionStream`** (zero-dep, built into Workers) — transparent compress on
write / decompress on read for text-y blobs in the R2 store + KV + Dropbox app-folder. **Skip
already-compressed types** (pdf/jpg/png/zip/gz — check magic bytes / ext) — no gain, wasted CPU. Prefix a
1-byte magic marker so the read path detects compressed-vs-raw (backward-compatible with existing blobs).
**zstd only if the ratio genuinely justifies a wasm dep** — not the default (Workers-native is gzip).
**FEATURE → PR.** Reversible (marker-gated read).
