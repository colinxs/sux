#!/usr/bin/env bash
# Mount this PUBLIC repo's docs/ into the PRIVATE Obsidian vault as a gitignored
# symlink, so the sux design docs show up in Colin's daily-driver vault with one
# unified graph (backlinks + search across both corpora) — same inodes, zero copy.
#
# Direction is load-bearing: public docs/ → private vault (safe), NEVER the reverse
# (that would risk committing personal notes into this public repo). See
# docs/design/vault-docs-reconciliation.md (Phase 1). This is a local-only step
# Colin runs once on his Mac; it no-ops in CI and is idempotent (safe to re-run).
set -euo pipefail

# No-op in CI: this only makes sense against a real local Obsidian vault.
if [ -n "${CI:-}" ]; then
  echo "mount-docs-in-obsidian: CI detected — nothing to mount, skipping."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/docs"

# The private Obsidian vault repo (colinxs/obsidian-vault). Override with VAULT_DIR.
VAULT_DIR="${VAULT_DIR:-$HOME/obsidian-vault}"
MOUNT_NAME="${MOUNT_NAME:-sux}"
MOUNT_LINK="$VAULT_DIR/$MOUNT_NAME"

if [ ! -d "$DOCS_DIR" ]; then
  echo "mount-docs-in-obsidian: docs/ not found at $DOCS_DIR" >&2
  exit 1
fi
if [ ! -d "$VAULT_DIR" ]; then
  echo "mount-docs-in-obsidian: vault repo not found at $VAULT_DIR" >&2
  echo "  set VAULT_DIR=/path/to/obsidian-vault and re-run." >&2
  exit 1
fi

# Idempotent symlink: leave a correct link alone, refuse to clobber a real dir/file.
if [ -L "$MOUNT_LINK" ]; then
  if [ "$(readlink "$MOUNT_LINK")" = "$DOCS_DIR" ]; then
    echo "mount-docs-in-obsidian: symlink already correct → $MOUNT_LINK"
  else
    ln -sfn "$DOCS_DIR" "$MOUNT_LINK"
    echo "mount-docs-in-obsidian: repointed symlink → $MOUNT_LINK → $DOCS_DIR"
  fi
elif [ -e "$MOUNT_LINK" ]; then
  echo "mount-docs-in-obsidian: $MOUNT_LINK exists and is not a symlink — refusing to overwrite." >&2
  exit 1
else
  ln -s "$DOCS_DIR" "$MOUNT_LINK"
  echo "mount-docs-in-obsidian: created symlink → $MOUNT_LINK → $DOCS_DIR"
fi

# Keep obsidian-git from ever committing the mount into the PRIVATE vault repo.
VAULT_IGNORE="$VAULT_DIR/.gitignore"
IGNORE_LINE="$MOUNT_NAME/"
if [ -f "$VAULT_IGNORE" ] && grep -qxF "$IGNORE_LINE" "$VAULT_IGNORE"; then
  echo "mount-docs-in-obsidian: '$IGNORE_LINE' already in $VAULT_IGNORE"
else
  printf '%s\n' "$IGNORE_LINE" >> "$VAULT_IGNORE"
  echo "mount-docs-in-obsidian: appended '$IGNORE_LINE' to $VAULT_IGNORE"
fi

echo "mount-docs-in-obsidian: done. Open the vault in Obsidian to see the unified graph."
