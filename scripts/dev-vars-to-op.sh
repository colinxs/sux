#!/usr/bin/env bash
# dev-vars-to-op.sh — seed op://Secrets/NAME/credential from sux/.dev.vars
# (the gitignored local KEY=VALUE file `wrangler dev` reads for runtime secrets).
#
# WHY: .dev.vars is the only readable copy of a few values (Tailscale OAuth client,
# Dropbox-full app) that were never put in op. Unlike Worker/GitHub secrets, this
# file IS readable — it's a local file, not a write-only store — so this is a plain
# read-and-store, not a salvage trick.
#
# Values flow file -> op through a shell var, never printed or logged.
#
# Usage:
#   scripts/dev-vars-to-op.sh                # dry run: show what would be written
#   scripts/dev-vars-to-op.sh --apply         # write missing values into op
#   scripts/dev-vars-to-op.sh --apply --clear # also blank the migrated lines in .dev.vars
#
# --clear removes ONLY the lines that were just confirmed written to op (verified with
# `op read` before touching the file). wrangler dev needs .dev.vars to still exist for
# local runs, so --clear blanks values in place (KEY=) rather than deleting the file or
# the keys — re-populate a line by hand if you need that value for local dev again.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
. scripts/op-auth.sh

DEV_VARS="sux/.dev.vars"
VAULT="Secrets"
APPLY=false
CLEAR=false
for a in "$@"; do case "$a" in
  --apply) APPLY=true ;;
  --clear) CLEAR=true ;;
  *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done

[ -f "$DEV_VARS" ] || { echo "✗ $DEV_VARS not found" >&2; exit 1; }

# Settings, not secrets (per docs/secrets.md tier-2) — never pushed to op.
SKIP_NAMES="TAILSCALE_TAILNET"

op_preflight || exit 1

echo "Migrating $DEV_VARS -> op://$VAULT (apply=$APPLY clear=$CLEAR)"
echo
wrote=0 skip_have=0 skip_setting=0 fail=0
confirmed_names=""   # names verified present in op — safe to clear locally, whether from this run or a prior one

while IFS='=' read -r name val; do
  [ -z "${name// }" ] && continue
  case "$name" in \#*) continue ;; esac
  [ -z "${val:-}" ] && continue

  case " $SKIP_NAMES " in *" $name "*)
    printf '  skip  %-28s (setting, not a secret — belongs in [vars])\n' "$name"
    skip_setting=$((skip_setting+1)); continue ;;
  esac

  if op_read "op://$VAULT/$name/credential" >/dev/null 2>&1; then
    printf '  have  %-28s (already in op — not overwriting)\n' "$name"
    skip_have=$((skip_have+1))
    confirmed_names="$confirmed_names $name"
    continue
  fi

  if ! $APPLY; then
    printf '  WOULD write  %-28s -> op://%s/%s/credential\n' "$name" "$VAULT" "$name"
    wrote=$((wrote+1)); continue
  fi

  if err="$(op item create --vault "$VAULT" --category "API Credential" --title "$name" "credential=$val" 2>&1 >/dev/null)"; then
    echo "  wrote  $name"
    wrote=$((wrote+1))
    confirmed_names="$confirmed_names $name"
  else
    echo "  FAIL   $name :: $err"
    fail=$((fail+1))
  fi
  unset val
done < "$DEV_VARS"

echo
echo "summary: ${wrote} written/would-write · ${skip_have} already in op · ${skip_setting} settings skipped · ${fail} failed"
$APPLY || echo "(dry run — nothing written; re-run with --apply)"

if $APPLY && $CLEAR && [ -n "$confirmed_names" ]; then
  echo
  for name in $confirmed_names; do
    if op_read "op://$VAULT/$name/credential" >/dev/null 2>&1; then
      sed -i '' "s|^${name}=.*|${name}=|" "$DEV_VARS"
      echo "  cleared  $name  (blanked in $DEV_VARS — value lives in op://$VAULT/$name/credential)"
    else
      echo "  ✗ not clearing $name — could not verify it in op"
    fi
  done
fi

exit $(( fail > 0 ? 1 : 0 ))
