#!/usr/bin/env bash
# secret-sync — 1Password is the source of truth; push a secret from op to the
# Cloudflare Worker and/or GitHub Actions stores. BOTH of those stores are
# WRITE-ONLY (no `wrangler secret get`, no `gh secret get`), so op is the only
# place a value can ever be read back from — hence op-first, always.
#
# The value flows op -> store through a pipe and is NEVER printed or written to disk.
#
# Usage:
#   scripts/secret-sync.sh NAME --worker                 # op://Secrets/NAME/credential -> Worker
#   scripts/secret-sync.sh NAME --github                 # -> GitHub Actions
#   scripts/secret-sync.sh NAME --worker --github        # -> both
#   scripts/secret-sync.sh NAME --worker --op op://Secrets/Some Item/credential
#
# Prereqs: `op` signed in (biometric ok), `wrangler` authed with Workers:edit,
# `gh` authed. See docs/secrets.md for which secret belongs in which store.
set -euo pipefail
. "$(dirname "$0")/op-auth.sh"

NAME="${1:?usage: secret-sync.sh NAME [--worker] [--github] [--op op://Vault/Item/field]}"
shift || true

OP_REF=""
TO_WORKER=false
TO_GITHUB=false
while [ $# -gt 0 ]; do
  case "$1" in
    --worker) TO_WORKER=true ;;
    --github) TO_GITHUB=true ;;
    --op)     OP_REF="${2:?--op needs an op:// reference}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if ! $TO_WORKER && ! $TO_GITHUB; then
  echo "specify at least one of --worker / --github" >&2; exit 2
fi

OP_REF="${OP_REF:-op://Secrets/$NAME/credential}"

op_preflight || exit 1

# Read once into a shell var (never echoed). Fail loudly on empty/missing.
if ! val="$(op_read "$OP_REF" 2>/dev/null)"; then
  echo "✗ could not read $OP_REF from 1Password (is the item there? is op signed in?)" >&2; exit 1
fi
[ -n "$val" ] || { echo "✗ empty value at $OP_REF" >&2; exit 1; }

if $TO_WORKER; then
  printf '%s' "$val" | npx wrangler secret put "$NAME" --config sux/wrangler.jsonc >/dev/null
  echo "✓ Worker  $NAME  (from $OP_REF)"
fi
if $TO_GITHUB; then
  printf '%s' "$val" | gh secret set "$NAME"
  echo "✓ GitHub  $NAME  (from $OP_REF)"
fi
unset val
