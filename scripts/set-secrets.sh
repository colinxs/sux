#!/usr/bin/env bash
#
# set-secrets.sh — set (or rotate) sux Worker secrets straight from 1Password.
#
# WHY: your API tokens live in 1Password; this pipes each one into the Worker via
# `op read | wrangler secret put`. The value flows  vault -> Touch ID -> wrangler
# stdin — it is NEVER printed, logged, or left in shell history. Run it in a
# terminal where the 1Password desktop app is unlocked and the CLI integration is
# on (1Password app -> Settings -> Developer -> "Integrate with 1Password CLI").
#
# USAGE
#   ./scripts/set-secrets.sh                 # set every secret whose op:// ref resolves
#   ./scripts/set-secrets.sh --list          # show which Worker secrets are already set
#   ./scripts/set-secrets.sh --dry-run       # check which refs resolve; set nothing
#   ./scripts/set-secrets.sh FASTMAIL_TOKEN   # only the named secret(s)
#
# EDIT the MAP below so each op:// reference points at YOUR item/field. Discover a
# item's field labels (values stay hidden) with:
#   op item get "<item title>" --format json | python3 -c \
#     'import sys,json;[print(f.get("label")) for f in json.load(sys.stdin).get("fields",[])]'
#
# SCOPE WARNING (this is a public, bot-driven repo): the refs below point at
# dedicated, sux-scoped op items ("Fastmail sux", "Dropbox sux app", …). Keep it
# that way. Do NOT repoint them at your bare personal-account items (op://Private/
# Fastmail, .../Dropbox, …) — that would push your real personal credentials into a
# semi-autonomous Worker, so a Worker compromise leaks your accounts, not just a
# scoped integration. Create a purpose-made, minimally-scoped credential per
# integration (app password / dedicated OAuth app) instead. Prefer a non-personal
# vault (e.g. Secrets) over Private for bot-facing values.
#
set -uo pipefail
cd "$(dirname "$0")/.."
CONFIG="sux/wrangler.jsonc"

# WORKER_SECRET               op://<vault>/<item>/<field>   (edit the item/field to match your vault)
read -r -d '' MAP <<'EOF'
FASTMAIL_TOKEN               op://Private/Fastmail sux/credential
FASTMAIL_CALDAV_USER         op://Private/Fastmail sux/username
FASTMAIL_APP_PASSWORD        op://Private/Fastmail sux/app_password
TODOIST_TOKEN                op://Private/Todoist API/token
DROPBOX_APP_KEY              op://Private/Dropbox sux app/app_key
DROPBOX_APP_SECRET           op://Private/Dropbox sux app/app_secret
DROPBOX_REFRESH_TOKEN        op://Private/Dropbox sux app/refresh_token
OBSIDIAN_REST_TOKEN          op://Private/Obsidian Local REST/api_key
REDDIT_CLIENT_ID             op://Private/Reddit sux app/client_id
REDDIT_CLIENT_SECRET         op://Private/Reddit sux app/client_secret
EBAY_CLIENT_ID               op://Private/eBay sux keyset/app_id
EBAY_CLIENT_SECRET           op://Private/eBay sux keyset/cert_id
FACEBOOK_TOKEN               op://Private/Facebook sux token/token
EPIC_CLIENT_ID               op://Secrets/Epic FHIR sux/client_id_sandbox
EPIC_CLIENT_SECRET           op://Secrets/Epic FHIR sux/client_secret_sandbox
EPIC_FHIR_BASE               op://Secrets/Epic FHIR sux/fhir_base_sandbox
EPIC_JWT_PRIVATE_KEY         op://Secrets/Epic FHIR sux/jwt_private_key
HEALTH_INGEST_TOKEN          op://Secrets/Epic FHIR sux/health_ingest_token
EOF
# NOTE: the three env-specific EPIC refs point at *_sandbox by default (we validate
# against Epic's public sandbox first). To go live, flip the _sandbox suffix to _prod
# on EPIC_CLIENT_ID / EPIC_CLIENT_SECRET / EPIC_FHIR_BASE above and re-run this script.
# EPIC_JWT_PRIVATE_KEY is optional — set it ONLY to use the jwt-bearer/DCR auth mode
# (a client secret is not needed then). See docs/design/token-setup.md §5.

command -v op >/dev/null 2>&1 || { echo "1Password CLI not found — 'brew install 1password-cli'"; exit 1; }
op vault list >/dev/null 2>&1 || { echo "op not authorized — unlock the 1Password app and enable Settings > Developer > Integrate with 1Password CLI"; exit 1; }

MODE="set"; ONLY=()
for a in "$@"; do
	case "$a" in
		--list) MODE="list" ;;
		--dry-run) MODE="dry" ;;
		-*) echo "unknown flag: $a"; exit 1 ;;
		*) ONLY+=("$a") ;;
	esac
done

if [ "$MODE" = "list" ]; then
	npx wrangler secret list --config "$CONFIG"
	exit 0
fi

wanted() { # true if $1 is in ONLY (or ONLY is empty = all)
	[ ${#ONLY[@]} -eq 0 ] && return 0
	local n; for n in "${ONLY[@]}"; do [ "$n" = "$1" ] && return 0; done
	return 1
}

set_n=0 skip_n=0 fail_n=0
while IFS= read -r line; do
	[ -z "${line// }" ] && continue
	name="${line%% *}"
	ref="$(echo "${line#"$name"}" | sed 's/^[[:space:]]*//')"
	wanted "$name" || continue
	# Read once into a local var (in YOUR shell, never printed); empty = not in 1Password.
	val="$(op read "$ref" 2>/dev/null)" || true
	if [ -z "$val" ]; then
		printf '  skip  %-24s (not in 1Password: %s)\n' "$name" "$ref"
		skip_n=$((skip_n + 1)); continue
	fi
	if [ "$MODE" = "dry" ]; then
		printf '  ok    %-24s <- %s\n' "$name" "$ref"; continue
	fi
	if printf '%s' "$val" | npx wrangler secret put "$name" --config "$CONFIG" >/dev/null 2>&1; then
		printf '  set   %-24s\n' "$name"; set_n=$((set_n + 1))
	else
		printf '  FAIL  %-24s (wrangler error)\n' "$name"; fail_n=$((fail_n + 1))
	fi
done <<< "$MAP"

echo
echo "done: ${set_n} set · ${skip_n} not in 1Password · ${fail_n} failed"
[ "$MODE" = "dry" ] && echo "(dry run — nothing was written)"
echo "verify with: ./scripts/set-secrets.sh --list"
# Propagate per-secret failures so `&&` chains / CI stop instead of silently passing.
exit $(( fail_n > 0 ? 1 : 0 ))
