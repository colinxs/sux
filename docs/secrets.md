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

## Which secret goes where

**GitHub Actions** (CI/CD): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (deploy), `SUX_MCP_URL`, `SUX_MCP_TOKEN` (skill-sync `--live` probe), `ANTHROPIC_API_KEY` (Claude bot).

**Cloudflare Worker** (runtime — everything the fns use): `KAGI_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `FASTMAIL_TOKEN`, `FASTMAIL_CALDAV_USER`, `FASTMAIL_APP_PASSWORD`, `DROPBOX_*`, `GITHUB_TOKEN` (self-improve PRs), `GITHUB_CLIENT_ID/SECRET` (OAuth), `TODOIST_TOKEN`, `KROGER_*`, `NCBI_API_KEY`, `STACKEXCHANGE_KEY`, `GOOGLE_MAPS_KEY`, `CONTROLD_API_TOKEN`, `TAILSCALE_*`, `MAC_RENDER_*`, `GRAFANA_LOKI_*`, `OBSIDIAN_*`, `HEALTH_INGEST_TOKEN`, `COOKIE_ENCRYPTION_KEY`, `ALLOWED_GITHUB_LOGIN`, and the **arming flags** below.

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
