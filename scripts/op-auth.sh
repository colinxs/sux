#!/usr/bin/env bash
# op-auth.sh — shared 1Password auth preflight for the secret scripts.
#
# Two auth modes, auto-detected. `op read` transparently uses whichever is active,
# so callers don't change how they read — they just source this and call
# `op_preflight` up front to fail early with a legible message.
#
#   1. SERVICE ACCOUNT (headless — Teams/Business).  OP_SERVICE_ACCOUNT_TOKEN is
#      set. No desktop app, no biometric, no prompts. This is the CI / cron /
#      unattended path, and the only one that survives ephemeral shells.
#
#   2. DESKTOP INTEGRATION (interactive — any plan incl. Families).  No token; op
#      talks to the unlocked 1Password app and authorizes per caller via Touch ID.
#      Fine for a human at a terminal; prompts on every fresh process.
#
# The service account is bound to its own account+token, so in mode 1 we never
# pass --account. In mode 2 we honor $OP_ACCOUNT (e.g. your Teams shorthand) so a
# machine with several accounts signs into the right one.
#
# Source it:  . "$(dirname "$0")/op-auth.sh"   then:  op_preflight
set -uo pipefail

# op read/get/etc. get this appended automatically in interactive mode only.
op_account_args() {
  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then return 0; fi
  [ -n "${OP_ACCOUNT:-}" ] && printf -- '--account\n%s\n' "$OP_ACCOUNT"
}

op_mode() {
  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then echo "service-account"; else echo "desktop"; fi
}

# op_read <op://ref> — read one secret, account-scoped in interactive mode.
# In service-account mode the token pins the account, so no --account is passed.
op_read() {
  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || [ -z "${OP_ACCOUNT:-}" ]; then
    op read "$1"
  else
    op read --account "$OP_ACCOUNT" "$1"
  fi
}

op_preflight() {
  command -v op >/dev/null 2>&1 || {
    echo "✗ 1Password CLI not found — 'brew install 1password-cli'" >&2; return 1; }

  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
    # Headless: validate the token with a cheap read-only call. No prompt possible.
    if ! op whoami >/dev/null 2>&1; then
      echo "✗ OP_SERVICE_ACCOUNT_TOKEN is set but invalid/expired (op whoami failed)." >&2
      echo "  Rotate it in 1Password → Developer → Service Accounts, then re-export." >&2
      return 1
    fi
    echo "· op: service-account mode (headless, no prompts)" >&2
    return 0
  fi

  # Interactive: needs the unlocked app + CLI integration. May Touch-ID once here.
  # shellcheck disable=SC2046
  if ! op vault list $(op_account_args) >/dev/null 2>&1; then
    echo "✗ op not authorized. Either:" >&2
    echo "    • unlock the 1Password app + enable Settings → Developer → 'Integrate with 1Password CLI', or" >&2
    echo "    • export OP_SERVICE_ACCOUNT_TOKEN for headless use (Teams/Business)." >&2
    [ -n "${OP_ACCOUNT:-}" ] && echo "    (tried account: $OP_ACCOUNT)" >&2
    return 1
  fi
  echo "· op: desktop-integration mode (interactive — will prompt per process)" >&2
  return 0
}
