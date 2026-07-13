# Raw API-spec cache

Machine-readable (OpenAPI/Swagger/Google-Discovery) specs for the external APIs
sux calls, vendored here so we never have to re-fetch/re-discover them from
scratch. This is a **cache of raw spec bytes**, not documentation — the human
reference (endpoints sux actually calls, auth, gotchas) lives in
`docs/knowledge/*.md`; this directory is what a spec-diffing/refresh bot reads.

## MANIFEST.json

One entry per external API named in the `docs/knowledge/*.md` Refs sections.
Each object:

```jsonc
{
  "api": "exa",
  "source_url": "https://raw.githubusercontent.com/exa-labs/openapi-spec/master/exa-openapi-spec.yaml",
  "path": "exa.yaml.gz",       // relative to this dir, or null
  "sha256": "de1e8f95...",     // of the UNCOMPRESSED spec, or null
  "bytes": 66386,              // uncompressed size, or null/url-only size
  "status": "fetched",         // fetched | url-only | no-spec
  "note": "..."
}
```

- **`fetched`** — spec was < 2 MB, downloaded, verified to parse (`jq` for
  JSON, `python3 -c 'import yaml'` for YAML), and vendored gzip-compressed
  as `specs/<api>.<json|yaml>.gz`. `sha256`/`bytes` describe the
  **uncompressed** content so a refresh can diff against a re-fetch.
- **`url-only`** — a real machine spec exists but is ≥ 2 MB (GitHub REST,
  Cloudflare API schemas) or isn't fetchable headlessly (eBay's portal
  403s curl/bot UAs). Not vendored; `source_url` + `bytes` (from a HEAD/
  Content-Length check) are recorded so a refresh knows exactly what to
  pull and roughly how large it'll be.
- **`no-spec`** — no OpenAPI/Swagger/Postman-style machine spec exists at
  all: RFC-only protocols (JMAP, CalDAV, JSContact), scrape-only/unofficial
  backends (Flipp, LinkedIn, Monarch, Google SERP, DuckDuckGo HTML), or
  vendors that only publish prose docs (Kagi, Tavily, arXiv, PubMed/NCBI,
  Crossref, OpenAlex, StackExchange, Reddit, Brave dashboard, Tailscale,
  BestBuy, Kroger, Dropbox's Stone IDL, Anthropic). `note` records what was
  tried (guessed endpoints, GitHub repo searches) so a future refresh
  doesn't repeat the same dead ends — worth re-checking periodically since
  vendors do sometimes publish a spec later.

## Fetched specs

| file | api | format |
|---|---|---|
| `obsidian-local-rest.yaml.gz` | Obsidian Local REST API | OpenAPI 3 |
| `exa.yaml.gz` | Exa | OpenAPI 3 |
| `coingecko.json.gz` | CoinGecko (public/demo tier) | OpenAPI 3 |
| `clinicaltrials.yaml.gz` | ClinicalTrials.gov v2 | OpenAPI 3 |
| `google-places.json.gz` | Google Places API (New) v1 | Google Discovery Doc |
| `youtube.json.gz` | YouTube Data API v3 | Google Discovery Doc |
| `semantic-scholar.json.gz` | Semantic Scholar Graph API | Swagger 2.0 |

Decompress with `gunzip -k <file>` (or `zcat <file>`) before feeding to a
codegen/diff tool.

## Refresh

The `sux-knowledge-refresh` bot re-pulls every `fetched` entry from
`source_url`, re-validates (parses), recomputes `sha256`, and only rewrites
the vendored `.gz` + manifest row if the hash changed. `url-only` entries get
a fresh HEAD/size check each run; `no-spec` entries get periodically
re-probed in case a vendor has since published a spec (their `note` records
what to re-check).

`fetched_at` in this cache's provenance is a fixed marker date
(`2026-07-13`), not a live timestamp — the bot is the source of truth for
"how stale is this," not the file itself.
