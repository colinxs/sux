#!/bin/sh
# recovery-checkin.sh — box-side client for the sux recovery dead-drop.
#
# The home router (owl-tegu) runs this on a timer (cron / a while-sleep loop). It
# gathers a small health snapshot, HMAC-signs the checkin body, POSTs it to the sux
# Worker, then VERIFIES the signature of every command handed back before dispatching
# the allow-listed action locally. The Worker executes nothing — it's a dead-drop;
# this script is the only thing that acts, and only on commands whose HMAC checks out.
#
# This is a REFERENCE client — the dispatch stubs at the bottom are intentionally
# no-ops to be filled in when embedded in the router's first-run self-heal script.
#
# Dependencies (all present on stock OpenWrt / busybox once installed):
#   - openssl        (HMAC-SHA256; `opkg install openssl-util`)
#   - jq             (JSON build + parse + canonical `-S` sort; `opkg install jq`)
#   - a fetcher: curl (`opkg install curl`) or busybox wget
# No bash, no arrays, no GNU-isms — POSIX sh only.
#
# Secrets (set out-of-band on the box, e.g. in /etc/sux-recovery.env, chmod 600):
#   SUX_RECOVERY_URL      base Worker URL, e.g. https://sux.example.workers.dev
#   RECOVERY_HMAC_SECRET  shared secret — signs the checkin (matches the Worker's)
#   RECOVERY_CMD_SECRET   optional — verifies returned commands; defaults to HMAC secret
#   RECOVERY_NODE_ID      this box's id, e.g. owl-tegu  ([A-Za-z0-9._-], <=64)

set -eu

: "${SUX_RECOVERY_URL:?set SUX_RECOVERY_URL}"
: "${RECOVERY_HMAC_SECRET:?set RECOVERY_HMAC_SECRET}"
: "${RECOVERY_NODE_ID:?set RECOVERY_NODE_ID}"
CMD_SECRET="${RECOVERY_CMD_SECRET:-$RECOVERY_HMAC_SECRET}"

# HMAC-SHA256 of stdin under $1, printed as lowercase hex (no trailing newline issues:
# `-hmac` reads the key, awk takes the last field — the digest — across openssl versions).
hmac_hex() { openssl dgst -sha256 -hmac "$1" | awk '{print $NF}'; }

http_post() { # $1 url  $2 body  $3 sig-header-value
	if command -v curl >/dev/null 2>&1; then
		curl -fsS -m 20 -X POST -H 'content-type: application/json' -H "x-sux-signature: $3" --data "$2" "$1"
	else
		wget -q -O - --timeout=20 --header='content-type: application/json' --header="x-sux-signature: $3" --post-data="$2" "$1"
	fi
}

# --- gather a tiny health snapshot (best-effort; keep each probe cheap + non-hanging) ---
probe_wan() { ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && echo up || echo down; }
probe_dns() { nslookup cloudflare.com >/dev/null 2>&1 && echo up || echo down; }
probe_ts()  { command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1 && echo up || echo down; }

NOW="$(date +%s)"
NONCE="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# Build the checkin body with jq so it's valid JSON; we then sign the EXACT bytes we POST.
BODY="$(jq -cn \
	--arg node "$RECOVERY_NODE_ID" \
	--argjson ts "$NOW" \
	--arg nonce "$NONCE" \
	--arg wan "$(probe_wan)" --arg dns "$(probe_dns)" --arg ts_state "$(probe_ts)" \
	'{node_id:$node, timestamp:$ts, nonce:$nonce, health:{wan:$wan, dns:$dns, tailscale:$ts_state}}')"

SIG="$(printf '%s' "$BODY" | hmac_hex "$RECOVERY_HMAC_SECRET")"

RESP="$(http_post "$SUX_RECOVERY_URL/recovery/checkin" "$BODY" "$SIG")" || {
	echo "checkin failed (Worker unreachable or rejected)" >&2
	exit 1
}

# --- verify + dispatch each returned command ---
# Canonical signing string the Worker used: action\nSORTED-COMPACT(args)\nnonce\nexpires.
# `jq -Sc` reproduces the Worker's stableStringify (recursive key sort, compact).
NCMD="$(printf '%s' "$RESP" | jq '.commands | length')"
i=0
while [ "$i" -lt "$NCMD" ]; do
	CMD="$(printf '%s' "$RESP" | jq -c ".commands[$i]")"
	ACTION="$(printf '%s' "$CMD"  | jq -r '.action')"
	NONCE_C="$(printf '%s' "$CMD" | jq -r '.nonce')"
	EXPIRES="$(printf '%s' "$CMD" | jq -r '.expires')"
	ARGS="$(printf '%s' "$CMD"    | jq -Sc '.args')"
	SIG_C="$(printf '%s' "$CMD"   | jq -r '.sig')"

	SIGN_STR="$(printf '%s\n%s\n%s\n%s' "$ACTION" "$ARGS" "$NONCE_C" "$EXPIRES")"
	EXPECT="$(printf '%s' "$SIGN_STR" | hmac_hex "$CMD_SECRET")"

	if [ "$SIG_C" != "$EXPECT" ]; then
		echo "SKIP command '$ACTION' — bad signature" >&2
		i=$((i + 1)); continue
	fi
	if [ "$EXPIRES" -le "$NOW" ]; then
		echo "SKIP command '$ACTION' — expired" >&2
		i=$((i + 1)); continue
	fi

	# Allow-listed dispatch. Fill these in for the real box; strings only, box-local.
	case "$ACTION" in
		open-wan-ssh)      echo "DISPATCH open-wan-ssh $ARGS"      ;; # e.g. uci set firewall wan-ssh + reload
		close-wan-ssh)     echo "DISPATCH close-wan-ssh $ARGS"     ;;
		restart-tailscale) echo "DISPATCH restart-tailscale $ARGS" ;; # e.g. /etc/init.d/tailscale restart
		restart-dns)       echo "DISPATCH restart-dns $ARGS"       ;; # e.g. /etc/init.d/dnsmasq restart
		restore-config)    echo "DISPATCH restore-config $ARGS"    ;; # e.g. sysupgrade -r /root/last-good.tar.gz
		reboot)            echo "DISPATCH reboot $ARGS"            ;; # e.g. reboot
		noop)              echo "DISPATCH noop (heartbeat only)"   ;;
		*)                 echo "SKIP unknown action '$ACTION'" >&2 ;;
	esac
	i=$((i + 1))
done
