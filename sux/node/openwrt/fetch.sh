#!/bin/sh
# CGI residential-fetch proxy for OpenWRT (uhttpd + curl-impersonate + openssl + jq).
# Node-free port of node/server.mjs speaking the Worker's wire contract.
# uhttpd drops custom request headers on POST, so the Worker sends the HMAC
# ts+sig in the QUERY_STRING (header fallback kept).
#
# TLS/JA3+HTTP2 fingerprint: Akamai/Cloudflare block plain curl's handshake even
# from a residential IP. If a curl-impersonate `curl_chrome*` wrapper is present
# we use it (Chrome-coherent TLS + HTTP2 + headers) and let it OWN the
# fingerprint headers — forwarding those would break coherence. Falls back to
# plain curl when the wrapper isn't installed.
set -u

SECRET=$(cat /etc/sux-proxy.secret 2>/dev/null)
emit() { printf 'Status: %s\r\n' "$1"; printf 'Content-Type: application/json\r\n\r\n'; shift; printf '%s' "$*"; }

[ -n "$SECRET" ] || { emit 500 '{"error":"no_secret"}'; exit 0; }
[ "${REQUEST_METHOD:-}" = "POST" ] || { emit 404 '{"error":"not_found"}'; exit 0; }

# Locate a curl-impersonate Chrome wrapper (highest version wins). Its dir goes
# on PATH so the wrapper finds its curl-impersonate binary sibling.
IMP=""
for d in /opt/curl-impersonate/bin /opt/curl-impersonate /usr/local/curl-impersonate/bin /usr/local/curl-impersonate /usr/local/bin /usr/bin /root/curl-impersonate/bin /root/curl-impersonate; do
	IMP=$(ls "$d"/curl_chrome* 2>/dev/null | sort -V | tail -1)
	[ -n "$IMP" ] && [ -x "$IMP" ] && { export PATH="$d:$PATH"; break; }
	IMP=""
done

qts=$(printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | sed -n 's/^ts=//p')
qsig=$(printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | sed -n 's/^sig=//p')
TS="${qts:-${HTTP_X_TIMESTAMP:-}}"; SIG="${qsig:-${HTTP_X_SIGNATURE:-}}"

req=$(mktemp); resp=$(mktemp); hdr=$(mktemp); cfg=$(mktemp); bodyf=$(mktemp)
trap 'rm -f "$req" "$resp" "$hdr" "$cfg" "$bodyf"' EXIT

cat > "$req"
len=$(wc -c < "$req" | tr -d ' ')
[ "$len" -gt 1000000 ] && { emit 413 '{"error":"body_too_large"}'; exit 0; }

calc=$( { printf '%s\n' "$TS"; cat "$req"; } | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*=[[:space:]]*//' )
[ -n "$SIG" ] && [ "$calc" = "$SIG" ] || { emit 401 '{"error":"unauthorized"}'; exit 0; }

# Replay guard (defense-in-depth): the HMAC covers TS, but a captured (TS, body)
# pair signs forever unless TS is also required to be recent — the ts+sig ride
# the query string (proxy.ts) and can leak via logged Funnel URLs. Reject a
# timestamp skewed more than 5 min from the node clock. TS is epoch-ms (the
# Worker's Date.now()); compare in whole seconds (drop the 3 ms digits) so the
# arithmetic stays 32-bit-safe on small OpenWRT targets.
case "$TS" in ''|*[!0-9]*) emit 401 '{"error":"unauthorized"}'; exit 0 ;; esac
ts_s=${TS%???}; [ -n "$ts_s" ] || ts_s=0
now_s=$(date +%s)
skew=$(( now_s - ts_s )); [ "$skew" -lt 0 ] && skew=$(( -skew ))
[ "$skew" -le 300 ] || { emit 401 '{"error":"stale_timestamp"}'; exit 0; }

url=$(jq -r '.url // empty' "$req")
[ -n "$url" ] || { emit 400 '{"error":"missing_url"}'; exit 0; }
case "$url" in http://*|https://*) : ;; *) emit 400 '{"error":"bad_scheme"}'; exit 0 ;; esac

# SSRF guard (defense-in-depth; mirrors src/proxy.ts isBlockedTarget). This box
# sits inside the home LAN, so refuse loopback / private / link-local / CGNAT /
# ULA / metadata destinations before curl ever reaches them. Extract the host:
# drop scheme, path/query/fragment, and userinfo; unwrap a bracketed IPv6, else
# strip the :port.
authority=$(printf '%s' "$url" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#[/?#].*$##' -e 's#^[^@]*@##')
case "$authority" in
	\[*\]*) host=$(printf '%s' "$authority" | sed -e 's#^\[##' -e 's#\].*$##') ;;
	*) host=${authority%%:*} ;;
