# sux — a residential caching web-fetch engine, served over MCP

**sux** is a personal, self-owned web-access layer: a Cloudflare Worker that
caches and serves from the edge but *queries the web from your own residential
IP* through infrastructure you control — reaching sites that block datacenters.
It does the fetching, parsing, converting, and AI-summarizing at the edge
instead of in your context window, and exposes the whole thing to any MCP client
as a set of small, composable tools.

> **Browse this repo as a wiki.** It's also an Obsidian vault — open the repo
> root in Obsidian and start at [`Home.md`](Home.md). The design corpus, the
> function surface, and the concept graph are cross-linked and status-tagged
> (`shipped` / `designed` / `parked`); see [`docs/wiki/`](docs/wiki/). Two notes
> stay in sync with the code via `npm run wiki` — see
> [`docs/wiki/Meta/wiki-protocol.md`](docs/wiki/Meta/wiki-protocol.md).

The Worker and its full documentation live under [`sux/`](sux/):

- **[`sux/README.md`](sux/README.md)** — the single source of truth:
  architecture, the three load-bearing pillars (MCP dispatch / residential
  egress / content-addressed cache), the bot-detection war, ops, and roadmap.
  Deeper dives are under [`sux/docs/`](sux/docs/).
- **[`sux/FUNCTIONS.md`](sux/FUNCTIONS.md)** — the full function inventory,
  generated from `sux/src/fns/*.ts` by `npm run docs`.

## Client-side routing helpers

Two artifacts teach Claude to pick the right sux tool for a query:

- **`.claude/skills/sux/SKILL.md`** — a Claude Code skill with the full
  intent→tool routing map (search, fetch/render ladder, research, shopping,
  documents, transforms, `pipe`/`batch` composition). Loaded automatically in
  Claude Code sessions in this repo.
- **The `sux` plugin** — one install that bundles the sux connector (its
  `mcpServers` → `/mcp`) plus **both** skills: the `sux` routing skill and the
  `life` memory skill. Packaged for installation anywhere Claude Code runs (CLI,
  desktop app, IDE extensions). This repo is its marketplace
  (`.claude-plugin/marketplace.json` → `plugins/sux/`):
  ```
  /plugin marketplace add colinxs/sux
  /plugin install sux@sux
  ```
  Installing it registers the `/mcp` connector and loads both skills; OAuth runs
  in-browser on first connect. (You can also connect the server standalone with
  `claude mcp add --transport http sux https://<worker>/mcp`, or a claude.ai
  custom connector.)
- **`docs/claude-profile-snippet.md`** — a compact snippet to paste into
  claude.ai → Settings → Profile, for chats where skills aren't available.

`scripts/check-skill-sync.mjs` keeps everything honest **from the repo alone**
(no live server): `sux/FUNCTIONS.md` matches `npm run docs`, every function is
named in the skill, and the plugin's `skills/` dir mirrors `.claude/skills/`
byte-for-byte. Run it with `npm run check:skill`. After changing the tool
surface, run `npm run docs` and `npm run fix:skill`, then update the skill prose
if you added a function.

## Scripts

```bash
npm install
npm run dev         # wrangler dev --config sux/wrangler.jsonc
npm run type-check  # tsc --noEmit
npm test            # vitest run --config sux/vitest.config.ts
npm run deploy      # wrangler deploy --config sux/wrangler.jsonc
npm run docs        # regenerate sux/FUNCTIONS.md
```

## CI/CD (GitHub Actions)

- **`.github/workflows/ci.yml`** — on every push/PR: `npm ci`, `type-check`,
  `npm test`, the node deploy-blob sync check, docs/index sync checks, and
  `wrangler deploy --dry-run --config sux/wrangler.jsonc` (validates the bundle
  & config without deploying).
- **`.github/workflows/deploy.yml`** — on push to `main` (or manual dispatch):
  type-check + test, then deploy via `cloudflare/wrangler-action` with
  `--config sux/wrangler.jsonc`.
- **`.github/workflows/skill-sync.yml`** — source-derived, no secrets. Its
  **check** job runs on PRs touching the skill / functions / gen-docs / script,
  and weekly: `node scripts/check-skill-sync.mjs --offline` enforces that
  `sux/FUNCTIONS.md` matches `npm run docs`, every function is named in
  `.claude/skills/sux/SKILL.md`, and `plugins/sux/skills/` mirrors
  `.claude/skills/`. Its **fix** job (schedule / manual dispatch) regenerates
  FUNCTIONS.md and re-mirrors the plugin skill (`--write`), opening/refreshing a
  PR on `bot/docs-update` when anything changed.

Deploy needs two **repo secrets** (Settings → Secrets and variables → Actions):

| Secret | How to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → account ID in the URL/sidebar |

The deploy pushes **code + `sux/wrangler.jsonc` vars only**. Worker *secrets* are
managed out-of-band with `wrangler secret put --config sux/wrangler.jsonc` and are
never in the repo or the pipeline.

