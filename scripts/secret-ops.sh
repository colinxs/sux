#!/usr/bin/env bash
# secret-ops — one entry point for the op -> Worker/GitHub secret lifecycle:
# audit what is missing WHERE, create/capture a value into op, rename a
# mistitled item, and push one or all of them out to the stores.
#
# Why this exists alongside secret-check.sh: that script diffs the Worker and
# GitHub name lists against a manifest, but never looks at 1Password. It
# therefore reads all-green for a secret that is live on the Worker and ABSENT
# from op — which, because both stores are write-only, means the value is
# unrecoverable and nobody finds out until a rotation. `audit` here closes that
# gap by making op the third leg of the diff.
#
# Values are read from op straight into a pipe and are never printed, logged,
# or written to disk.
#
# Usage:
#   scripts/secret-ops.sh audit [--all]
#   scripts/secret-ops.sh backfill                       # walk every store secret missing from op
#   scripts/secret-ops.sh create NAME [--generate] [--worker] [--github]
#   scripts/secret-ops.sh capture NAME [--worker] [--github]
#   scripts/secret-ops.sh rename OLD NEW
#   scripts/secret-ops.sh sync NAME [--worker] [--github]
#   scripts/secret-ops.sh sync-all [--worker] [--github] [--apply]
#
# `sync-all` is DRY-RUN unless --apply: pushing op over a live Worker secret is
# destructive when op holds the older value, so the blast radius is opt-in.
set -euo pipefail
cd "$(dirname "$0")/.."
. "scripts/op-auth.sh"

CHECK="scripts/secret-check.sh"
VAULT="${OP_VAULT:-Secrets}"

manifest() { # $1 var name in secret-check.sh
  sed -n "s/^$1=\"\(.*\)\"\$/\1/p;/^$1=\"/,/\"\$/p" "$CHECK" |
    sed "s/^$1=\"//; s/\"\$//; s/\\\\\$//" | tr ' ' '\n' | grep -E '^[A-Z][A-Z0-9_]*$' || true
}

# --vault is REQUIRED, not cosmetic: under a service-account token (how this runs
# unattended) `op item list` without it errors or returns a different set than the
# vault-scoped call, so a vault-less listing silently under-reports and every missing
# title then reads as "unrecoverable". Always scope the query.
op_titles() { op item list --vault "$VAULT" --format json | python3 -c 'import sys,json;[print(i["title"]) for i in json.load(sys.stdin)]'; }

# op items are not uniformly one-secret-per-item with a `credential` field: some are
# multi-field (e.g. 'Epic FHIR sux - PROD' carries client_id_prod, client_secret_sandbox,
# client_secret_productioin, ... in one item). A title-only diff therefore reports a
# secret as missing when its value is really a named field inside another item. Emit
# `title<TAB>field` for every populated non-boilerplate field so the audit can see them.
op_fields() {
  op item list --vault "$VAULT" --format json |
    python3 -c 'import sys,json;[print(i["id"]) for i in json.load(sys.stdin)]' |
    while read -r id; do
      op item get "$id" --vault "$VAULT" --format json 2>/dev/null | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
t = d.get("title", "")
for f in d.get("fields", []):
    if f.get("value") is None: continue
    lab = f.get("label") or f.get("id") or ""
    if lab in ("notesPlain",): continue
    print(f"{t}\t{lab}")
'
    done
}

worker_names() {
  npx wrangler secret list --config sux/wrangler.jsonc 2>/dev/null |
    python3 -c 'import sys,json;[print(x["name"]) for x in json.load(sys.stdin)]' 2>/dev/null || true
}

github_names() { gh secret list 2>/dev/null | awk '{print $1}' || true; }

has() { printf '%s\n' "$2" | grep -qx "$1"; }

# Does `$1` exist in op as either a top-level item title or a named field inside one?
# Compared case-insensitively with -/_ folded, since op titles use both.
in_op() { # $1 name  $2 titles  $3 fields(title<TAB>label)
  local n; n="$(printf '%s' "$1" | tr 'A-Z-' 'a-z_')"
  printf '%s\n' "$2" | tr 'A-Z-' 'a-z_' | grep -qx "$n" && return 0
  printf '%s\n' "$3" | cut -f2 | tr 'A-Z-' 'a-z_' | grep -qx "$n"
}

# Where a name lives, for reporting. Empty when absent.
where_in_op() {
  local n; n="$(printf '%s' "$1" | tr 'A-Z-' 'a-z_')"
  printf '%s\n' "$2" | grep -ix -m1 -- "$(printf '%s' "$1" | tr '_' '-')" 2>/dev/null && return 0
  printf '%s\n' "$3" | awk -F'\t' -v n="$n" 'tolower($2) ~ /./ {l=tolower($2); gsub(/-/,"_",l); if (l==n) {print "field \x27" $2 "\x27 in \x27" $1 "\x27"; exit}}'
}

