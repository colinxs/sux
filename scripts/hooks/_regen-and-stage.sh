#!/bin/sh
# Shared regen+stage step for the post-merge / post-rewrite hooks.
# Not a hook name itself, so core.hooksPath never dispatches it directly.
#
# After a merge/rebase, the merge=ours driver (see .gitattributes) kept one
# side of the fully-generated files verbatim rather than conflicting. Rebuild
# them for real now that the worktree is reconciled, and stage the corrected
# content so you can fold it into a commit/amend before pushing (CI gates on
# these being in sync).
root="$(git rev-parse --show-toplevel)" || exit 0
cd "$root" || exit 0
command -v npm >/dev/null 2>&1 || exit 0
npm run gen:index --silent >/dev/null 2>&1
npm run docs --silent >/dev/null 2>&1
npm run wiki --silent >/dev/null 2>&1
git add -- \
  sux/src/fns/index.ts \
  sux/FUNCTIONS.md \
  llms.txt \
  docs/wiki/MOCs/Functions-MOC.md \
  docs/wiki/MOCs/Status-Dashboard.md >/dev/null 2>&1 || true
