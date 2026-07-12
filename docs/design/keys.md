---
title: Keys & secrets
status: reference
cluster: infrastructure
type: reference
summary: "Canonical registry of every secret/binding sux uses + the ones the new plan needs, where each lives, and how to get it."
tags: [sux, infrastructure, reference, secrets]
updated: 2026-07-09
related: ["[[oauth-gate]]", "[[connector-surface-policy]]", "[[Infrastructure-MOC]]"]
---

# Keys & secrets

The one place that answers "what keys does sux use, which are set, which do I still
owe, and where do they live." Nothing secret is in the repo — this is names +
locations + how-to only. Set a Worker secret with:

```
wrangler secret put <NAME> --config sux/wrangler.jsonc
```

## Where secrets live (storage tiers)

| Tier | What | How set |
|---|---|---|
| **Worker secrets** | every API token/key below | `wrangler secret put` — encrypted, never in repo/logs |
| **`sux/wrangler.jsonc` `vars`** | non-secret config (`DEBUG_MCP`, `VAULT_TZ`, `OBSIDIAN_VAULT_REPO/BRANCH/DIR`) | committed |
| **KV (`OAUTH_KV`)** | minted **short-lived** tokens + OAuth state — self-healed, never set by hand (e.g. `sux:dropbox:token`) | runtime |
| **Container image / env** | the headless-Obsidian container's Local REST key (`OBSIDIAN_REST_TOKEN`) | baked at image build |
| **GitHub OAuth App** | the login gate | GitHub dev settings + secrets below |
| **Local dev** | `.dev.vars` (git-ignored) mirrors the secrets | copy of the above |

Pattern for anything with a **refresh token**: store the long-lived `*_REFRESH_TOKEN`
+ app key/secret as Worker secrets; the Worker mints short-lived access tokens into
KV and self-heals on 401 (see [[vault-stack|`dropbox.ts`]] — the model every new
provider follows).

## Currently wired (already in the code)

| Secret | Used by | Status |
|---|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `ALLOWED_GITHUB_LOGIN` | the [[oauth-gate]] (login) | ✅ set |
| `GITHUB_TOKEN` | **three consumers, one token**: vault git writes (Contents API, `obsidian`/`citation`, the highest-privilege use); self-improve PR creation (gated by `SELF_IMPROVE_PR`); `smartFetch`'s GitHub-host rate lift (`github-auth.ts`, anonymous 60/hr → authenticated 5000/hr, read-only need). Least-privilege intent: a fine-grained PAT scoped to just the vault repo(s), not classic all-repo — see [[secrets\|docs/secrets.md]]. Rotate on suspicion. | ✅ set |
| `KAGI_API_KEY`, `BRAVE_API_KEY`, `BING_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `GOOGLE_MAPS_KEY`, `YOUTUBE_API_KEY` | universal `sux` search/web | ✅ set (as used) |
| `NCBI_API_KEY`, `S2_API_KEY`, `STACKEXCHANGE_KEY` | research fns | ✅ optional |
| `KROGER_CLIENT_ID/SECRET`, `BESTBUY_API_KEY`, `EBAY_CLIENT_ID/SECRET` | retail fns | ✅ optional |
| `REDDIT_CLIENT_ID/SECRET`, `FACEBOOK_TOKEN` | social fns | ✅ optional |
| `OBSIDIAN_VAULT_REPO/BRANCH/DIR` (vars), `VAULT_TZ` | git vault backend | ✅ set |
| `OBSIDIAN_REMOTE_URL`, `OBSIDIAN_REMOTE_KEY` | current Funnel'd live-vault backend (**to be replaced by the CF Container**) | ✅ set (legacy) |
| `DROPBOX_REFRESH_TOKEN`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` (`DROPBOX_TOKEN` test) | Dropbox **app-folder** store | ✅ set |
| `TAILSCALE_PROXY_URL/SECRET`, `TAILSCALE_PROXY_ALL` | residential egress ([[fetch-ladder]]) | ✅ set |
| `MAC_RENDER_URL`, `MAC_RENDER_SECRET` | Mac render tier + **iMessage spoke reach** | ✅ set |
| `TAILSCALE_OAUTH_CLIENT_ID/SECRET`, `TAILSCALE_TAILNET`, `CONTROLD_API_TOKEN` | infra read fns | ✅ optional |
| `GRAFANA_LOKI_URL/USER/TOKEN` | observability (Loki logs) | ✅ set |
| `GRAFANA_PROM_URL`, `GRAFANA_PROM_USER` | observability (Prometheus metrics snapshot; token reuses `GRAFANA_LOKI_TOKEN`, scope +`metrics:write`) | ⬜ optional — dormant until set |