cmd_audit() {
  op_preflight || exit 1
  local titles worker github fields show_optional=false
  [ "${1:-}" = "--all" ] && show_optional=true
  titles="$(op_titles)"; worker="$(worker_names)"; github="$(github_names)"; fields="$(op_fields)"

  # A secret live on a write-only store but absent from op is the one state that
  # cannot be repaired later — surface it first and loudest.
  echo "== unrecoverable (on a store, NOT in op) =="
  local n=0
  for k in $(printf '%s\n' "$worker" | grep -E '^[A-Z]' || true); do
    in_op "$k" "$titles" "$fields" || { echo "  ✗ Worker  $k"; n=$((n + 1)); }
  done
  for k in $(printf '%s\n' "$github" | grep -E '^[A-Z]' || true); do
    in_op "$k" "$titles" "$fields" || { echo "  ✗ GitHub  $k"; n=$((n + 1)); }
  done
  [ "$n" -eq 0 ] && echo "  ✓ none"
  echo "  ($n value(s) exist only in a store Cloudflare/GitHub will never read back)"
  echo

  echo "== in op but never pushed =="
  local m=0
  for t in $titles; do
    case "$t" in
      [A-Z]*) has "$t" "$worker" || has "$t" "$github" || { echo "  · $t"; m=$((m + 1)); } ;;
    esac
  done
  [ "$m" -eq 0 ] && echo "  ✓ none"
  echo

  echo "== manifest names with no exact op item =="
  local sets="WORKER_REQUIRED GITHUB_REQUIRED"
  $show_optional && sets="$sets WORKER_OPTIONAL"
  for set in $sets; do
    echo "  -- $set --"
    for k in $(manifest "$set"); do
      in_op "$k" "$titles" "$fields" && continue
      # A near-miss title is a silent sync-all skip, not a missing secret.
      local near
      near="$(printf '%s\n' "$titles" | grep -i -- "$k" | head -1 || true)"
      if [ -n "$near" ]; then echo "    ~ $k  ->  '$near'  (rename to fix)"; else echo "    ✗ $k"; fi
    done
  done
  echo
  echo "(names only — no values printed)"
}

push() { # $1 name  $2 to_worker  $3 to_github
  local name="$1" val
  val="$(op_read "op://$VAULT/$name/credential" 2>/dev/null)" ||
    { echo "✗ $name: not readable at op://$VAULT/$name/credential" >&2; return 1; }
  [ -n "$val" ] || { echo "✗ $name: empty value in op" >&2; return 1; }
  if [ "$2" = true ]; then
    printf '%s' "$val" | npx wrangler secret put "$name" --config sux/wrangler.jsonc >/dev/null
    echo "✓ Worker  $name"
  fi
  if [ "$3" = true ]; then
    printf '%s' "$val" | gh secret set "$name"
    echo "✓ GitHub  $name"
  fi
  unset val
}

parse_targets() { # sets TO_WORKER/TO_GITHUB from remaining args
  TO_WORKER=false; TO_GITHUB=false; GENERATE=false; APPLY=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --worker) TO_WORKER=true ;;
      --github) TO_GITHUB=true ;;
      --generate) GENERATE=true ;;
      --apply) APPLY=true ;;
      --all) : ;;
      *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
  done
}

cmd_create() {
  local name="${1:?usage: create NAME [--generate] [--worker] [--github]}"; shift
  parse_targets "$@"
  op_preflight || exit 1
  if $GENERATE; then
    op item create --vault "$VAULT" --category "API Credential" --title "$name" \
      "credential=$(openssl rand -base64 32)" >/dev/null
    echo "✓ op       $name  (generated)"
  else
    cmd_capture_value "$name"
  fi
  { $TO_WORKER || $TO_GITHUB; } && push "$name" "$TO_WORKER" "$TO_GITHUB"
}

cmd_capture_value() { # prompt without echo; never lands in shell history
  local name="$1" v
  printf 'paste value for %s (input hidden): ' "$name" >&2
  read -rs v; echo >&2
  [ -n "$v" ] || { echo "✗ empty, aborting" >&2; exit 1; }
  op item create --vault "$VAULT" --category "API Credential" --title "$name" "credential=$v" >/dev/null
  unset v
  echo "✓ op       $name"
}

