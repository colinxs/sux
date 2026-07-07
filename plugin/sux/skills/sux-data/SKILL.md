---
name: sux-data
description: >-
  Transform, store, and run lightweight AI over data at the edge via the sux MCP
  connector — convert between markdown/html/csv/json/xml/yaml, build and fill
  PDFs, convert images, compress/archive/encode/hash, token-pack tabular data,
  persist to R2 (store) and KV, and run Workers-AI text tools (summarize,
  translate, classify, ocr, redact). Use for format conversions, file storage,
  and quick AI text tasks without leaving the tool loop.
---

# sux-data — transforms, storage, and edge AI

The **sux** MCP connector runs these at the Cloudflare edge. Prefer them for
deterministic format conversions, byte storage, and light AI text tasks — they
avoid pulling large payloads through the model and dedupe/cache aggressively.

## Format conversion (deterministic, cached)

- **`json`** — anything → JSON. `from`: `auto` (detects json/yaml/csv/xml) |
  `json` | `yaml` | `csv` | `xml`. `delimiter` for csv, `indent`.
- **`csv`** — JSON array of objects → CSV (`delimiter`). Inverse of
  `json({from:'csv'})`.
- **`yaml`** — JSON → YAML. **`xml`** — JSON → XML (`@attr`/`#text` conventions).
- **`markdown`** — HTML → Markdown. **`html`** — Markdown → HTML (inverses).
- **`subtitles`** — SRT ⇄ WebVTT (`direction`).
- **`pack`** — re-encode a JSON array of objects into compact `tsv`/`csv`/`kv`
  so keys aren't repeated per row — token-cheap. Set `note:false` for bare data
  when piping downstream.

Compose round-trips: e.g. `json({from:'csv'})` → edit → `csv`. All converters are
pure and heavily cached (identical input → identical output).

## PDF & images

- **`pdf`** — best-effort "anything → PDF". `sources:[{data|url, kind}]` merged in
  order (kind auto-detected: pdf/png/jpg/text/html/markdown). Options: `pages`
  range, `toc` (bookmarks), `fields` (AcroForm), `flatten`, `ocr:true` (transcribe
  image sources via Workers AI), `compress:true`, metadata (`title`/`author`/…).
  Returns `{ mime, size, base64 }` or `as:"url"` for a `/s/<uuid>` ref.
- **`image_convert`** — format convert (`to`: png|jpeg|webp|avif), `resize`
  (width/height/fit), rotate, quality, blur/sharpen/brightness/contrast/gamma.
  Give `image` (base64) or `url`. Returns bytes or `as:"url"`.

## Compress / archive / encode / hash

- **`compress`** — gzip/deflate/brotli (de)compression of data.
- **`archive`** — pack/unpack tar/zip-style bundles.
- **`encode`** — base64/hex/url/etc. encoding transforms.
- **`hash`** — content digests (sha256, etc.).

## Storage

- **`store`** — content-addressed R2 (sha256 dedupe, Nix-store style). `op`:
  `put` (default; `data` utf-8 or `base64` binary + `content_type`) → returns
  `{ uuid, url, key, sha256, size }` with a resolvable `/s/<uuid>` URL |
  `get` (`id`=uuid or url, or `key`) | `list` (`prefix`) | `delete` (`id`).
  Use it to hand off large blobs (PDFs, images, datasets) by short URL instead of
  inlining them.
- **`kv_put`** / **`kv_get`** / **`kv_list`** / **`kv_delete`** — simple string
  KV store, namespaced under `kv:` (internal cache/oauth keys are refused).
  `kv_put` takes `key`, `value`, optional `ttl` (≥60s). Good for small durable
  state, flags, and cursors across calls.

## Workers-AI text

- **`summarize`** — text or a `url`. A `url` (with the Kagi gateway) uses Kagi's
  Universal Summarizer (handles long docs + YouTube); otherwise Workers AI.
  `style`: `bullets` (default) | `paragraph` | `tldr`; `max_words`.
- **`translate`** — `text` → `to` language code (`from` optional; m2m100).
- **`classify`** — zero-shot into your `labels[]` (`multi:true` for multi-label).
- **`ocr`** — image → text (`url` or `image` base64; `prompt` to customize).
- **`redact`** — scrub PII (`types`: email/phone/ssn/credit_card/ip; default all;
  Luhn-checked cards). Returns `{ redacted, counts }`.

## Obsidian (git-backed vault)

- **`obsidian`** — read/write a personal Obsidian vault. `action`: `list`,
  `read` (`path`), `search` (`query`), `append`, plus `tools`/`call` for the
  vault's own MCP tools. Use when the task references the user's notes/vault.

## Compose

- **`pipe`** — chain these server-side: `steps:[{tool,args}]`, `{{prev}}` /
  `{{prev.a.b}}` injects the prior output. E.g. `scrape` → `declutter` →
  `summarize`, or `json({from:'csv'})` → `pack`.
- **`batch`** — map a tool over many inputs with an optional server-side reduce
  (`concat`/`summarize`/`reduce_with`). E.g. map `pdf` over many URLs then merge.

## Routing guide

- "Convert this CSV/YAML/XML to JSON" → `json` (`from:auto`).
- "Make a PDF of these pages / merge these PDFs" → `pdf` (`sources`).
- "Resize / convert this image" → `image_convert`.
- "Save this so I can link to it" → `store put` → share the `/s/<uuid>` URL.
- "Summarize / translate / classify / redact this" → the matching AI tool.
- "Remember this value for later" → `kv_put` / `kv_get`.
