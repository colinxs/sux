#!/bin/sh
# CGI residential-fetch proxy for OpenWRT (uhttpd + curl + openssl + jq).
# Node-free port of node/server.mjs, speaking the same wire contract the
# Cloudflare Worker uses: POST /fetch, HMAC(x-timestamp "\n" body), JSON reply.
set -u

SECRET_FILE=/etc/sux-proxy.secret
SECRET=$(cat "$SECRET_FILE" 2>/dev/null)

emit() {
	printf 'Status: %s\r\n' "$1"
	printf 'Content-Type: application/json\r\n\r\n'
	shift
	printf '%s' "$*"
}

[ -n "$SECRET" ] || { emit 500 '{"error":"no_secret"}'; exit 0; }
[ "${REQUEST_METHOD:-}" = "POST" ] || { emit 404 '{"error":"not_found"}'; exit 0; }

req=$(mktemp); resp=$(mktemp); hdr=$(mktemp); cfg=$(mktemp); bodyf=$(mktemp)
trap 'rm -f "$req" "$resp" "$hdr" "$cfg" "$bodyf"' EXIT

len=${CONTENT_LENGTH:-0}
[ "$len" -gt 0 ] && head -c "$len" > "$req" || : > "$req"
[ "$len" -gt 1000000 ] && { emit 413 '{"error":"body_too_large"}'; exit 0; }

calc=$( { printf '%s\n' "${HTTP_X_TIMESTAMP:-}"; cat "$req"; } | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*=[[:space:]]*//' )
[ -n "${HTTP_X_SIGNATURE:-}" ] && [ "$calc" = "$HTTP_X_SIGNATURE" ] || { emit 401 '{"error":"unauthorized"}'; exit 0; }

url=$(jq -r '.url // empty' "$req")
[ -n "$url" ] || { emit 400 '{"error":"missing_url"}'; exit 0; }
case "$url" in http://*|https://*) : ;; *) emit 400 '{"error":"bad_scheme"}'; exit 0 ;; esac
method=$(jq -r '.method // "GET" | ascii_upcase' "$req")

printf 'user-agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"\n' > "$cfg"
jq -r '.headers // {} | to_entries[] | select(.key|ascii_downcase != "user-agent") | "header = \"\(.key): \(.value)\""' "$req" >> "$cfg" 2>/dev/null

has_body=$(jq -r 'if (.body // "") == "" then "0" else "1" end' "$req")
[ "$has_body" = "1" ] && jq -rj '.body' "$req" > "$bodyf"

if [ "$has_body" = "1" ]; then
	code=$(curl -sS -m 30 --max-filesize 5000000 -o "$resp" -D "$hdr" -w '%{http_code}' -X "$method" --config "$cfg" --data-binary @"$bodyf" --url "$url" 2>/dev/null) || code=000
else
	code=$(curl -sS -m 30 --max-filesize 5000000 -o "$resp" -D "$hdr" -w '%{http_code}' -X "$method" --config "$cfg" --url "$url" 2>/dev/null) || code=000
fi

[ "$code" = "000" ] && { emit 502 '{"error":"upstream_failed"}'; exit 0; }
ct=$(grep -i '^content-type:' "$hdr" | tail -n1 | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//; s/[[:space:]]*$//')

emit 200 "$(jq -n --arg status "$code" --arg ct "$ct" --rawfile body "$resp" \
	'{status:($status|tonumber? // 0), statusText:"", headers:{"content-type":$ct}, bytes:($body|length), truncated:false, body:$body}')"
