---
title: Secrets — stores, source of truth, and sync
status: reference
---

# Secrets

## The model (read this first)

There are **three separate stores**, and they don't see each other:

| Store | Holds | Who reads it | Read the value back? |
|---|---|---|---|
| **Cloudflare Worker secrets** (`wrangler secret put`) | runtime keys the Worker uses (Kagi, Fastmail, Dropbox, GitHub PAT, …) + the bot arming flags | the deployed `sux` Worker at runtime (`env.X`) | **No — write-only** |
| **GitHub Actions secrets** (`gh secret set`) | CI/CD only (deploy creds, the MCP probe, the Claude-bot key) | GitHub Actions workflows | **No — write-only** |
| **1Password** (`op`) | **the source of truth** for every value | you (+ this repo's sync script) | **Yes** |

**Key consequences**
- A token "put into GitHub" is **invisible to the Worker**. Runtime keys must go to the **Worker** store, not GitHub.
- You **cannot** extract existing values out of Worker/GitHub to backfill op — both are write-only. op is populated **going forward** (or by re-sourcing a value from its origin / rotating it).
- Therefore: **op-first.** Put the value in op, then `scripts/secret-sync.sh` pushes it to the store(s) that need it.

## Can I pull existing values out to seed op? (the recurring question)

- **Cloudflare Worker secrets — no.** There is no `wrangler secret get`. The Worker's own code *can* read `env.X` at runtime, but exposing that over an endpoint is a security hole — don't. Re-source (Fastmail/Dropbox/… console) or **rotate** instead.
- **GitHub Actions secrets — technically yes, not worth it.** A workflow *can* read a secret's value at runtime (it's injected as env) and could pipe it into op — but GitHub masks secrets in logs, you'd need an op service-account token stored *as a GitHub secret* (chicken-and-egg), and it's only ~5 CI values you already have. Just re-enter those into op by hand.

Bottom line: **there is no safe bulk-extract.** op is seeded from the values you hold (or by rotation), once, then it's the hub forever.

## Three tiers — secrets vs settings vs switches (the model we're standardizing on)

The mess came from cramming three different things into "wrangler secret." They're distinct:

| Tier | Examples | Where it lives | Why |
|---|---|---|---|
| **1. Credentials** (must stay hidden) | API keys, tokens, passwords | **op → Worker/GitHub** via `secret-sync.sh` | never in git; op is source of truth |
| **2. Settings** (non-sensitive tuning) | caps (≤5 PR, ≤10 commits), model choices, mail categories, timeouts, `DEBUG_MCP` | **`wrangler.jsonc` `[vars]`** (or a committed `config.ts`) | version-controlled, reviewable, PR-gated, revertable via git |
| **3. Switches** (the "big red buttons") | `MAIL_TRIAGE_ENABLED/ACT`, `SELF_IMPROVE_ENABLE/PR/ARM/KILL` | **Worker secrets** (set deliberately, out of git) | arming an autonomous bot should be a conscious act, not a merged diff; fail-closed by default |

Rule of thumb: **secret it if leaking it is bad; `[vars]` it if you'd want it in a code review; switch it (Worker secret) if flipping it makes a bot act on the world.**

## Which secret goes where

**GitHub Actions** (CI/CD): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (deploy), `SUX_MCP_URL`, `SUX_MCP_TOKEN` (skill-sync `--live` probe — scope note below), `ANTHROPIC_API_KEY` (Claude bot), `SUX_BOT_APP_ID` + `SUX_BOT_PRIVATE_KEY` (GitHub App creds `automerge.yml` mints an app-token from, for native auto-merge — rotation note below).

**`SUX_BOT_APP_ID` / `SUX_BOT_PRIVATE_KEY` rotation** — a linked pair. `automerge.yml` feeds them into `actions/create-github-app-token` to mint a short-lived token for merging green PRs. The private key is generated/downloaded **once** from the settings page of the GitHub App identified by `SUX_BOT_APP_ID`, and — like every GitHub/Worker secret — cannot be read back out of the Actions store. So keep a durable copy in op (`op://Secrets/SUX_BOT_PRIVATE_KEY/credential`); if it's ever lost or suspect, rotate = generate a fresh key on that App's settings page, re-seed op, then `scripts/secret-sync.sh SUX_BOT_PRIVATE_KEY --github`. The App id itself does not change on key rotation.

