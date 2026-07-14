#!/usr/bin/env bash
# op-centralize.sh — one-shot: pull every readable token out of your PERSONAL
# 1Password account (the old op://Private/… items) into the Teams `Secrets` vault,
# so op://Secrets/NAME/credential becomes the single source of truth.
#
# WHY a script and not a click: the values live in one account and must land in
# another, titled to match the secret NAME, in the `credential` field. This does
# it idempotently with a clear before/after report.
#
# RUN IT IN YOUR OWN TERMINAL (not CI). It needs a HUMAN session on BOTH accounts
# and must NOT use the service-account token (that's read-only + wrong account):
#
#     env -u OP_SERVICE_ACCOUNT_TOKEN scripts/op-centralize.sh --dry-run
#     env -u OP_SERVICE_ACCOUNT_TOKEN scripts/op-centralize.sh
#     env -u OP_SERVICE_ACCOUNT_TOKEN scripts/op-centralize.sh --force   # overwrite existing
#
# Values flow account→account through a shell var, never printed or written to disk.
set -uo pipefail

SRC_ACCOUNT="${SRC_ACCOUNT:-my}"        # personal account holding the old items
DST_ACCOUNT="${DST_ACCOUNT:-suxos}"     # Teams account with the Secrets vault
DST_VAULT="${DST_VAULT:-Secrets}"

DRY=false; FORCE=false
for a in "$@"; do case "$a" in
  --dry-run) DRY=true ;; --force) FORCE=true ;;
  *) echo "unknown flag: $a"; exit 2 ;;
esac; done

# NAME  <TAB>  op://<personal ref>   — the readable sources (from set-secrets.sh MAP).
read -r -d '' SRC_MAP <<'EOF'
FASTMAIL_TOKEN            op://Private/Fastmail sux/credential
FASTMAIL_CALDAV_USER      op://Private/Fastmail sux/username
FASTMAIL_APP_PASSWORD     op://Private/Fastmail sux/app_password
TODOIST_TOKEN            op://Private/Todoist API/token
DROPBOX_APP_KEY          op://Private/Dropbox sux app/app_key
DROPBOX_APP_SECRET       op://Private/Dropbox sux app/app_secret
DROPBOX_REFRESH_TOKEN    op://Private/Dropbox sux app/refresh_token
OBSIDIAN_REST_TOKEN      op://Private/Obsidian Local REST/api_key
REDDIT_CLIENT_ID         op://Private/Reddit sux app/client_id
REDDIT_CLIENT_SECRET     op://Private/Reddit sux app/client_secret
EBAY_CLIENT_ID           op://Private/eBay sux keyset/app_id
EBAY_CLIENT_SECRET       op://Private/eBay sux keyset/cert_id
FACEBOOK_TOKEN           op://Private/Facebook sux token/token
EPIC_FHIR_CLIENT_ID      op://Private/Epic FHIR sux/client_id
APPLE_HEALTH_TOKEN       op://Private/Apple Health sux/token
EOF

command -v op >/dev/null 2>&1 || { echo "✗ op not found"; exit 1; }
if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  echo "✗ OP_SERVICE_ACCOUNT_TOKEN is set — it's read-only and pins the wrong account."
  echo "  Re-run with:  env -u OP_SERVICE_ACCOUNT_TOKEN $0 $*"; exit 1
fi
op whoami --account "$SRC_ACCOUNT" >/dev/null 2>&1 || { echo "✗ no session for source account '$SRC_ACCOUNT' — unlock it in the app"; exit 1; }
op whoami --account "$DST_ACCOUNT" >/dev/null 2>&1 || { echo "✗ no session for dest account '$DST_ACCOUNT' — unlock it in the app"; exit 1; }
op vault get "$DST_VAULT" --account "$DST_ACCOUNT" >/dev/null 2>&1 || { echo "✗ vault '$DST_VAULT' not found in $DST_ACCOUNT"; exit 1; }

