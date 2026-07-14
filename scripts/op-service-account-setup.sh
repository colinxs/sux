#!/usr/bin/env bash
# op-service-account-setup.sh — mint the headless 1Password service account that
# lets CI / cron / agents read secrets with ZERO biometric prompts.
#
# Requires: a 1Password Teams/Business account (service accounts do NOT exist on
# Individual/Families) and that you are signed into it as an owner/admin in the
# desktop app with CLI integration on.
#
# What it does: creates a service account with READ-ONLY access to ONE vault (the
# secrets vault), prints the token ONCE, and reminds you where to stash it. The
# token is a master key to that vault — it is shown exactly once and never again.
#
# Usage:
#   OP_ACCOUNT=<team-shorthand> scripts/op-service-account-setup.sh [VAULT] [SA_NAME]
#     VAULT    default: Secrets
#     SA_NAME  default: sux-ci
#
# After it prints the token:
#   1. Store the token itself in 1Password (a new item, e.g. "sux-ci SA token").
#   2. Put it where each headless consumer reads it:
#        • GitHub Actions:  gh secret set OP_SERVICE_ACCOUNT_TOKEN
#        • local shell:     export OP_SERVICE_ACCOUNT_TOKEN=... in ~/.zshenv
#      (~/.zshenv, not ~/.zshrc — hook/MCP-spawned non-interactive shells read it.)
#   3. Verify headless:  env -i OP_SERVICE_ACCOUNT_TOKEN=... op whoami
set -uo pipefail

VAULT="${1:-Secrets}"
SA_NAME="${2:-sux-ci}"
ACC_ARGS=()
[ -n "${OP_ACCOUNT:-}" ] && ACC_ARGS=(--account "$OP_ACCOUNT")

command -v op >/dev/null 2>&1 || { echo "✗ 1Password CLI not found" >&2; exit 1; }

if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  echo "✗ OP_SERVICE_ACCOUNT_TOKEN is already set in this shell — a service account" >&2
  echo "  cannot create another service account. Run this in a shell signed in as a" >&2
  echo "  human admin (unset the token first)." >&2
  exit 1
fi

echo "· checking admin sign-in…"
op whoami "${ACC_ARGS[@]}" >/dev/null 2>&1 || {
  echo "✗ not signed in. Unlock the Teams account in the 1Password app + enable" >&2
  echo "  Settings → Developer → 'Integrate with 1Password CLI', then pass" >&2
  echo "  OP_ACCOUNT=<team-shorthand> to this script." >&2
  exit 1
}

echo "· confirming vault '$VAULT' exists…"
if ! op vault get "$VAULT" "${ACC_ARGS[@]}" >/dev/null 2>&1; then
  echo "✗ vault '$VAULT' not found in this account. Create it first:" >&2
  echo "    op vault create '$VAULT' ${ACC_ARGS[*]}" >&2
  echo "  (Keep the secrets vault SEPARATE from personal/human vaults.)" >&2
  exit 1
fi

cat <<EOF

About to create a READ-ONLY service account:
  name   : $SA_NAME
  vault  : $VAULT (read_items only)
  account: ${OP_ACCOUNT:-<default>}

The token prints ONCE. Have somewhere ready to paste it.
EOF
printf "Proceed? [y/N] "; read -r ans
case "$ans" in y|Y|yes) ;; *) echo "aborted."; exit 0 ;; esac

op service-account create "$SA_NAME" \
  --vault "$VAULT:read_items" \
  --expires-in 90d \
  "${ACC_ARGS[@]}"

cat <<'EOF'

^ That token string is OP_SERVICE_ACCOUNT_TOKEN. Next steps:
  • Stash it in 1Password (human vault) so you can rotate/find it later.
  • gh secret set OP_SERVICE_ACCOUNT_TOKEN   (for CI)
  • add to ~/.zshenv: export OP_SERVICE_ACCOUNT_TOKEN=ops_...   (for local + hooks)
  • it EXPIRES in 90d — re-run this to rotate before then.
Then re-run any secret script; it will report "service-account mode (headless)".
EOF