**`SUX_MCP_TOKEN` scope** — this is a **full personal-MCP session bearer**, not a scoped introspection key. sux's runtime gate authorizes every routed connector path (`/mcp` — the one advertised front door — plus the dormant back-compat routes `/vault/mcp`, `/mail/mcp`, `/files/mcp` it absorbed) on `ALLOWED_GITHUB_LOGIN` alone — there is no per-scope narrowing — so this one token grants the entire ~95-fn surface, including the vault/mail/files mutations reached through the `vault_`/`mail_`/`files_` front-door verbs. `scripts/check-skill-sync.mjs --live` uses it only for a read-only `tools/list` probe, so it is over-privileged for its intended use, and no OAuth introspection-only tier exists. Treat it as tier-1 (rotate on any suspicion, never logged). Note: no committed workflow currently injects it (the `--live` probe is manual only), so it is effectively dormant in CI — if the drift-check is retired, delete it from the Actions store and drop it from `GITHUB_REQUIRED` in `scripts/secret-check.sh` rather than leaving a full-surface bearer parked there.

**Cloudflare Worker** (runtime — everything the fns use): `KAGI_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `FASTMAIL_TOKEN`, `FASTMAIL_CALDAV_USER`, `FASTMAIL_APP_PASSWORD`, `DROPBOX_*`, `GITHUB_TOKEN` (scope note below), `GITHUB_CLIENT_ID/SECRET` (OAuth), `TODOIST_TOKEN`, `KROGER_*`, `NCBI_API_KEY`, `STACKEXCHANGE_KEY`, `GOOGLE_MAPS_KEY`, `CONTROLD_API_TOKEN`, `TAILSCALE_*`, `MAC_RENDER_*`, `GRAFANA_LOKI_*`, `OBSIDIAN_*`, `HEALTH_INGEST_TOKEN`, `COOKIE_ENCRYPTION_KEY`, `ALLOWED_GITHUB_LOGIN`, `SUX_CRON_TOKEN` (bearer-gates the manual `POST /admin/tick` ops trigger — unset ⇒ 404, endpoint off), and the **arming flags** below.

**`GITHUB_TOKEN` scope** — one token, three consumers, not one: (1) `obsidian`/`citation` vault writes over the GitHub Contents API (`fns/obsidian.ts`, `fns/citation.ts`) — needs write access to the vault repo, the highest-privilege use; (2) self-improve PR creation, gated by `SELF_IMPROVE_PR==='on'` (`fns/_self_improve.ts`) — same write scope; (3) `smartFetch`'s GitHub-host rate lift (`src/github-auth.ts`) — attached only to `github.com`/`api.github.com`/`*.githubusercontent.com` requests, anonymous 60/hr → authenticated 5000/hr, read-only need. Least-privilege intent: issue a **fine-grained PAT** scoped to just the vault repo(s) with contents read/write, not a classic all-repo token — the rate-lift path simply rides along on whatever scope the write path already requires. Rotate on suspicion: if a log, PR diff, or leak ever makes you unsure it's still clean, revoke + reissue, no ceremony beyond re-seeding op and `scripts/secret-sync.sh GITHUB_TOKEN --worker`.

**Bot arming flags** (Worker secrets, non-sensitive, fail-closed — unset ⇒ dormant):
- `MAIL_TRIAGE_ENABLED` → classify + suggest + digest; `MAIL_TRIAGE_ACT` → also do reversible moves (never delete/send).
- `SELF_IMPROVE_ENABLE` → loop runs; `SELF_IMPROVE_PR` → may open PRs (needs `GITHUB_TOKEN`); `SELF_IMPROVE_REPO` → target; `SELF_IMPROVE_ARM` → its own auto-merge (**leave OFF** — the GitHub `automerge.yml` pipeline does merging); `SELF_IMPROVE_KILL` → hard stop.

## Sync a secret (op → store)

```bash
# put the value in op first (you do this once, with the real value):
op item create --vault Secrets --category "API Credential" --title "FASTMAIL_TOKEN" credential="…"

# then push it where it belongs (value never printed):
scripts/secret-sync.sh FASTMAIL_TOKEN --worker
scripts/secret-sync.sh ANTHROPIC_API_KEY --github
scripts/secret-sync.sh SUX_MCP_TOKEN --github --worker      # if a key lives in both
```

Convention: op item title == secret name, value in the `credential` field, in the **Secrets** vault
(override with `--op op://Vault/Item/field`).

## Fixing a "broken" token
1. Get a fresh value from its origin (Fastmail settings, Dropbox console, GitHub PAT, …).
2. Store it in op (title = the secret name).
3. `scripts/secret-sync.sh NAME --worker` (or `--github`, per the table above).
4. Runtime keys take effect on the next request; deploy-time keys on the next deploy.
