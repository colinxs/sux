# `get` — universal "get me a file" fn

Status: design (approved via brainstorming) — unblocked, ready for `writing-plans`
Date: 2026-07-15
Branch: `feat/get-file-fn`

## Purpose

One verb — `get` — that acquires a file for the caller and hands it back
normalized. It is polymorphic on its input ("get chooses"):

- **`get(query)`** — exhaustively search for a document matching a query, dedupe
  candidates *by edition*, download the best one, normalize it, return it.
- **`get(url)`** — turn a page at a URL into a durable artifact (PDF render or
  web-archive), normalized the same way.

`get` is a **router over existing primitives**, not a reimplementation. It
delegates to `search`/`kagi`, `render`, `scrape`/`wayback`, `pdf`, `convert`,
and `ingest`. Keeping it thin is a hard design constraint (279 fns already
exist — no duplicated plumbing).

## Non-goals (v1)

- **No OCR.** OCR is deferred to a future issue that adds a durable Cloudflare
  Queue (none exists today). `get` does not OCR in v1.
- **No torrent/magnet acquisition.** Future issue.
- No new destination infra — storing delegates to `ingest`'s existing blob
  routing (vault ≤1MB → repo, larger/`dropbox` → Dropbox app folder, R2 fallback).

## Input detection

`get` inspects its primary argument:

1. Absolute `http(s)://…` → **URL mode**.
2. Anything else → **query mode**. Query mode also accepts a typed multi-search
   DSL: `file(pdf, deep learning) file(text, changelog)` — each `file(<kind>,
   <subquery>)` becomes one typed search strategy. A bare string = default
   fan-out over all file-relevant strategies.

The `file(kind, …)` DSL applies to **query mode only**. A URL is passed to `get`
bare (no `file(url)` wrapper — that was rejected as awkward).

## Lens catalog & `kind` → lens map

One-time Kagi account setup (done 2026-07-15) created 5 custom lenses to give
`get` targeted file-acquisition strategies, alongside the relevant built-ins.
Full ID↔name mapping, all read directly from `kagi.com/settings/lenses`
edit-link hrefs (`/settings/update_lens?id=<N>`):

| Lens | `lens_id` | Kind | Scope |
|------|-----------|------|-------|
| PDFs | `3` | built-in | PDF files anywhere |
| Usenet/Archive | `5648` | built-in | Usenet + archive.org non-web collections |
| Academic | `2` | built-in | .edu domains (papers) |
| Document Hosts | `31362` | custom | scribd, academia.edu, researchgate, docs.google, drive.google, slideshare, issuu, vdoc.pub, docslib, coursehero |
| Code Search | `31363` | custom | github, gitlab, sr.ht, bitbucket, npmjs, pypi, crates.io, pkg.go.dev, rubygems, sourcegraph |
| Tech Docs | `31364` | custom | devdocs.io, MDN, docs.python, learn.microsoft, developer.apple, docs.aws, cloud.google, docs.rs, readthedocs, docs.oracle |
| Artifacts | `31365` | custom | f-droid, apkmirror, sourceforge, hub.docker, quay.io, nuget, repo1.maven, pkgs.org, launchpad, github |
| Wikis/Notes | `31366` | custom | en.wikipedia, wikisource, wikibooks, wiki.archlinux, fandom, notion.site, publish.obsidian.md, gitbook.io, gist.github, wikimedia |

`get`'s `kind` arg selects which lens(es) the fan-out uses — each selected lens
is one metered call, so a `kind` maps to **≤2 lenses** to keep spend bounded:

| `kind` | Lens(es) | Also runs (free operators) |
|--------|----------|----------------------------|
| `pdf` | PDFs (3) | `filetype:pdf` |
| `document` | Document Hosts (31362) + PDFs (3) | `filetype:pdf`, `filetype:docx` |
| `ebook` | Usenet/Archive (5648) + Document Hosts (31362) | `filetype:epub`, `site:archive.org` |
| `code` | Code Search (31363) | — |
| `docs` | Tech Docs (31364) | — |
| `artifact` | Artifacts (31365) | — |
| `reference` | Wikis/Notes (31366) | — |
| `any` (default) | PDFs (3) + Usenet/Archive (5648) | `filetype:pdf`, `site:archive.org` |

> These are account-scoped IDs, not global Kagi constants (the 8 built-ins
> happen to share default IDs across accounts, but the custom 31362–31366 are
> unique to this account). If the account's lenses are rebuilt, re-read the
> mapping the same way. The IDs live in one `const LENSES` table in the `get`
> implementation — never scattered — so a re-verify touches one place.