cmd_capture() {
  local name="${1:?usage: capture NAME [--worker] [--github]}"; shift
  parse_targets "$@"
  op_preflight || exit 1
  cmd_capture_value "$name"
  { $TO_WORKER || $TO_GITHUB; } && push "$name" "$TO_WORKER" "$TO_GITHUB"
}

cmd_rename() {
  local old="${1:?usage: rename OLD NEW}" new="${2:?usage: rename OLD NEW}"
  op_preflight || exit 1
  op item edit "$old" --vault "$VAULT" --title "$new" >/dev/null
  echo "✓ op       '$old' -> '$new'"
}

cmd_sync() {
  local name="${1:?usage: sync NAME [--worker] [--github]}"; shift
  parse_targets "$@"
  { $TO_WORKER || $TO_GITHUB; } || { echo "specify --worker and/or --github" >&2; exit 2; }
  op_preflight || exit 1
  push "$name" "$TO_WORKER" "$TO_GITHUB"
}

cmd_sync_all() {
  parse_targets "$@"
  { $TO_WORKER || $TO_GITHUB; } || { echo "specify --worker and/or --github" >&2; exit 2; }
  op_preflight || exit 1
  local titles; titles="$(op_titles)"
  $APPLY || echo "DRY RUN — re-run with --apply to actually push"
  for t in $titles; do
    case "$t" in
      [A-Z]*) ;;
      *) continue ;;
    esac
    if $APPLY; then push "$t" "$TO_WORKER" "$TO_GITHUB" || true; else echo "  would push  $t"; fi
  done
}

# Walk everything live on a store but missing from op, in one pass. There is no bulk
# import: Cloudflare and GitHub never return a secret's value, so each one has to come
# from its original source (a vendor console, a local .dev.vars) or be rotated. This just
# removes the per-secret ceremony — it does NOT make the values recoverable.
#
# `sux/.dev.vars` is checked first because wrangler dev reads it, so any secret used
# locally already has a plaintext copy there — those import with no prompting at all.
# Everything else is offered one at a time; ENTER skips, so a pass can be abandoned
# partway without losing the ones already stored.
#
# Nothing is pushed to any store here. Backfilling means teaching op a value the Worker
# ALREADY has — pushing would overwrite a live secret with whatever was just typed, which
# is exactly the destructive direction sync-all's --apply gate exists to prevent.
cmd_backfill() {
  op_preflight || exit 1
  local titles worker github fields missing=""
  titles="$(op_titles)"; worker="$(worker_names)"; github="$(github_names)"; fields="$(op_fields)"
  for k in $(printf '%s\n%s\n' "$worker" "$github" | grep -E '^[A-Z]' | sort -u); do
    in_op "$k" "$titles" "$fields" || missing="$missing $k"
  done
  [ -n "$missing" ] || { echo "✓ nothing to backfill — every store secret has an op item"; return 0; }

  local devvars="sux/.dev.vars" imported=0 stored=0 skipped=0
  for k in $missing; do
    local v=""
    if [ -f "$devvars" ]; then
      # Take the value verbatim after the first '=', minus one layer of matching quotes.
      v="$(sed -n "s/^$k=//p" "$devvars" | head -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/')"
    fi
    if [ -n "$v" ]; then
      op item create --vault "$VAULT" --category "API Credential" --title "$k" "credential=$v" >/dev/null
      unset v
      echo "✓ op       $k  (from $devvars)"
      imported=$((imported + 1))
      continue
    fi
    printf '%s — paste value (ENTER to skip): ' "$k" >&2
    read -rs v; echo >&2
    if [ -z "$v" ]; then skipped=$((skipped + 1)); continue; fi
    op item create --vault "$VAULT" --category "API Credential" --title "$k" "credential=$v" >/dev/null
    unset v
    echo "✓ op       $k"
    stored=$((stored + 1))
  done
  echo
  echo "imported from $devvars: $imported   entered by hand: $stored   skipped: $skipped"
  [ "$skipped" -gt 0 ] && echo "(skipped ones stay unrecoverable — re-issue from the vendor console or rotate)"
  echo "Nothing was pushed to a store; op now matches what you supplied."
}

case "${1:-}" in
  audit) shift; cmd_audit "$@" ;;
  backfill) shift; cmd_backfill "$@" ;;
  create) shift; cmd_create "$@" ;;
  capture) shift; cmd_capture "$@" ;;
  rename) shift; cmd_rename "$@" ;;
  sync) shift; cmd_sync "$@" ;;
  sync-all) shift; cmd_sync_all "$@" ;;
  *) sed -n '17,27p' "$0" >&2; exit 2 ;;
esac