## Needed for the new plan — **please add these**

| Secret | For | Where | Status | How to get it |
|---|---|---|---|---|
| `FASTMAIL_TOKEN` | **mail + calendar + contacts** (JMAP) | Worker secret | ⚠️ **you said set — I'll verify** | Fastmail → **Settings → Privacy & Security → API tokens** → New token; scopes: **Mail + Calendars + Contacts** (JMAP). A single full-access token is simplest. |
| `TODOIST_TOKEN` | **tasks** | Worker secret | ❗ **needed** | Todoist → **Settings → Integrations → Developer** → copy the **API token**. |
| `GMAIL_CLIENT_ID` · `GMAIL_CLIENT_SECRET` · `GMAIL_REFRESH_TOKEN` | **Gmail** (mail, multi-account) | Worker secret | ❗ **needed** | [console.cloud.google.com](https://console.cloud.google.com) → new project → **enable Gmail API** → **OAuth consent screen** (External; add yourself as a Test user) → **Credentials → OAuth client ID → Desktop app** → gives client id+secret. Then one-time consent for a **refresh token**, scope `https://mail.google.com/`. *I'll ship a tiny `scripts/mint-gmail-token.mjs` so you just paste the client id/secret and approve in-browser.* |
| `DROPBOX_FULL_REFRESH_TOKEN` (+ its app key/secret) | **operate on your whole Dropbox** (not just the app folder) | Worker secret | ⬆️ **you uploaded a Dropbox key — I'll confirm it's the full-scope one** | Dropbox **App Console** → app with **Full Dropbox** access → permissions `files.content.read/write`, `sharing.read/write` → OAuth (offline) → refresh token. Kept **separate** from the app-folder token — scope is the safety wall. |
| `OBSIDIAN_REST_TOKEN` | the **headless-Obsidian container's** Local REST API | container image + Worker secret | ❗ I generate it | I bake a fresh key into the container image at build and set the matching Worker secret — nothing for you to do. |
| *(no key)* Cloudflare **Containers** | vault/mail/files spine | — | ⚠️ **confirm Workers plan is paid** | Containers require a **paid Workers plan**. Tailscale you already have. |

## Later (mychart namespace)

| Secret | For | How to get it |
|---|---|---|
| `EPIC_FHIR_CLIENT_ID` (+ per-health-system client secret) | Epic SMART-on-FHIR clinical records | register a patient-facing app at **fhir.epic.com** (USCDI read-only scopes) |
| `APPLE_HEALTH_TOKEN` | Apple Watch vitals → `/apple-health` route | **Health Auto Export** app (Premium) → REST automation with a bearer token |

## TL;DR — what to add tonight

1. **`TODOIST_TOKEN`** — 30 seconds (Todoist developer settings).
2. **`GMAIL_*`** — a Google Cloud project + OAuth client (I'll hand you the mint script).
3. **Verify `FASTMAIL_TOKEN`** is set with Mail+Calendars+Contacts scope.
4. **Confirm** the uploaded Dropbox key is the **full-Dropbox** one (not app-folder).
5. **Confirm** your Cloudflare **Workers plan is paid** (for Containers).
