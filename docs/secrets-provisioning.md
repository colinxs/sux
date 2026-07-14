---
title: Credential provisioning runbook — obtain, scope, store, rotate each secret
status: reference
cluster: infrastructure
type: reference
summary: "For every secret sux uses: the exact console to generate it, the least-privilege scopes to select, how to store it (op → sync, which tier), what breaks if it is unset, and how to rotate. Values never live in the repo."
tags: [sux, infrastructure, reference, secrets, setup]
related: ["docs/secrets.md", "docs/design/keys.md", "docs/design/token-setup.md"]
---

# Credential provisioning runbook

The operator's how-to companion to [`docs/secrets.md`](secrets.md) (the store/tier
model) and [`docs/design/token-setup.md`](design/token-setup.md) (per-service read
vs read/write). For **every** secret in `sux/src/registry.ts` `RtEnv` and the
`scripts/secret-check.sh` manifest, this gives the exact place to generate it, the
least-privilege scopes to pick (grounded in the consumer code + the credential
audit), how to store it, what breaks if it is unset, and how to rotate it.

**Nothing secret lives in the repo.** This is names, locations, and scopes only.

## The model in one screen (see `docs/secrets.md` for the full version)

Three write-only-ish stores, and **1Password (`op`) is the source of truth**:

| Store | Holds | Set with | Read back? |
|---|---|---|---|
| **Cloudflare Worker secrets** | runtime keys the fns use + bot arming switches | `wrangler secret put` / `scripts/secret-sync.sh NAME --worker` | No |
| **GitHub Actions secrets** | CI/CD only (deploy creds, bot App key, MCP probe) | `gh secret set` / `scripts/secret-sync.sh NAME --github` | No |
| **1Password (`op`)** | the durable copy of **every** credential | `op item create …` | **Yes** |

**Three tiers** (`docs/secrets.md`): **Tier-1 credentials** (op → store via
`secret-sync.sh`), **Tier-2 settings** (`sux/wrangler.jsonc` `[vars]`, committed),
**Tier-3 switches** (Worker secrets set deliberately to arm a bot; fail-closed).

### The standard store + sync recipe

Every Tier-1 credential below uses the same two steps. `op` item **title == secret
name**, value in the **`credential`** field, **Secrets** vault:

```bash
# 1. put the real value in op (once, or on rotation):
op item create --vault Secrets --category "API Credential" --title "NAME" credential="…"

# 2. push it to the store(s) that need it (value never printed):
scripts/secret-sync.sh NAME --worker      # runtime keys
scripts/secret-sync.sh NAME --github      # CI/CD keys
scripts/secret-sync.sh NAME --worker --github   # if a key lives in both
```

Multi-field integrations (Dropbox app, Fastmail CalDAV, Kroger/eBay/Reddit
client id+secret) can live as **one** op item with several labelled fields; either
create one op item per secret name (title == name, matches the `secret-sync.sh`
default `op://Secrets/NAME/credential`), or point at a specific field with
`scripts/secret-sync.sh NAME --worker --op "op://Secrets/<Item>/<field>"`.

> **Never repoint the `scripts/set-secrets.sh` MAP at your bare personal-account op
> items** (`op://Private/Fastmail`, …). Create purpose-made, minimally-scoped app
> credentials in the **Secrets** vault instead, so a Worker compromise leaks a
> scoped integration, not your real account. (Credential-audit finding 10.)

### Rotation, in general

Rotation is the same everywhere: **generate a fresh value at the provider → re-seed
the op item (same title) → `scripts/secret-sync.sh NAME --worker|--github`.** Runtime
keys take effect on the next request; CI keys on the next deploy. Per-secret caveats
(symmetric keys that must change on both sides, write-once keys) are called out below.

---

# 1. Platform & CI/CD (GitHub Actions store)

These live in the **GitHub Actions** store (`--github`), consumed by workflows, not
the Worker runtime.

## `CLOUDFLARE_API_TOKEN`
- **Service / where**: Cloudflare dashboard → **My Profile → API Tokens → Create
  Token → Create Custom Token** (`dash.cloudflare.com/profile/api-tokens`).
- **Scopes (least-privilege)**: **Account → Workers Scripts : Edit** (add **Account →
  Workers KV Storage : Edit** only if you also manage KV from CI). Scope the token to
  the **single account that owns the Worker** (`1e0d4133619d9e9998d9488f3a5f8e1e`),
  not "All accounts". Prefer the Custom token over the broader "Edit Cloudflare
  Workers" template, and never a Global API Key. (Audit finding 4; matches
  `.github/workflows/deploy.yml` header.)
- **Store**: Tier-1. `op item create --vault Secrets --category "API Credential"
  --title "CLOUDFLARE_API_TOKEN" credential="…"` → `scripts/secret-sync.sh
  CLOUDFLARE_API_TOKEN --github`.
- **Unset**: `deploy.yml` (push to `main`) can't authenticate → production deploy
  fails. Nothing runtime.
- **Rotate**: create a new Custom token, delete the old one in the dashboard,
  re-seed op, `--github`.

## `CLOUDFLARE_ACCOUNT_ID`
- **Service / where**: not a secret — the account identifier. Cloudflare dashboard →
  **Workers & Pages** overview, or `wrangler whoami`. Value:
  `1e0d4133619d9e9998d9488f3a5f8e1e`.
- **Scopes**: n/a (an identifier, not a credential). Stored as a GitHub secret only
  to keep it out of the committed config.
- **Store**: Tier-1 slot but non-sensitive. `op item create … --title
  "CLOUDFLARE_ACCOUNT_ID" credential="…"` → `scripts/secret-sync.sh
  CLOUDFLARE_ACCOUNT_ID --github`.
- **Unset**: `deploy.yml` has no target account → deploy fails.
- **Rotate**: only changes if you move the Worker to a different account.

## `ANTHROPIC_API_KEY`
- **Service / where**: Anthropic Console → **Settings → API Keys → Create Key**
  (`console.anthropic.com/settings/keys`). Used by the `@claude` GitHub workflows
  (autofix / mention / security review bots).
