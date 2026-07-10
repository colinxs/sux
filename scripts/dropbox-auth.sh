#!/usr/bin/env bash
#
# dropbox-auth.sh <APP_KEY> — mint a Dropbox refresh token and set all three Worker
# secrets, WITHOUT the secret or token ever leaving your shell. Run it, paste the App
# secret once (hidden), approve in the browser, paste the code. Done.
#
#   ./scripts/dropbox-auth.sh 9ynew5uy7ov76ic
#
set -uo pipefail
cd "$(dirname "$0")/.."
KEY="${1:?usage: ./scripts/dropbox-auth.sh <APP_KEY>   (yours is 9ynew5uy7ov76ic)}"
CFG="sux/wrangler.jsonc"

read -rsp "Dropbox App secret (App Console → your app → Settings → 'Show' → copy): " SECRET; echo
[ -z "$SECRET" ] && { echo "no secret entered"; exit 1; }

AUTH="https://www.dropbox.com/oauth2/authorize?client_id=${KEY}&response_type=code&token_access_type=offline"
echo; echo "1) Open this, click Allow, copy the code it shows:"; echo "   $AUTH"
command -v open >/dev/null 2>&1 && open "$AUTH" 2>/dev/null
echo
read -rp "2) Paste the authorization code: " CODE
[ -z "$CODE" ] && { echo "no code entered"; exit 1; }

RESP=$(curl -s https://api.dropboxapi.com/oauth2/token -d code="$CODE" -d grant_type=authorization_code -u "$KEY:$SECRET")
REFRESH=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)
if [ -z "$REFRESH" ]; then echo "✗ no refresh_token returned. Dropbox said: $RESP"; exit 1; fi

printf '%s' "$KEY"     | npx wrangler secret put DROPBOX_APP_KEY --config "$CFG" >/dev/null 2>&1 && echo "  ✓ DROPBOX_APP_KEY"
printf '%s' "$SECRET"  | npx wrangler secret put DROPBOX_APP_SECRET --config "$CFG" >/dev/null 2>&1 && echo "  ✓ DROPBOX_APP_SECRET"
printf '%s' "$REFRESH" | npx wrangler secret put DROPBOX_REFRESH_TOKEN --config "$CFG" >/dev/null 2>&1 && echo "  ✓ DROPBOX_REFRESH_TOKEN"
echo "✓ Dropbox set — reconnect the files connector and /files/mcp is live."