## Query mode — the exhaustive search

Fan out concurrent search strategies, then merge. Strategies split across two
Kagi auth paths (see below):

- **Operator strategies (free, `KAGI_SESSION`)**:
  - `filetype:pdf` / `filetype:epub` / … — inline query operator (documented:
    [Kagi search operators](https://help.kagi.com/kagi/features/search-operators.html)),
    derived from `kind` or each `file(kind, …)` clause. Works identically as
    plain query text on the session-scrape path.
  - `site:archive.org` — inline `site:` operator, belt-and-braces domain scope.
- **Lens strategies (metered, `KAGI_API_KEY`)** — `lens_id: "3"` (PDFs) and
  `lens_id: "5648"` (Usenet/Archive), read from the account's own
  `kagi.com/settings/lenses` on 2026-07-15 (edit-link hrefs,
  `/settings/update_lens?id=<N>`) and cross-validated: the same page lists
  Academic, Forums, Programming, News 360, Small Web, and Recipes at
  positions/IDs 2, 1, 15, 29, 107, 120 respectively, exactly matching the
  values already hardcoded in `search.ts` — so the two new IDs sit on
  confirmed-accurate ground truth, not a guess. No operator equivalent exists
  for Usenet content specifically — Usenet posts aren't single-domain web
  content, so `site:` can't replicate it. This is the one piece of coverage
  that requires the metered path.

  > ⚠️ **These are account-scoped lens IDs, not global Kagi constants.**
  > `search.ts`'s existing 6 IDs and these 2 new ones happen to line up
  > because they're all Kagi's own built-in lenses (present on every
  > account with default IDs), but this is empirical, not a documented
  > guarantee — if Kagi ever changes built-in lens ID assignment, these
  > would need re-verifying the same way. (Earlier in this design process a
  > *slug*-based guess — `lens_id: "pdfs"` — was live-tested and looked
  > plausible, but turned out to be a false positive: Kagi silently ignores
  > an invalid `lens_id` rather than erroring, so the "confirmation" was just
  > the query's organic PDF-heavy phrasing. The numeric IDs above come from
  > directly reading the account's lens settings page, not from testing
  > search-result plausibility — a stronger form of evidence.)

Cost note: exactly 2 metered calls per `get` (the two lenses), regardless of
how wide the operator fan-out is — bounded, not scaling with `strategies`/`limit`.
Fan-out is concurrent (`Promise.all`). Stopping rule is **deterministic**: run
the requested strategies, merge, stop. No adaptive "keep searching until found"
loop (unbounded cost).

### Hard constraint: `lens_id` is mutually exclusive with scope args

Per the same `kagimcp` source, the Kagi Search API **rejects** a call that sets
`lens_id` together with any of `include_domains`/`exclude_domains`/
`time_relative`/`file_type` — these are two disjoint strategy shapes, never
combined in one call. `get`'s per-strategy fan-out already satisfies this by
construction (lens strategies carry only `lens_id`; operator strategies carry
only `file_type`/domains), but implementation must not "helpfully" merge a
lens strategy with a file_type filter in the same call.

### Auth: hybrid `KAGI_SESSION` + bounded `KAGI_API_KEY`

Kagi's real API is bearer-token-only (no OAuth) and **pay-per-use, billed
separately from a subscription** — confirmed via
[Kagi's API docs](https://help.kagi.com/kagi/api/overview.html): "Regular Kagi
search subscriptions do not provide API access." Routing `get`'s entire
fan-out through the metered API (`kagi.ts`, as `search.ts` does) would scale
spend with fan-out width — undesirable for an "exhaustive" search fn.

`kagiSession` (`web_search.ts`) today only sends bare `q=` — no `lens_id`,
`file_type`, or `include_domains` support. Rather than guess at an unverified
`lens=` URL param (unconfirmed by Kagi's docs, and untestable via WebFetch
since it carries no session cookie), `get`'s implementation:

1. **Extends `kagiSession`** to fold `file_type`/`include_domains` into the
   query text as documented operators (`filetype:`, `site:`/`-site:`) — this
   is a small upstream improvement to `web_search.ts` that benefits it too,
   verified live before merge.
2. **Uses `kagiTool`/`KAGI_API_KEY`** (as `search.ts` does) only for the two
   lens strategies, bounding metered spend to a small constant.

If `KAGI_SESSION` isn't configured, the operator strategies are skipped
(not silently upgraded to metered); if `KAGI_API_KEY` isn't configured, the
two lens strategies are skipped. `get` runs on whichever secrets are present
and reports which strategies it actually ran.

### Dedupe by edition

Merge all hits, then collapse mirror-duplicates while keeping distinct editions
apart:

- Dedup key = normalized `{title + host + filetype + size-if-known}`.
- Same file mirrored on multiple hosts → **one** candidate.
- Different edition (year / format / filetype differs) → **separate** candidate.

Return a ranked list of **unique** candidates (the "in case there are editions"
requirement).

## URL mode

`get(url)` produces one normalized artifact:

- `as:"pdf"` (default) → delegate to `render(url, as:"pdf")` (headless Chromium →
  PDF), then normalize.
- `as:"archive"` → a web-archive of the page: `wayback` snapshot, or a
  self-contained HTML capture via `scrape`, delivered as a `.html` artifact.

## Normalize

Applied to the acquired bytes:

- **Always**: if the file is a PDF, run `pdf` compress (object streams + strip
  metadata).
- **On request** (`convert:"pdf"`): if `kind=document` (docx/txt/epub/html/…),
  convert to PDF first (via `convert`/`pdf`), then compress. Non-convertible
  kinds returned as-is.

## Destinations (optional)

`store: "vault" | "dropbox" | "r2"` — delegate to `ingest`, reusing its blob
routing. `summarize:true` (vault store only) delegates to the existing
`summarize` fn to add an LLM summary to the vault note — `summarize` already
does the cost-conscious dispatch (readability + Workers AI first, Kagi's
Universal Summarizer as fallback/YouTube path), so `get` adds no new Kagi
surface here. [Kagi's Summarizer](https://help.kagi.com/kagi/api/summarizer.html)
does accept a PDF URL directly, but that path is `summarize`'s concern, not
`get`'s. Default: no store (just return the file).

## Interface (draft)

```
get(input, kind?, convert?, as?, download?, store?, summarize?, limit?, strategies?, include_domains?, deliver?)

  input            string — a URL (→ URL mode) or a query / file(k,q) DSL (→ query mode)
  kind             pdf | document | ebook | code | docs | artifact | reference | any   (default any; query mode — see Lens catalog)
  convert          "pdf" | none                            (default none)
  as               "pdf" | "archive"                       (URL mode; default pdf)
  download         bool — false = return ranked links only, skip fetch/normalize (query mode; default true)
  store            "vault" | "dropbox" | "r2" | none       (default none)
  summarize        bool — vault store only                 (default false)
  limit            int — cap merged candidates             (default 10)
  strategies       string[] — override the fan-out set
  include_domains  string[] — extra domains to scope
  deliver          "inline" | "url"                        (deliverBytes; default per size)
```

## Return shape

```jsonc
{
  "file":     { /* deliverBytes: inline base64 or /s/<uuid> URL */ },
  "editions": [ { "title": "...", "url": "...", "host": "...", "filetype": "pdf", "rank": 1 } ],
  "picked":   0,               // index into editions that was downloaded
  "stored":   { "where": "vault", "ref": "..." }   // present only when store != none
}
```

`download:false` (query mode) returns `editions` + `picked:null` + no `file`.

## Delegation map

| Step                  | Delegates to                                          |
|-----------------------|--------------------------------------------------------|
| operator search       | extended `kagiSession` (`KAGI_SESSION`, free)          |
| lens search           | `kagiTool` (`KAGI_API_KEY`, metered, bounded to 2 calls)|
| url → pdf             | `render(as:"pdf")`                                     |
| url → archive         | `wayback` / `scrape`                                    |
| download bytes        | `_util.loadBytes`                                       |
| pdf compress          | `pdf` compress                                          |
| convert→pdf           | `convert` / `pdf`                                       |
| store                 | `ingest` (vault/dropbox/r2 routing)                     |
| summarize             | `summarize` fn (readability+Workers-AI, Kagi fallback)  |
| deliver               | `_util.deliverBytes`                                    |

## Testing

- Unit: input detection (url vs query vs DSL), `file(k,q)` DSL parsing, edition
  dedupe key behavior (mirror collapse vs edition split), return-shape assembly.
- Mock Kagi/render/ingest at the seam; no live network in `vitest`.
- Follow the existing `*.test.ts` co-located pattern.
- After adding the fn: `npm run gen:index` + commit `src/fns/index.ts`;
  `npm run type-check && npm test`.

## Follow-up issues (file on merge)

1. **Extend `get` to torrent/magnet acquisition** (find + fetch via torrent).
2. **Durable deferred OCR** — add a Cloudflare Queue + consumer so `get` can
   enqueue OCR and route the result to dropbox/r2.
