# sux knowledge base — the in-repo cache so we STOP re-fetching

The durable, versioned home for everything we used to look up every session: the external
APIs/connectors sux integrates, how sux uses them, the recurring code patterns, the working
agreement, and the raw API specs. **This repo is the source of truth. Read here first; hit
upstream only on error (see Lazy-use below).** Claude memory is a thin pointer to this.

## Two layers

**1. Distilled references (`*.md`) — what you actually read.** High-signal, code-grounded,
one file per domain. Ground truth for auth + the exact endpoints sux calls comes from the fn
source; canonical/OpenAPI/Postman links + 2026 limits are web-confirmed.

| File | Covers |
|---|---|
| [working-agreement.md](working-agreement.md) | How Colin drives me: commands, autonomy/spend/deploy policy, taste, the operational lessons |
| [patterns-and-conventions.md](patterns-and-conventions.md) | How sux is built: fn anatomy, front-verb routing, proxy ladder, `<<<DATA>>>` fence, caching, gzip, feature-gating, goals |
| [search-and-research.md](search-and-research.md) | Kagi (API+session), Brave, Exa, Tavily, DDG, Google + arXiv/PubMed/S2/Crossref/OpenAlex/StackExchange/Reddit/ClinicalTrials |
| [cloudflare-and-infra.md](cloudflare-and-infra.md) | Workers/KV/R2/Workers-AI (model ids)/Browser-Rendering/bindings + Tailscale proxy, Mac render, Grafana, Monarch |
| [personal-data.md](personal-data.md) | Fastmail JMAP+CalDAV+contacts, Dropbox (Mode A/B), Obsidian (REST+git) |
| [shopping-places-misc.md](shopping-places-misc.md) | BestBuy/eBay/Kroger, scraped retailers, Google Places, CoinGecko, YouTube, Wayback, socials |
| [auth-github-ci.md](auth-github-ci.md) | MCP OAuth, GitHub API/Actions, claude-code-action gotchas, the CI gate set |
| [llm-models-cost-and-caching.md](llm-models-cost-and-caching.md) | Model ids + pricing, prompt caching, Batch API, free tiers, the model-tier ladder |
| [dev-speed-and-credit-playbook.md](dev-speed-and-credit-playbook.md) | Fast local loop, credit-saving tactics, parallelism patterns, anti-patterns |

**2. Raw specs (`specs/`) — the full machine-readable specs**, serialized for offline/free
access. `specs/MANIFEST.json` tracks every source: `{api, source_url, path, sha256, bytes,
fetched_at, status}`. Big specs are gzipped; specs too large to vendor (Cloudflare/GitHub full
REST) are recorded `url-only` with a pinned reference; APIs with no machine spec are `no-spec`
(the distilled `.md` is the reference). Regenerate/refresh with the bot below.

## Lazy-use (cache-first, upstream-on-error)
1. **Read the cached copy first** — the distilled `.md` (default) or the serialized `specs/`
   entry. Never re-fetch what's already here.
2. **Only hit upstream when the cache fails you** — a doc is missing, a spec entry errors/parses
   wrong, or a live API call fails in a way that smells like drift (new required field, removed
   endpoint, 400 on a documented call).
3. **When you do fetch upstream, write it back** — update the `.md`/spec + `MANIFEST.json` (or,
   if mid-task, leave a note for the refresh bot) so the next session doesn't re-fetch.

## Refresh (periodic, by the sux bot)
The `sux-knowledge-refresh` scheduled task re-pulls each `MANIFEST.json` source, diffs the
sha256, and opens a PR only when a spec actually changed — so upstream API drift surfaces as a
reviewable diff instead of a silent stale cache. Gated + bounded like the other bots (see
[working-agreement.md](working-agreement.md) spend policy). It refreshes; humans review the diff.

## Relationship to memory & CLAUDE.md
- `CLAUDE.md` = how we work on the code (git/CI/sessions/house-style).
- `docs/knowledge/` = the reference cache (this).
- Claude **memory** is reinitialized *from here* — a lean index that points at these files, not a
  parallel store. That's the point: one source of truth, no drift, stop forgetting.