echo "Centralizing $SRC_ACCOUNT  ->  $DST_ACCOUNT/$DST_VAULT   (dry-run=$DRY force=$FORCE)"
echo
pull=0 skip=0 miss=0 fail=0
while IFS= read -r line; do
  [ -z "${line// }" ] && continue
  name="${line%% *}"
  ref="$(echo "${line#"$name"}" | sed 's/^[[:space:]]*//')"

  # already in the Secrets vault with a value?  (idempotent unless --force)
  if ! $FORCE && op read "op://$DST_VAULT/$name/credential" --account "$DST_ACCOUNT" >/dev/null 2>&1; then
    printf '  have  %-24s (already in %s)\n' "$name" "$DST_VAULT"; skip=$((skip+1)); continue
  fi
  # read from personal
  if ! val="$(op read "$ref" --account "$SRC_ACCOUNT" 2>/dev/null)" || [ -z "$val" ]; then
    printf '  MISS  %-24s (not readable at %s)\n' "$name" "$ref"; miss=$((miss+1)); continue
  fi
  if $DRY; then printf '  pull  %-24s <- %s\n' "$name" "$ref"; pull=$((pull+1)); unset val; continue; fi

  if op item get "$name" --vault "$DST_VAULT" --account "$DST_ACCOUNT" >/dev/null 2>&1; then
    op item edit "$name" --vault "$DST_VAULT" --account "$DST_ACCOUNT" "credential=$val" >/dev/null 2>&1 \
      && { printf '  set   %-24s (updated)\n' "$name"; pull=$((pull+1)); } || { printf '  FAIL  %-24s\n' "$name"; fail=$((fail+1)); }
  else
    op item create --vault "$DST_VAULT" --account "$DST_ACCOUNT" --category "API Credential" \
      --title "$name" "credential=$val" >/dev/null 2>&1 \
      && { printf '  set   %-24s (created)\n' "$name"; pull=$((pull+1)); } || { printf '  FAIL  %-24s\n' "$name"; fail=$((fail+1)); }
  fi
  unset val
done <<< "$SRC_MAP"

echo
echo "done: ${pull} pulled · ${skip} already present · ${miss} no personal source · ${fail} failed"
$DRY && echo "(dry run — nothing written)"
cat <<'EOF'

NOT auto-pullable (no readable op source — these live only in a write-only store,
or are settings/switches that do NOT belong in op). Handle by hand:
  • Re-source from origin, then put in op://Secrets/NAME/credential:
      KAGI_API_KEY BRAVE_API_KEY EXA_API_KEY TAVILY_API_KEY BING_API_KEY S2_API_KEY
      GOOGLE_MAPS_KEY NCBI_API_KEY STACKEXCHANGE_KEY BESTBUY_API_KEY YOUTUBE_API_KEY
      KROGER_CLIENT_ID KROGER_CLIENT_SECRET CONTROLD_API_TOKEN
      GITHUB_TOKEN GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET COOKIE_ENCRYPTION_KEY
      TAILSCALE_OAUTH_CLIENT_ID TAILSCALE_OAUTH_CLIENT_SECRET TAILSCALE_PROXY_SECRET
      ANTHROPIC_API_KEY CLOUDFLARE_API_TOKEN SUX_MCP_TOKEN SUX_BOT_PRIVATE_KEY SUX_CRON_TOKEN
      DROPBOX_FULL_REFRESH_TOKEN DROPBOX_FULL_APP_KEY DROPBOX_FULL_TOKEN MONARCH_TOKEN
      GRAFANA_LOKI_TOKEN HEALTH_INGEST_TOKEN
  • NOT secrets — belong in wrangler.jsonc [vars], not op (per docs/secrets.md tier-2/3):
      *_URL fields, TAILSCALE_TAILNET, VAULT_TZ, DROPBOX_FULL_PROTECT_PREFIXES,
      FASTMAIL_ACCOUNT_ID, FASTMAIL_SESSION_URL, MAIL_TRIAGE_*, SELF_IMPROVE_* (switches)
EOF
exit $(( fail > 0 ? 1 : 0 ))
