#!/bin/sh
# GET /status — returns `tailscale status --json`. HMAC ts+sig arrive in the
# QUERY_STRING (uhttpd drops custom headers on POST; kept consistent here).
set -u
SECRET=$(cat /etc/sux-proxy.secret 2>/dev/null)
emit() { printf 'Status: %s\r\nContent-Type: application/json\r\n\r\n%s' "$1" "$2"; }

[ -n "$SECRET" ] || { emit 500 '{"error":"no_secret"}'; exit 0; }

qts=$(printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | sed -n 's/^ts=//p')
qsig=$(printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | sed -n 's/^sig=//p')
TS="${qts:-${HTTP_X_TIMESTAMP:-}}"; SIG="${qsig:-${HTTP_X_SIGNATURE:-}}"

calc=$( printf '%s\n/status' "$TS" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*=[[:space:]]*//' )
[ -n "$SIG" ] && [ "$calc" = "$SIG" ] || { emit 401 '{"error":"unauthorized"}'; exit 0; }

emit 200 "$(tailscale status --json 2>/dev/null || echo '{}')"
