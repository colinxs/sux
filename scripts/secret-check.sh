#!/usr/bin/env bash
# secret-check — audit for secret drift. Lists names (never values) from the
# Cloudflare Worker and GitHub Actions stores and diffs them against the expected
# set below, so a missing/forgotten secret surfaces before a bot silently breaks.
# Names only — safe to run anywhere. Portable (bash 3.2 / macOS).
set -euo pipefail

# --- expected sets (space-separated; keep in sync with docs/secrets.md) ---
WORKER_REQUIRED="ALLOWED_GITHUB_LOGIN COOKIE_ENCRYPTION_KEY GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_TOKEN \
KAGI_API_KEY BRAVE_API_KEY EXA_API_KEY TAVILY_API_KEY GOOGLE_MAPS_KEY NCBI_API_KEY STACKEXCHANGE_KEY \
FASTMAIL_TOKEN FASTMAIL_CALDAV_USER FASTMAIL_APP_PASSWORD DROPBOX_APP_KEY DROPBOX_REFRESH_TOKEN \
TODOIST_TOKEN CONTROLD_API_TOKEN KROGER_CLIENT_ID KROGER_CLIENT_SECRET \
TAILSCALE_OAUTH_CLIENT_ID TAILSCALE_OAUTH_CLIENT_SECRET TAILSCALE_TAILNET TAILSCALE_PROXY_SECRET TAILSCALE_PROXY_URL \
MAC_RENDER_SECRET MAC_RENDER_URL GRAFANA_LOKI_TOKEN GRAFANA_LOKI_URL GRAFANA_LOKI_USER \
OBSIDIAN_REMOTE_KEY OBSIDIAN_REMOTE_URL OBSIDIAN_VAULT_REPO HEALTH_INGEST_TOKEN"

# Optional (feature-gated; absent == that feature simply off — not an error):
WORKER_OPTIONAL="MAIL_TRIAGE_ENABLED MAIL_TRIAGE_ACT SELF_IMPROVE_ENABLE SELF_IMPROVE_PR SELF_IMPROVE_ARM \
SELF_IMPROVE_KILL SELF_IMPROVE_REPO SUX_CRON_TOKEN UNLOCKER_API_URL UNLOCKER_API_KEY DROPBOX_APP_SECRET DROPBOX_TOKEN \
DROPBOX_FULL_REFRESH_TOKEN DROPBOX_FULL_APP_KEY DROPBOX_FULL_TOKEN DROPBOX_FULL_PROTECT_PREFIXES \
BESTBUY_API_KEY EBAY_CLIENT_ID EBAY_CLIENT_SECRET REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET S2_API_KEY \
BING_API_KEY FACEBOOK_TOKEN YOUTUBE_API_KEY FASTMAIL_ACCOUNT_ID FASTMAIL_SESSION_URL VAULT_TZ \
OBSIDIAN_VAULT_BRANCH OBSIDIAN_VAULT_DIR MONARCH_TOKEN"

GITHUB_REQUIRED="CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN SUX_MCP_URL SUX_MCP_TOKEN ANTHROPIC_API_KEY \
SUX_BOT_APP_ID SUX_BOT_PRIVATE_KEY"

contains(){ case " $2 " in *" $1 "*) return 0;; *) return 1;; esac; }

audit(){ # $1 label  $2 actual(newline)  $3 required  $4 optional
  echo "== $1 =="
  local actual; actual="$(printf '%s' "$2" | tr '\n' ' ')"
  local known="$3 ${4:-}"
  local miss="" extra=""
  for k in $3; do contains "$k" "$actual" || miss="$miss $k"; done
  for k in $actual; do contains "$k" "$known" || extra="$extra $k"; done
  if [ -z "$miss" ]; then echo "  ✓ all required present"; else echo "  ✗ MISSING (required):$miss"; fi
  [ -n "$extra" ] && echo "  ? not in manifest (orphan or new — add to docs/secrets.md):$extra" || true
}

worker_actual="$(npx wrangler secret list --config sux/wrangler.jsonc 2>/dev/null | python3 -c 'import sys,json;print("\n".join(x["name"] for x in json.load(sys.stdin)))' 2>/dev/null || true)"
github_actual="$(gh secret list 2>/dev/null | awk '{print $1}' || true)"

audit "Cloudflare Worker" "$worker_actual" "$WORKER_REQUIRED" "$WORKER_OPTIONAL"
echo
audit "GitHub Actions" "$github_actual" "$GITHUB_REQUIRED" ""
echo
echo "(names only — no values printed. Fix a gap: value into op, then scripts/secret-sync.sh NAME --worker|--github)"
