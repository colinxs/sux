#!/bin/sh
# GET /status — HMAC(x-timestamp "\n" "/status"), returns `tailscale status --json`.
set -u
SECRET=$(cat /etc/sux-proxy.secret 2>/dev/null)

emit() { printf 'Status: %s\r\nContent-Type: application/json\r\n\r\n%s' "$1" "$2"; }

[ -n "$SECRET" ] || { emit 500 '{"error":"no_secret"}'; exit 0; }
calc=$( printf '%s\n/status' "${HTTP_X_TIMESTAMP:-}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*=[[:space:]]*//' )
[ -n "${HTTP_X_SIGNATURE:-}" ] && [ "$calc" = "$HTTP_X_SIGNATURE" ] || { emit 401 '{"error":"unauthorized"}'; exit 0; }

emit 200 "$(tailscale status --json 2>/dev/null || echo '{}')"
