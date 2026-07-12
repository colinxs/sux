#!/bin/sh
# Shared regen+stage step for the post-merge / post-rewrite hooks.
# Not a hook name itself, so core.hooksPath never dispatches it directly.
#
# After a merge/rebase, the merge=ours driver (see .gitattributes) kept one
# side of sux/src/fns/index.ts verbatim rather than conflicting. Rebuild it for
# real now that the worktree is reconciled, and stage the corrected content so
# you can fold it into a commit/amend before pushing (CI gates on index.ts
# being in sync). It's the only committed generated file left — FUNCTIONS.md
# and llms.txt are gitignored and regenerated on demand; the hybrid wiki MOCs
# are refreshed by `npm run wiki`, not here.
root="$(git rev-parse --show-toplevel)" || exit 0
cd "$root" || exit 0
command -v npm >/dev/null 2>&1 || exit 0
npm run gen:index --silent >/dev/null 2>&1
git add -- sux/src/fns/index.ts >/dev/null 2>&1 || true