- **Scopes**: Anthropic keys are not scope-segmented; issue a **dedicated key for
  this repo's CI** on a workspace with a spend limit so it can be revoked
  independently. (Audit: already at inherent least-privilege.)
- **Store**: Tier-1. `op item create … --title "ANTHROPIC_API_KEY" credential="…"` →
  `scripts/secret-sync.sh ANTHROPIC_API_KEY --github`.
- **Unset**: the Claude CI bots (autofix/mention/security-review) can't call the API
  → those workflows fail; deploy + tests unaffected.
- **Rotate**: create a new key, revoke the old in the console, re-seed op, `--github`.

## `SUX_BOT_APP_ID`
- **Service / where**: GitHub → **Settings → Developer settings → GitHub Apps →**
  the **sux-bot** App → **General**. The numeric App ID (not sensitive). Consumed by
  `.github/workflows/automerge.yml` via `actions/create-github-app-token`.
- **Scopes**: n/a (an identifier). The **App's** permissions are the real scope —
  see the private-key entry.
- **Store**: Tier-1 slot, non-sensitive. `op item create … --title "SUX_BOT_APP_ID"
  credential="…"` → `scripts/secret-sync.sh SUX_BOT_APP_ID --github`.
- **Unset**: `automerge.yml` can't mint the App token → green PRs stop auto-merging
  (manual merge still works).
- **Rotate**: the App ID does not change on key rotation.

## `SUX_BOT_PRIVATE_KEY`
- **Service / where**: the same **sux-bot** GitHub App → **General → Private keys →
  Generate a private key** (downloads a `.pem`, shown **once**).
- **Scopes (least-privilege, App permissions)**: **Pull requests : Read & write**,
  **Contents : Read & write**, **Metadata : Read-only** (implicit). **Remove
  Workflows : write and Issues : write** — `automerge.yml` only merges + labels; it
  never edits CI files or issues (those run on the default `GITHUB_TOKEN`).
  **Keep Contents : write** — native auto-merge completes by pushing the squash
  commit to `main` as the App, and that App-attributed push is what fires
  `deploy.yml`'s `on: push`. (Audit finding 5.)
- **Store**: Tier-1, **write-once** — a GitHub App private key **cannot be
  re-downloaded**, so op is the only durable copy. `op item create … --title
  "SUX_BOT_PRIVATE_KEY" credential="$(cat <downloaded>.pem)"` → verify
  byte-identical (`op read op://Secrets/SUX_BOT_PRIVATE_KEY/credential | diff -
  <.pem>`) → `scripts/secret-sync.sh SUX_BOT_PRIVATE_KEY --github` → then
  `rm -P` the `.pem` (never leave it in `~/Downloads`). (Audit findings 2, 9.)
- **Unset**: `automerge.yml` can't mint the token → auto-merge stops.
- **Rotate (new-before-old)**: generate a fresh key, seed op, `--github`, confirm a
  real automerge run mints a token with the new key, **then** delete the old key in
  the App console. Never delete-then-generate.

## `SUX_MCP_URL` / `SUX_MCP_TOKEN`
- **Service / where**: `SUX_MCP_URL` is the deployed sux MCP base URL.
  `SUX_MCP_TOKEN` is a sux OAuth **session bearer** minted by logging into the
  deployed Worker (the GitHub-OAuth gate). Used only by
  `scripts/check-skill-sync.mjs --live` for a read-only `tools/list` probe.
- **Scopes (caution)**: there is **no scoped/introspection-only tier**. sux's gate
  authorizes **every** namespace (`/mcp`, `/vault`, `/mail`, `/files`) on
  `ALLOWED_GITHUB_LOGIN` alone, so this token grants the **entire ~95-fn surface
  including vault/mail/files mutations** (`sux/src/index.ts` gate). Treat as Tier-1,
  rotate on any suspicion, never log. (Audit finding 6.)
- **Store**: Tier-1. `op item create … --title "SUX_MCP_TOKEN" credential="…"` →
  `scripts/secret-sync.sh SUX_MCP_TOKEN --github` (and `SUX_MCP_URL` likewise).
- **Unset**: the `--live` skill-sync probe can't run. **No committed workflow
  currently injects it** (the probe is manual only) — it is effectively dormant in
  CI. If the drift-check is retired, `gh secret delete` both and drop them from
  `GITHUB_REQUIRED` rather than parking a full-surface bearer.
- **Rotate**: re-login to mint a fresh session token; re-seed op; `--github`.

---

# 2. Login gate (Worker) — the OAuth front door

The `sux/src/github-handler.ts` gate that authenticates every MCP request. All
Worker-store, all required for the Worker to serve anything.

## `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- **Service / where**: GitHub → **Settings → Developer settings → OAuth Apps → New
  OAuth App** (`github.com/settings/developers`). Set the callback URL to the
  deployed Worker's `/callback`. Copy the **Client ID**; **Generate a new client
  secret**.
