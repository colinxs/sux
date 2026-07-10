#!/usr/bin/env bash
#
# dropbox-full-auth.sh [APP_KEY] — mint the FULL-Dropbox (Mode B) refresh token via PKCE
# and set the DROPBOX_FULL_* Worker secrets. Secret-less by design: this uses a PKCE public
# client (no App secret), matching how the Worker holds NO Dropbox secret. Nothing sensitive
# leaves your shell except the refresh token, which goes straight into a Worker secret.
#
#   ./scripts/dropbox-full-auth.sh iqjkxr041hbjujd
#
# PREREQUISITE (one-time, in the Dropbox App Console for this app):
#   • Permission type: **Full Dropbox** (NOT App folder — that's Mode A's separate app)
#   • Permissions tab: check files.metadata.read, files.content.read, sharing.read → **Submit**
#     (Mode B is read-only; leave the .write scopes unchecked unless you want them for later.)
# Without saving those scopes first, the token below will be under-scoped.
#
set -uo pipefail
cd "$(dirname "$0")/.."
KEY="${1:-iqjkxr041hbjujd}"
CFG="sux/wrangler.jsonc"
command -v openssl >/dev/null 2>&1 || { echo "openssl required"; exit 1; }

# PKCE: a high-entropy verifier + its S256 challenge. The verifier never leaves this shell.
VERIFIER=$(openssl rand -base64 96 | tr -d '\n=+/' | cut -c1-96)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')

AUTH="https://www.dropbox.com/oauth2/authorize?client_id=${KEY}&response_type=code&token_access_type=offline&code_challenge=${CHALLENGE}&code_challenge_method=S256"
echo "1) Open this, click Allow, copy the code it shows:"; echo "   $AUTH"; echo
command -v open >/dev/null 2>&1 && open "$AUTH" 2>/dev/null
read -rp "2) Paste the authorization code: " CODE
[ -z "$CODE" ] && { echo "no code entered"; exit 1; }

RESP=$(curl -s https://api.dropboxapi.com/oauth2/token \
  -d code="$CODE" -d grant_type=authorization_code \
  -d client_id="$KEY" -d code_verifier="$VERIFIER")
REFRESH=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)
if [ -z "$REFRESH" ]; then echo "✗ no refresh_token returned. Dropbox said: $RESP"; exit 1; fi

printf '%s' "$KEY"     | npx wrangler secret put DROPBOX_FULL_APP_KEY --config "$CFG" >/dev/null 2>&1 && echo "  ✓ DROPBOX_FULL_APP_KEY"
printf '%s' "$REFRESH" | npx wrangler secret put DROPBOX_FULL_REFRESH_TOKEN --config "$CFG" >/dev/null 2>&1 && echo "  ✓ DROPBOX_FULL_REFRESH_TOKEN"
echo "✓ Full-Dropbox (Mode B) set — files_search + files_read/files_list full:true are now live."
echo "  Sanity check: files_search { query: \"<something you know is outside /Apps>\" }"
