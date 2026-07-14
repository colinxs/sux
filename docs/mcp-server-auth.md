---
title: MCP server auth — cloudflare / grafana-cloud / sux
status: reference
---

# Authorizing the remaining MCP connectors

Three MCP connectors sux/tooling depends on ship with **OAuth-gated tools**: they
appear in a session's deferred-tool list but every call 401s until a human clicks
through a browser consent screen. That grant **cannot come from an unattended
agent session** — there is no client secret or refresh token to script around; the
consent screen is the auth. This doc is the turnkey runbook for the one-time (or
periodic re-auth) click-through, so it's never re-derived from scratch. Closes
SuxOS/sux#341.

## The three connectors

| Connector | Plugin id | Gates |
|---|---|---|
| Cloudflare | `plugin:cloudflare:cloudflare-api`, `cloudflare-bindings`, `cloudflare-builds`, `cloudflare-observability` | Workers/KV/D1/R2 admin + observability queries |
| Grafana Cloud | `plugin:grafana-cloud-mcp:grafana-cloud` | dashboards, Loki/Prometheus/Tempo queries, incidents, on-call |
| sux | `plugin:sux:sux` | the full sux fn surface over MCP (same tools this repo builds) |

## Steps (run these yourself, in an interactive `claude` session)

1. Open a normal interactive terminal (not a headless/cron/CI session — the OAuth
   redirect needs a real browser and a human on the other end of the click).
2. Run `claude` in this repo (or any repo with these plugins enabled), then type
   `/mcp`.
3. Pick each of the three connectors listed above in turn. Claude Code opens the
   provider's consent page in your default browser.
4. Approve the grant. Claude Code stores the resulting token itself — nothing to
   copy/paste, nothing lands in git, `wrangler secret`, or GitHub Actions secrets.
5. Repeat for all three; `/mcp` lists connection state so you can see at a glance
   which are still unauthorized.

If you're doing this from claude.ai (not the CLI): Settings → Connectors → find
the connector → Connect, same consent-page flow.

## Re-auth (when a grant expires or gets revoked)

Same steps — `/mcp` shows an expired/disconnected connector the same way as a
never-connected one. There's no separate "refresh" command; re-running the
connect flow is the refresh.

## Verifying it worked

`claude mcp list` already health-checks every configured connector headlessly —
no interactive session needed for the *check*, only for the *grant*.
`scripts/mcp-auth-check.sh` filters that output to the three connectors above and
exits non-zero if any still need auth:

```
./scripts/mcp-auth-check.sh
```

It does not attempt to drive the OAuth flow itself (that part is inherently a
human click, see above) — it only reports which connector(s) still need it.

## Why this can't be scripted further

Every one of these three is a standard OAuth **authorization-code** grant to a
provider-hosted consent page (Cloudflare's, Grafana's, and sux's own `/mychart`-style
Worker-hosted authorize endpoint). Anthropic's MCP connector framework performs the
redirect + code exchange itself once you click Connect — there is no API that
mints the same grant non-interactively, and there shouldn't be: it's the same
"a human approves access to their own account" boundary as any other OAuth login.
Automating past it would mean storing a credential capable of re-granting these
scopes unattended, which is exactly the failure mode sux's zero-stored-credential
posture (see `docs/secrets.md`) exists to avoid.
