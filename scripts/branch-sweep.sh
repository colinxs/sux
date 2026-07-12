#!/usr/bin/env bash
# Report — and, with --prune, safely clean up — the backlog of local branches and
# workflow worktrees that accumulate from parallel Claude runs. Default is read-only:
# it classifies every branch against main so the branch pile becomes reasoned-about
# (git is the undo — but only if the undo-log is small enough to reason about).
#
# Deletion is gated behind an explicit --prune and uses `git branch -d`, which refuses
# any branch not fully merged into main. Superseded-but-reshaped and still-live branches
# are always kept and listed for a human to judge; this tool never force-deletes.
set -euo pipefail

PRUNE=0
BASE="main"
for arg in "$@"; do
  case "$arg" in
    --prune) PRUNE=1 ;;
    --base=*) BASE="${arg#--base=}" ;;
    -h|--help)
      echo "usage: scripts/branch-sweep.sh [--prune] [--base=main]"
      echo "  (no flags)  report-only: classify branches + worktrees, delete nothing"
      echo "  --prune     remove worktrees + delete branches fully merged into base"
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

git rev-parse --verify --quiet "$BASE" >/dev/null || { echo "base ref '$BASE' not found" >&2; exit 1; }

current="$(git symbolic-ref --quiet --short HEAD || echo)"

# Snapshot the worktree records once; look up on demand (bash 3.2 has no assoc arrays).
# A branch can't be deleted while checked out, so we remove its worktree first.
WT_PORCELAIN="$(git worktree list --porcelain)"

# Echo "<path>\t<locked?>" for the worktree that has BRANCH checked out, else nothing.
# Records are blank-line separated; `locked` follows `branch`, so emit at record end.
wt_lookup() {
  printf '%s\n' "$WT_PORCELAIN" | awk -v want="refs/heads/$1" '
    function flush() { if (br == want) print path "\t" locked }
    /^worktree /  { flush(); path = substr($0, 10); br = ""; locked = 0 }
    /^branch /    { br = substr($0, 8) }
    /^locked/     { locked = 1 }
    END           { flush() }
  '
}

merged=() superseded=() live=()
while IFS= read -r b; do
  [ "$b" = "$BASE" ] && continue
  [ "$b" = "$current" ] && continue
  if git merge-base --is-ancestor "$b" "$BASE"; then
    merged+=("$b")
  elif git diff --quiet "$BASE...$b"; then
    superseded+=("$b")            # added nothing new since forking from base
  else
    live+=("$b")
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

report_live() {
  local b counts
  for b in "${live[@]:-}"; do
    [ -z "$b" ] && continue
    counts="$(git rev-list --left-right --count "$BASE...$b")"   # <behind>\t<ahead>
    printf '  %-48s behind/ahead %s\n' "$b" "${counts//$'\t'/ / }"
  done
}

echo "== branch sweep (base: $BASE) =="
echo "merged into $BASE:      ${#merged[@]}   (safe to delete)"
echo "no net change vs $BASE: ${#superseded[@]}   (superseded — review)"
echo "live/unmerged:          ${#live[@]}   (kept — review)"
echo

if [ "${#live[@]}" -gt 0 ]; then
  echo "live branches (never auto-deleted):"
  report_live
  echo
fi
if [ "${#superseded[@]}" -gt 0 ]; then
  echo "superseded candidates (never auto-deleted — verify then delete by hand):"
  printf '  %s\n' "${superseded[@]}"
  echo
fi

if [ "$PRUNE" -ne 1 ]; then
  echo "report-only. re-run with --prune to remove worktrees + delete the ${#merged[@]} merged branch(es)."
  exit 0
fi

echo "pruning ${#merged[@]} merged branch(es)…"
for b in "${merged[@]:-}"; do
  [ -z "$b" ] && continue
  entry="$(wt_lookup "$b")"
  wt="${entry%%$'\t'*}"
  locked="${entry##*$'\t'}"
  if [ -n "$wt" ]; then
    if [ "$locked" = "1" ]; then
      echo "  skip $b — worktree locked ($wt)"
      continue
    fi
    git worktree remove "$wt" 2>/dev/null || { echo "  skip $b — worktree busy ($wt)"; continue; }
  fi
  git branch -d "$b" >/dev/null && echo "  deleted $b"
done
git worktree prune
echo "done. superseded/live branches were left untouched."