esac
host=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
case "$host" in
	*:*) # IPv6 literal: loopback / ULA (fc00::/7) / link-local (fe80::/10)
		case "$host" in ::1|::ffff:*|fc*|fd*|fe8*|fe9*|fea*|feb*) emit 400 '{"error":"blocked_target"}'; exit 0 ;; esac ;;
	*) # localhost / IPv4 dotted-decimal private ranges
		case "$host" in
			localhost|*.localhost|0.*|10.*|127.*|169.254.*|192.168.* \
			|172.1[6-9].*|172.2[0-9].*|172.3[01].* \
			|100.6[4-9].*|100.7[0-9].*|100.8[0-9].*|100.9[0-9].*|100.1[01][0-9].*|100.12[0-7].*)
				emit 400 '{"error":"blocked_target"}'; exit 0 ;;
		esac ;;
esac
method=$(jq -r '.method // "GET" | ascii_upcase' "$req")

# Header config. With curl-impersonate, forward only NON-fingerprint headers
# (auth, content-type, cookies, custom) — the wrapper owns UA/Accept/sec-*.
# Without it, keep the old browser-UA default + all forwarded headers but UA.
#
# Header-injection guard (defense-in-depth; mirrors src/proxy.ts hasUnsafeHeader):
# each header is written raw into this --config file as `header = "KEY: VALUE"`,
# so a CR/LF in a key/value would break out of the line and inject arbitrary curl
# directives (rewrite -o over a node file, add request URLs, leak the secret), and
# a double-quote would terminate the quoted arg. Drop any header whose key or
# value contains CR, LF or a double-quote before it reaches the config file.
: > "$cfg"
if [ -n "$IMP" ]; then
	jq -r '.headers // {} | to_entries[]
		| select(.key|ascii_downcase | IN("user-agent","accept","accept-encoding","accept-language","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","sec-fetch-dest","sec-fetch-mode","sec-fetch-site","sec-fetch-user","upgrade-insecure-requests","priority","connection","host","content-length") | not)
		| select(((.key + (.value|tostring)) | test("[\r\n\"]")) | not)
		| "header = \"\(.key): \(.value)\""' "$req" >> "$cfg" 2>/dev/null
else
	printf 'user-agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"\n' > "$cfg"
	jq -r '.headers // {} | to_entries[]
		| select(.key|ascii_downcase != "user-agent")
		| select(((.key + (.value|tostring)) | test("[\r\n\"]")) | not)
		| "header = \"\(.key): \(.value)\""' "$req" >> "$cfg" 2>/dev/null
fi

CURL="${IMP:-curl}"
has_body=$(jq -r 'if (.body // "") == "" then "0" else "1" end' "$req")
[ "$has_body" = "1" ] && jq -rj '.body' "$req" > "$bodyf"

if [ "$has_body" = "1" ]; then
	code=$("$CURL" -sS -m 30 --max-filesize 5000000 -o "$resp" -D "$hdr" -w '%{http_code}' -X "$method" --config "$cfg" --data-binary @"$bodyf" --url "$url" 2>/dev/null) || code=000
else
	code=$("$CURL" -sS -m 30 --max-filesize 5000000 -o "$resp" -D "$hdr" -w '%{http_code}' -X "$method" --config "$cfg" --url "$url" 2>/dev/null) || code=000
fi

[ "$code" = "000" ] && { emit 502 '{"error":"upstream_failed"}'; exit 0; }
ct=$(grep -i '^content-type:' "$hdr" | tail -n1 | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//; s/[[:space:]]*$//')

# Always base64 the body + flag bodyEncoding:"base64" so binary survives the
# JSON transport and reaches the Worker's residential path (text and binary alike).
rbytes=$(wc -c < "$resp" | tr -d ' ')
b64=$(openssl base64 -A < "$resp")
emit 200 "$(jq -n --arg status "$code" --arg ct "$ct" --arg body "$b64" --arg bytes "$rbytes" \
	'{status:($status|tonumber? // 0), statusText:"", headers:{"content-type":$ct}, bytes:($bytes|tonumber? // 0), truncated:false, bodyEncoding:"base64", body:$body}')"