- **Scopes**: an OAuth App used only for **login identity** — sux reads the
  authenticated login and compares it to `ALLOWED_GITHUB_LOGIN`. Request **no**
  extra OAuth scopes (identity/`read:user` is enough); this is not the repo-write
  path (that's `GITHUB_TOKEN`).
- **Store**: Tier-1. `op item create … --title "GITHUB_CLIENT_ID" credential="…"` /
  `… "GITHUB_CLIENT_SECRET" …` → `scripts/secret-sync.sh GITHUB_CLIENT_ID --worker`
  (and the secret).
- **Unset**: the login gate can't complete OAuth → **no one can authenticate; the
  whole MCP surface is unreachable**.
- **Rotate**: generate a new client secret in the OAuth App, re-seed op, `--worker`
  (rotate the secret; the client id is stable).

## `COOKIE_ENCRYPTION_KEY`
- **Service / where**: self-generated random key (e.g. `openssl rand -hex 32`), not
  from any console. Encrypts the approved-client cookie in the gate.
- **Scopes**: n/a — a symmetric key you mint. Use ≥32 random bytes.
- **Store**: Tier-1. `op item create … --title "COOKIE_ENCRYPTION_KEY"
  credential="$(openssl rand -hex 32)"` → `scripts/secret-sync.sh
  COOKIE_ENCRYPTION_KEY --worker`.
- **Unset**: the gate can't encrypt/verify the approval cookie → login flow breaks.
- **Rotate**: generate a new key, re-seed op, `--worker`. Existing approval cookies
  are invalidated (users re-approve once) — harmless.

## `ALLOWED_GITHUB_LOGIN`
- **Service / where**: not a secret — **Tier-3 switch**. Your GitHub username(s)
  allowed through the gate. This single value is what authorizes the full surface.
- **Scopes**: n/a. Set deliberately as a Worker secret (out of git) because it is the
  access-control list.
- **Store**: set via `wrangler secret put ALLOWED_GITHUB_LOGIN --config
  sux/wrangler.jsonc` (or seed op + `--worker` for a durable copy).
- **Unset**: `selftest`/gate report `allowlist:false`; the gate has no allowed
  identity → effectively no one is authorized.
- **Rotate**: edit the value; no provider involved.

---

# 3. GitHub personal-access token (Worker runtime)

## `GITHUB_TOKEN`
- **Service / where**: GitHub → **Settings → Developer settings → Fine-grained
  personal access tokens → Generate new token** (`github.com/settings/tokens`).
  (Distinct from the Actions-provided `GITHUB_TOKEN` inside workflows — this is a
  Worker-runtime secret.)
- **Scopes (least-privilege)**: a **fine-grained PAT scoped to only the vault
  repo(s)**, permission **Contents : Read and write** — **not** a classic all-repo
  token. Three consumers ride one token: (1) `obsidian`/`citation` vault writes over
  the Contents API — the highest-privilege use; (2) self-improve PR creation, gated
  by `SELF_IMPROVE_PR==='on'`; (3) `smartFetch`'s GitHub-host rate lift
  (`github-auth.ts`, anon 60/hr → auth 5000/hr, read-only) which just rides on
  whatever scope the write path already has. (Matches `docs/secrets.md` scope note.)
- **Store**: Tier-1. `op item create … --title "GITHUB_TOKEN" credential="…"` →
  `scripts/secret-sync.sh GITHUB_TOKEN --worker`.
- **Unset**: `obsidian`/`citation` git-backed vault **writes** fail; self-improve
  can't open PRs even when armed; GitHub fetches fall back to the anonymous 60/hr
  rate limit (`githubAuthHeaders` returns `{}`). Read-only vault paths that don't hit
  GitHub still work.
- **Rotate**: reissue the fine-grained PAT, re-seed op, `--worker`. No ceremony.

---

# 4. Search & web (Worker runtime)

## `KAGI_API_KEY`
- **Service / where**: Kagi → **Settings → Advanced → API** / Kagi API dashboard
  (`kagi.com/settings?p=api`). Powers the default `search`/`web_search` backend.
- **Scopes**: single account API key, no sub-scopes. Billed per query — keep it to
  the sux account.
- **Store**: Tier-1. `op item create … --title "KAGI_API_KEY" credential="…"` →
  `scripts/secret-sync.sh KAGI_API_KEY --worker`.
- **Unset**: the Kagi search backend is unavailable; `search` falls through to other
  configured providers (native Google/Brave/DDG/Tavily/Exa). Required in the
  manifest because it's the primary backend.
- **Rotate**: regenerate in the Kagi dashboard, re-seed op, `--worker`.

## `BRAVE_API_KEY`
- **Service / where**: Brave Search API dashboard → **API Keys**
  (`api-dashboard.search.brave.com`). Subscribe to the (free-tier available) Search
  API first.
- **Scopes**: the **Data for Search** (Web Search) plan key; no finer scopes.
- **Store**: Tier-1. `op item create … --title "BRAVE_API_KEY" credential="…"` →
  `scripts/secret-sync.sh BRAVE_API_KEY --worker`.
- **Unset**: the Brave search provider returns `not_configured`; other providers
  still serve `search`.
- **Rotate**: regenerate in the Brave dashboard, re-seed op, `--worker`.

## `EXA_API_KEY`
- **Service / where**: Exa dashboard → **API Keys** (`dashboard.exa.ai/api-keys`).
  Powers `find_similar` (neural similarity) and an `search` backend.
- **Scopes**: single account key, billed per request.
- **Store**: Tier-1. `op item create … --title "EXA_API_KEY" credential="…"` →
  `scripts/secret-sync.sh EXA_API_KEY --worker`.
- **Unset**: `find_similar` and the Exa search path return `not_configured`.
- **Rotate**: regenerate in the Exa dashboard, re-seed op, `--worker`.

## `TAVILY_API_KEY`
- **Service / where**: Tavily dashboard → **API Keys** (`app.tavily.com`). Powers the
  `tavily` fn / an `search` backend.
- **Scopes**: single account key; Tavily meters by credits, no sub-scopes.
- **Store**: Tier-1. `op item create … --title "TAVILY_API_KEY" credential="…"` →
  `scripts/secret-sync.sh TAVILY_API_KEY --worker`.
- **Unset**: `tavily` and the Tavily search path return `not_configured`.
- **Rotate**: regenerate in the Tavily dashboard, re-seed op, `--worker`.

## `GOOGLE_MAPS_KEY`
- **Service / where**: Google Cloud Console → **APIs & Services → Credentials →
  Create credentials → API key** (`console.cloud.google.com`), on a project with the
  **Places API** (and Geocoding as needed) enabled. Powers `places`.
- **Scopes (least-privilege)**: **restrict the key** to only the Maps/Places APIs it
  uses (API restrictions), and add an application restriction if practical. Set a
  billing quota cap.
- **Store**: Tier-1. `op item create … --title "GOOGLE_MAPS_KEY" credential="…"` →
  `scripts/secret-sync.sh GOOGLE_MAPS_KEY --worker`.
- **Unset**: `places` returns `not_configured`.
- **Rotate**: regenerate the API key in Cloud Console, re-seed op, `--worker`.

## `YOUTUBE_API_KEY`
- **Service / where**: Google Cloud Console → same project → enable **YouTube Data
  API v3** → **Credentials → API key**. Powers `youtube`/`watch` metadata.
- **Scopes (least-privilege)**: restrict the key to the **YouTube Data API v3** only.
- **Store**: Tier-1. `op item create … --title "YOUTUBE_API_KEY" credential="…"` →
  `scripts/secret-sync.sh YOUTUBE_API_KEY --worker`.
- **Unset**: YouTube metadata lookups degrade/return `not_configured`; scrape-based
  paths may still work.
- **Rotate**: regenerate the API key, re-seed op, `--worker`.

## `BING_API_KEY` (legacy / optional)
- **Service / where**: historically Azure **Bing Search v7** resource key. Listed in
  the `secret-check.sh` optional set but **no live consumer in `sux/src`** — Microsoft
  retired the Bing Search API. Treat as **deprecated**; do not provision unless a Bing
  backend is re-added.
- **Store**: if ever needed, Tier-1 like the others.
- **Unset**: no effect (unused).

---

# 5. Research databases (Worker runtime, all optional)

## `NCBI_API_KEY`
- **Service / where**: NCBI → sign in → **Account Settings → API Key Management**
  (`ncbi.nlm.nih.gov/account/settings`). Lifts the E-utilities rate limit for
  `pubmed`.
- **Scopes**: a rate-limit key only, no data scopes.
- **Store**: Tier-1. `op item create … --title "NCBI_API_KEY" credential="…"` →
  `scripts/secret-sync.sh NCBI_API_KEY --worker`.
- **Unset**: `pubmed` still works but at the lower anonymous E-utilities rate limit.
- **Rotate**: regenerate in NCBI account settings, re-seed op, `--worker`.

## `S2_API_KEY`
- **Service / where**: Semantic Scholar → request an API key at
  `semanticscholar.org/product/api` (form-issued). Used by `semantic_scholar`.
- **Scopes**: single account/rate-limit key.
- **Store**: Tier-1. `op item create … --title "S2_API_KEY" credential="…"` →
  `scripts/secret-sync.sh S2_API_KEY --worker`.
- **Unset**: `semantic_scholar` runs at the anonymous rate limit.
- **Rotate**: request a new key, re-seed op, `--worker`.

## `STACKEXCHANGE_KEY`
- **Service / where**: Stack Apps → **Register a new app**
  (`stackapps.com/apps/oauth/register`). The issued **key** raises the Stack Exchange
  API quota for `stackexchange`.
- **Scopes**: a quota key (not an OAuth token); no write scope, read-only API use.
- **Store**: Tier-1. `op item create … --title "STACKEXCHANGE_KEY" credential="…"` →
  `scripts/secret-sync.sh STACKEXCHANGE_KEY --worker`.
- **Unset**: `stackexchange` runs at the lower anonymous quota.
- **Rotate**: register a new app / regenerate, re-seed op, `--worker`.

---

# 6. Retail (Worker runtime, all optional)

## `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET`
- **Service / where**: Kroger developer portal → **Applications → Add Application**
  (`developer.kroger.com`). Powers `kroger` product search.
- **Scopes (least-privilege)**: OAuth2 **client-credentials**, scope
  **`product.compact`** only (read-only product data — matches `fns/kroger.ts`). Do
  not request cart/identity scopes.
- **Store**: Tier-1 pair. `op item create … --title "KROGER_CLIENT_ID" …` / `…
  "KROGER_CLIENT_SECRET" …` → `scripts/secret-sync.sh KROGER_CLIENT_ID --worker`
  (and the secret).
- **Unset**: `kroger` returns `not_configured`.
- **Rotate**: regenerate the app secret in the Kroger portal, re-seed op, `--worker`.

## `BESTBUY_API_KEY`
- **Service / where**: Best Buy Developer portal → **Get API Key**
  (`developer.bestbuy.com`). Powers `bestbuy`.
- **Scopes**: single read-only catalog key.
- **Store**: Tier-1. `op item create … --title "BESTBUY_API_KEY" credential="…"` →
  `scripts/secret-sync.sh BESTBUY_API_KEY --worker`.
- **Unset**: `bestbuy` returns `not_configured`.
- **Rotate**: regenerate in the Best Buy portal, re-seed op, `--worker`.

## `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`
- **Service / where**: eBay Developers Program → **My Account → Application Keys →**
  create a **Production** keyset (`developer.ebay.com`). Copy **App ID (Client ID)**
  and **Cert ID (Client Secret)**.
- **Scopes (least-privilege)**: client-credentials Application token, scope
  **`https://api.ebay.com/oauth/api_scope`** (read-only Browse API — matches
  `fns/ebay.ts`). No user/sell scopes.
- **Store**: Tier-1 pair. `op item create … --title "EBAY_CLIENT_ID" …` / `…
  "EBAY_CLIENT_SECRET" …` → `scripts/secret-sync.sh EBAY_CLIENT_ID --worker` (and
  the secret).
- **Unset**: `ebay` returns `not_configured`.
- **Rotate**: regenerate the Cert ID in the eBay keyset, re-seed op, `--worker`.

---

# 7. Social (Worker runtime, all optional)

## `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`
- **Service / where**: `reddit.com/prefs/apps` → **create another app…** → type
  **script**, redirect uri `http://localhost` (unused). Client id is the string under
  the app name; the secret is the `secret` field.
- **Scopes (least-privilege)**: app-only OAuth **`client_credentials`** — **read-only
  API** (matches `fns/reddit.ts`). No user-auth scopes.
- **Store**: Tier-1 pair. `op item create … --title "REDDIT_CLIENT_ID" …` / `…
  "REDDIT_CLIENT_SECRET" …` → `scripts/secret-sync.sh REDDIT_CLIENT_ID --worker`
  (and the secret).
- **Unset**: `reddit` returns `not_configured`.
- **Rotate**: regenerate the secret on the Reddit app page, re-seed op, `--worker`.

## `FACEBOOK_TOKEN`
- **Service / where**: `developers.facebook.com` → **My Apps → Create App** (type
  *Other / None*) → **Tools → Graph API Explorer** → grant **read** scopes
  (`public_profile`, `user_posts`, `user_photos`) → **Generate Access Token**;
  optionally exchange for a **long-lived** (60-day) token in the token debugger.
- **Scopes (least-privilege)**: **read-only** Graph scopes only; sux never uses
  write/publish scopes (those need app review).
- **Store**: Tier-1. `op item create … --title "FACEBOOK_TOKEN" credential="…"` →
  `scripts/secret-sync.sh FACEBOOK_TOKEN --worker`.
- **Unset**: `facebook` returns `not_configured`.
- **Rotate**: regenerate/re-extend the token (expires ~60 days), re-seed op,
  `--worker`. (This one expires — re-mint before expiry.)

---

# 8. Mail & calendar — Fastmail (Worker runtime)

## `FASTMAIL_TOKEN`
- **Service / where**: Fastmail → **Settings → Privacy & Security → Connected apps &
  API tokens → New API token** (`fastmail.com`). Powers the `jmap` fn + `/mail/mcp`.
- **Scopes (least-privilege)**: a **JMAP API token** (NOT an "MCP" token). Choose
  **Mail** (+ **Calendars** / **Contacts** if you want `jmap` to reach them). Pick
  **read-only** for read/compose workflows — that makes `send`/`destroy`/archive
  impossible **at the credential layer** (the `allow_send`/`allow_destroy` args only
  guard accidental misuse, per `fns/jmap.ts`). Pick **read/write** only if you want
  send + masked-email.
- **Store**: Tier-1. `op item create … --title "FASTMAIL_TOKEN" credential="…"` →
  `scripts/secret-sync.sh FASTMAIL_TOKEN --worker`.
- **Unset**: `jmap` and the entire `/mail/mcp` namespace return `not_configured`.
- **Rotate**: create a new API token, remove the old at Fastmail → API tokens,
  re-seed op, `--worker`.

## `FASTMAIL_ACCOUNT_ID` / `FASTMAIL_SESSION_URL` (optional overrides)
- **Service / where**: not generated — escape hatches. sux derives both from the JMAP
  Session automatically; set them only to pin a non-default account/session URL.
- **Store**: Tier-1 slot if used. `op item create … --title "FASTMAIL_ACCOUNT_ID" …`
  → `--worker`.
- **Unset**: normal — auto-derived from the Session. No breakage.

## `FASTMAIL_CALDAV_USER` / `FASTMAIL_APP_PASSWORD`
- **Service / where**: Fastmail → **Settings → Privacy & Security → App passwords →
  New app password** with **Calendars/CalDAV** access. `FASTMAIL_CALDAV_USER` is your
  Fastmail account email/username; `FASTMAIL_APP_PASSWORD` is the generated app
  password. (Fastmail's JMAP has no `jmap:calendars`, so calendar + tasks ride
  CalDAV — `fns/_caldav.ts`.)
- **Scopes (least-privilege)**: an app-specific password scoped to
  **Calendars/CalDAV** only (not full-account, not mail).
- **Store**: Tier-1 pair. `op item create … --title "FASTMAIL_CALDAV_USER" …` / `…
  "FASTMAIL_APP_PASSWORD" …` → `scripts/secret-sync.sh FASTMAIL_CALDAV_USER --worker`
  (and the password).
- **Unset**: `cal_*` / `task_*` / `caldav` fns are unavailable (**both** must be set).
- **Rotate**: create a new app password, revoke the old, re-seed op, `--worker`.

---

# 9. Tasks — Todoist (Worker runtime)

## `TODOIST_TOKEN`
- **Service / where**: Todoist → **Settings → Integrations → Developer** → copy the
  **API token** (`todoist.com/app/settings/integrations/developer`).
- **Scopes**: Todoist's personal token is **full access** (read + write) — there is
  no read-only variant. Used as a Bearer directly (`fns/todoist.ts`).
- **Store**: Tier-1. `op item create … --title "TODOIST_TOKEN" credential="…"` →
  `scripts/secret-sync.sh TODOIST_TOKEN --worker`.
- **Unset**: `todoist` returns `not_configured` (nothing about it runs until set).
- **Rotate**: reset the API token in Todoist developer settings, re-seed op,
  `--worker`.

---

# 10. Files — Dropbox (Worker runtime)

## Mode A — app-folder store (`/files/mcp`, `dropbox` fn)

**`DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` (+ `DROPBOX_APP_SECRET`)**
- **Service / where**: `dropbox.com/developers/apps` → **Create app** → **Scoped
  access** → **App folder** (the safety wall: it can only see `/Apps/<name>/`) →
  name it → **Create**. **Settings** tab → copy **App key** (and **App secret**).
- **Scopes (least-privilege, Permissions tab)**: **read-only** =
  `files.metadata.read`, `files.content.read`, `sharing.read`. **read/write** = add
  `files.content.write`, `sharing.write` (needed for
  `files_write/upload/delete/share`). Submit before minting the token.
- **Mint the refresh token (offline OAuth)**: visit
  `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline`,
  approve, then exchange the `code`: `curl https://api.dropboxapi.com/oauth2/token -d
  code=<CODE> -d grant_type=authorization_code -u <APP_KEY>:<APP_SECRET>` — the
  JSON's `refresh_token` is the durable value. **PKCE public-client option**: set up
  the app so the Worker holds **no secret** (only App key + refresh token), as the
  live `sux-files-mcp-colinxs` app does — then omit `DROPBOX_APP_SECRET`.
- **Store**: Tier-1. One op item (title `DROPBOX_...`) per name, or one item with
  `app_key`/`app_secret`/`refresh_token` fields. `scripts/secret-sync.sh
  DROPBOX_REFRESH_TOKEN --worker` (+ `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`).
- **Unset**: `dropbox` and the `/files/mcp` namespace return "Dropbox not configured"
  (`fns/dropbox.ts`). The Worker mints short-lived access tokens into KV and
  self-heals on 401, so the refresh token + app key are the durable inputs.
- **Rotate**: regenerate the app secret and/or re-mint the refresh token in the App
  Console, re-seed op, `--worker`.

**`DROPBOX_TOKEN` (optional quick-test)**
- **Service / where**: a short-lived (`sl.`, ~4h) access token from the App Console's
  "Generate access token" button. For a one-off test only — expires in hours.
- **Store**: Tier-1 optional. Prefer the refresh flow for anything durable.
- **Unset**: no effect if the refresh flow is configured.

## Mode B — whole-Dropbox (`_dropbox-full.ts`), kept SEPARATE as the safety wall

**`DROPBOX_FULL_REFRESH_TOKEN` (+ `DROPBOX_FULL_APP_KEY`, `DROPBOX_FULL_APP_SECRET`,
`DROPBOX_FULL_TOKEN`)**
- **Service / where**: a **separate** Dropbox App with **Full Dropbox** access
  (`dropbox.com/developers/apps` → Create app → Full Dropbox). Kept distinct from the
  app-folder credential above so Mode A's `/Apps/<app>/` wall stays intact.
- **Scopes (least-privilege)**: `files.content.read/write`, `sharing.read/write` for
  read+gated-write over the whole Dropbox. **PKCE public client** recommended — omit
  `DROPBOX_FULL_APP_SECRET` so the Worker holds no secret.
- **Store**: Tier-1. `op item create … --title "DROPBOX_FULL_REFRESH_TOKEN" …` →
  `scripts/secret-sync.sh DROPBOX_FULL_REFRESH_TOKEN --worker` (+ app key).
- **Unset**: **Mode B is dormant** — whole-Dropbox read/search/write is inert until
  the FULL credential is set. (Mode A is unaffected.)
- **Rotate**: re-mint in the full-scope App, re-seed op, `--worker`.

**`DROPBOX_FULL_PROTECT_PREFIXES` (Tier-2 setting, not a credential)**
- Comma-separated absolute path prefixes Mode B mutations **refuse** to touch (e.g. a
  vault mirror). Empty → no deny-list (the always-on guards — dry-run default,
  confirm-on-delete, rev-conditioning, recoverable trash — still apply). Set as a
  Worker secret/var alongside the Mode B credential; not sensitive.

---

# 11. Obsidian vault (Worker runtime)

## `OBSIDIAN_VAULT_REPO` / `OBSIDIAN_VAULT_BRANCH` / `OBSIDIAN_VAULT_DIR` (Tier-2 vars)
- **Service / where**: not secrets — the git-backed vault location (`owner/repo`,
  branch, optional subfolder). Live in `sux/wrangler.jsonc` `[vars]` (committed). The
  **write credential** is `GITHUB_TOKEN` (§3).
- **Unset**: `OBSIDIAN_VAULT_REPO` unset → the git-backed `/vault/mcp` has no target
  repo; `obsidian`/`citation`/`recall` git paths can't resolve.

## `OBSIDIAN_REMOTE_URL` / `OBSIDIAN_REMOTE_KEY` (legacy live-vault backend)
- **Service / where**: the Funnel'd **Local REST API** URL + its bearer key — see
  `OBSIDIAN_REST_TOKEN` below for where the key comes from. Being replaced by the CF
  Container backend.
- **Scopes**: the Local REST API key is **full read/write** over the vault (no
  read-only mode).
- **Store**: Tier-1 (`OBSIDIAN_REMOTE_KEY` is the secret; the URL is location).
  `op item create … --title "OBSIDIAN_REMOTE_KEY" …` → `scripts/secret-sync.sh
  OBSIDIAN_REMOTE_KEY --worker` (+ `OBSIDIAN_REMOTE_URL`).
- **Unset**: the remote/live-vault backend path is unavailable; git-backed vault
  still works.
- **Rotate**: regenerate the Local REST API key (below), re-seed op, `--worker`.

## `OBSIDIAN_REST_TOKEN` (container image key)
- **Service / where**: the **Obsidian desktop app** (not a website) → **Settings →
  Community plugins → Local REST API → API Key** (install the plugin first). Baked
  into the headless-Obsidian container image at build **and** set as the matching
  Worker secret.
- **Scopes**: **full read/write** over the vault (no read-only mode).
- **Store**: Tier-1. `op item create … --title "OBSIDIAN_REST_TOKEN" …` →
  `scripts/secret-sync.sh OBSIDIAN_REST_TOKEN --worker`. Cannot be generated in a
  browser — created inside the desktop app.
- **Unset**: the live-vault container backend can't authenticate.
- **Rotate**: regenerate the key in the plugin, rebuild the container image, re-seed
  op, `--worker`.

---

# 12. Residential egress & render tiers (Worker runtime)

## `TAILSCALE_PROXY_URL` / `TAILSCALE_PROXY_SECRET` (+ `TAILSCALE_PROXY_ALL`)
- **Service / where**: the OpenWRT/Tailscale **funnel node** you run (e.g. the
  `root@192.168.1.1` provisioner). `TAILSCALE_PROXY_URL` is the Funnel URL;
  `TAILSCALE_PROXY_SECRET` is a **shared 64-hex HMAC key** you generate (e.g.
  `openssl rand -hex 32`) and set **identically** on both the node (`PROXY_SECRET`)
  and the Worker (`proxy.ts` / `github-handler.ts` sign requests with it).
  `TAILSCALE_PROXY_ALL` is a Tier-2 routing toggle, not a secret.
- **Scopes**: n/a — a symmetric HMAC signing key. Its only power is signing
  proxy-funnel requests.
- **Store**: Tier-1. `op item create … --title "TAILSCALE_PROXY_SECRET"
  credential="$(openssl rand -hex 32)"` → `scripts/secret-sync.sh
  TAILSCALE_PROXY_SECRET --worker` (+ `TAILSCALE_PROXY_URL`).
- **Unset**: the residential-fetch funnel (scrape/render escalation ladder) is
  unavailable; direct/other tiers still work.
- **Rotate (BOTH sides, back-to-back — it is symmetric)**: generate a fresh value →
  set on the node (`PROXY_SECRET=<new> …` + restart) **and** `wrangler secret put
  TAILSCALE_PROXY_SECRET` / `secret-sync.sh --worker` with minimal gap. A one-sided
  change makes the proxy reject every request until synced. (Audit findings 1, per
  the credential-audit: the old value was recoverable in git history — rotate it.)

## `MAC_RENDER_URL` / `MAC_RENDER_SECRET`
- **Service / where**: the Mac render backend you run (headless-browser render tier +
  iMessage spoke). `MAC_RENDER_URL` is its reachable URL; `MAC_RENDER_SECRET` is a
  shared bearer you invent and set on both the Mac service and the Worker.
- **Scopes**: n/a — a shared bearer for the render service. Fail-closed: unset → the
  rung no-ops.
- **Store**: Tier-1. `op item create … --title "MAC_RENDER_SECRET" credential="…"` →
  `scripts/secret-sync.sh MAC_RENDER_SECRET --worker` (+ `MAC_RENDER_URL`).
- **Unset**: the `render:mac` escalation rung is skipped; the ladder falls back to
  earlier rungs.
- **Rotate**: pick a new shared secret, set on the Mac service + Worker together,
  re-seed op, `--worker`.

## `UNLOCKER_API_URL` / `UNLOCKER_API_KEY` (optional last rung)
- **Service / where**: a paid residential "web unlocker" (Bright Data / Zyte /
  Oxylabs) — from that vendor's dashboard. Last rung of the retail escalation ladder
  (`homedepot`/`costco`) after cf + mac fail (`unlocker-render.ts`).
- **Scopes**: the vendor zone/API key for the unlocker product only.
- **Store**: Tier-1 optional. `op item create … --title "UNLOCKER_API_KEY" …` →
  `scripts/secret-sync.sh UNLOCKER_API_KEY --worker` (+ `UNLOCKER_API_URL`).
- **Unset**: the unlocker rung no-ops; the ladder stops at the mac tier.
- **Rotate**: regenerate in the vendor dashboard, re-seed op, `--worker`.

## `UW_PWS_CERT` (mTLS binding, not a string secret)
- **Service / where**: a UW Person Web Service client certificate, wired as a
  Cloudflare **`mtls_certificates`** binding in `sux/wrangler.jsonc` (uploaded via
  `wrangler mtls-certificate upload`), presenting the client cert to
  `ws.admin.washington.edu` for the `uw` fn.
- **Scopes**: the mTLS client cert grants the richer student-inclusive PWS tier only.
- **Store**: not an op string secret — a Cloudflare mTLS cert + a wrangler binding.
  Keep the cert/key pair in op as attachments for durability.
- **Unset ("cert set" = the binding exists)**: `uw` serves only the public
  `directory.uw.edu` faculty/staff scrape — fail-closed, never errors.
- **Rotate**: re-issue the client cert, re-upload via wrangler, redeploy.

---

# 13. Infrastructure read fns (Worker runtime, optional)

## `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` / `TAILSCALE_TAILNET`
- **Service / where**: Tailscale admin console → **Settings → OAuth clients →
  Generate OAuth client** (`login.tailscale.com/admin/settings/oauth`). Used by the
  `tailscale` fn to **read the control plane** (distinct from the egress funnel
  secrets above).
- **Scopes (least-privilege)**: OAuth2 **client-credentials** with the **read** scope
  the `tailscale` fn needs (e.g. Devices : Read) — not admin/write. `TAILSCALE_TAILNET`
  is the tailnet id (`-` = the client's default tailnet), not a secret.
- **Store**: Tier-1 pair. `op item create … --title "TAILSCALE_OAUTH_CLIENT_ID" …` /
  `… "TAILSCALE_OAUTH_CLIENT_SECRET" …` → `scripts/secret-sync.sh
  TAILSCALE_OAUTH_CLIENT_ID --worker` (and the secret).
- **Unset**: `tailscale` control-plane reads are unavailable.
- **Rotate**: regenerate the OAuth client in the admin console, re-seed op,
  `--worker`.

## `CONTROLD_API_TOKEN`
- **Service / where**: Control D dashboard → **Preferences → API**
  (`controld.com`). Used by the `controld` fn (Bearer).
- **Scopes**: single account API token.
- **Store**: Tier-1. `op item create … --title "CONTROLD_API_TOKEN" credential="…"`
  → `scripts/secret-sync.sh CONTROLD_API_TOKEN --worker`.
- **Unset**: `controld` returns `not_configured`.
- **Rotate**: regenerate in Control D preferences, re-seed op, `--worker`.

---

# 14. Observability — Grafana Cloud Loki (Worker runtime)

## `GRAFANA_LOKI_URL` / `GRAFANA_LOKI_USER` / `GRAFANA_LOKI_TOKEN`
- **Service / where**: Grafana Cloud → your **Loki** stack → **Details / API keys**.
  `GRAFANA_LOKI_URL` is the Loki push endpoint; `GRAFANA_LOKI_USER` is the numeric
  stack/tenant user; `GRAFANA_LOKI_TOKEN` is an access policy token with **logs:write**.
- **Scopes (least-privilege)**: a Grafana Cloud **Access Policy token limited to
  `logs:write`** for the one Loki stack — not an org-admin key.
- **Store**: Tier-1. `op item create … --title "GRAFANA_LOKI_TOKEN" credential="…"` →
  `scripts/secret-sync.sh GRAFANA_LOKI_TOKEN --worker` (+ URL + USER).
- **Unset**: log shipping is **inert** — sux emits metrics locally only. All three
  must be set to push (`grafana.ts` returns early if any is missing). No functional
  breakage otherwise.
- **Rotate**: create a new access policy token, re-seed op, `--worker`.

---

# 15. Health ingest (Worker runtime)

## `HEALTH_INGEST_TOKEN`
- **Service / where**: a **shared bearer you invent** (e.g. `openssl rand -hex 32`)
  for the health-ingest route — the same value is entered into the **Health Auto
  Export** iOS app's REST automation that POSTs vitals to sux. (The one op item that
  currently exists; the ingest route is per the health-integrations design.)
- **Scopes**: n/a — a self-minted bearer, timing-safe-compared server-side;
  missing/empty ⇒ fail-closed (401).
- **Store**: Tier-1. `op item create … --title "HEALTH_INGEST_TOKEN" credential="…"`
  → `scripts/secret-sync.sh HEALTH_INGEST_TOKEN --worker`. **Convention note**: the
  existing op item is titled `sux HEALTH_INGEST_TOKEN`; rename it to
  `HEALTH_INGEST_TOKEN` (`op item edit "sux HEALTH_INGEST_TOKEN" --vault Secrets
  --title "HEALTH_INGEST_TOKEN"`) so the default `secret-sync.sh` lookup resolves.
  (Audit finding 11.)
- **Unset**: the health-ingest route rejects all posts (fail-closed) / is off.
- **Rotate**: pick a new bearer, update the phone automation + op, `--worker`.

## `APPLE_HEALTH_TOKEN` / `EPIC_FHIR_CLIENT_ID` (planned mychart namespace)
- **Apple Health**: the **Health Auto Export** iOS app (Premium) → **REST API
  automation** → you choose the bearer; set the same value. Read-only by nature.
  Generated on the phone, not a browser.
- **Epic / MyChart**: register a **patient-facing app** at `fhir.epic.com` → get a
  **client id** → SMART-on-FHIR OAuth with **read-only USCDI** scopes. Per-health-
  system client secret as needed.
- **Store**: Tier-1 when built. Both read-only.

---

# 16. Ops trigger (Worker runtime)

## `SUX_CRON_TOKEN`
- **Service / where**: a **self-minted bearer** (e.g. `openssl rand -hex 32`) that
  gates the manual `POST /admin/tick?job=…` cron trigger (`index.ts`).
- **Scopes**: n/a — one fail-closed bearer, constant-time compared. It gates
  mail-triage/self-improve/maintenance ticks, but the **mutating** branches each also
  require a separately-armed switch (`MAIL_TRIAGE_ACT`, `SELF_IMPROVE_PR` +
  `GITHUB_TOKEN`) the token alone can't flip. (Audit finding 7 — accept as-is.)
- **Store**: Tier-3-ish credential. `op item create … --title "SUX_CRON_TOKEN"
  credential="…"` → `scripts/secret-sync.sh SUX_CRON_TOKEN --worker`.
- **Unset**: `POST /admin/tick` **404s** — the manual trigger is off. Scheduled cron
  ticks still run on their own.
- **Rotate**: pick a new value, re-seed op, `--worker`. Rotate on any suspicion,
  never log.

---

# 17. Bot arming switches (Tier-3, Worker secrets — NOT credentials)

Set deliberately with `wrangler secret put <NAME> --config sux/wrangler.jsonc`.
Fail-closed: unset ⇒ dormant. These do not go through op (they're switches, not
secrets to protect), though a durable copy in op is fine.

| Switch | Effect | Default |
|---|---|---|
| `MAIL_TRIAGE_ENABLED` | run classify→suggest→digest loop | off (unset ⇒ no-op) |
| `MAIL_TRIAGE_ACT` | **also** perform reversible mailbox moves (archive/junk; never delete/send) | off (suggest-only) |
| `SELF_IMPROVE_ENABLE` | the self-improve loop runs | off |
| `SELF_IMPROVE_PR` | may open PRs (`'on'` exact + needs `GITHUB_TOKEN`); else review-only | off |
| `SELF_IMPROVE_REPO` | `owner/repo` target (default the sux repo) | sux repo |
| `SELF_IMPROVE_ARM` | its own auto-merge — **leave OFF**; the GitHub `automerge.yml` pipeline does merging | off |
| `SELF_IMPROVE_KILL` | truthy ⇒ hard stop, checked before enable | off |

---

# 18. Tier-2 settings (`sux/wrangler.jsonc` `[vars]`, committed — not secrets)

Non-sensitive tuning, version-controlled and PR-gated. Currently:
`MAIL_TRIAGE_ENABLED` (`"1"`, in vars), `VAULT_TZ` (IANA tz for
the vault owner's "today", default Pacific), and the `OBSIDIAN_VAULT_REPO/BRANCH/DIR`
vault location. Change these in a reviewed diff, not via `wrangler secret`.

---

## Cross-reference: which store, which tier

| Store | Secrets |
|---|---|
| **GitHub Actions** (`--github`) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, `SUX_BOT_APP_ID`, `SUX_BOT_PRIVATE_KEY`, `SUX_MCP_URL`, `SUX_MCP_TOKEN` |
| **Cloudflare Worker** (`--worker`) | everything in §2–§16 (auth gate, `GITHUB_TOKEN`, search, research, retail, social, Fastmail, Todoist, Dropbox, Obsidian, egress/render, infra-read, Grafana, health, cron) |
| **Worker switches** (Tier-3, deliberate) | §17 arming flags, `ALLOWED_GITHUB_LOGIN`, `SUX_CRON_TOKEN` |
| **Committed `[vars]`** (Tier-2) | §18 + `DROPBOX_FULL_PROTECT_PREFIXES`, `TAILSCALE_PROXY_ALL` |

Run `scripts/secret-check.sh` to diff the live store names against the manifest
(names only — no values). Fix a gap the standard way: value into op, then
`scripts/secret-sync.sh NAME --worker|--github`.
