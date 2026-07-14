#!/usr/bin/env python3
#
# mint-monarch-token.py — log into Monarch once and stash the API token in 1Password.
#
# WHY a script: Monarch has no "create API token" UI, and the web app authenticates
# over an httpOnly session cookie + CSRF — there is NO bearer token to copy from
# devtools. The only way to obtain the `Authorization: Token` value the `monarch`
# fn needs is the mobile/REST login, which the `monarchmoney` lib performs.
#
# WHY the fork: upstream `hammem/monarchmoney` 405s — its login is missing headers
# Monarch now requires (Origin, device-uuid, x-cio-*). Use the maintained fork:
#   pip3 install --user git+https://github.com/keithah/monarchmoney-enhanced
#
# WHY pipe into op: the token never touches the terminal/scrollback — it flows
# login -> 1Password item, and set-secrets.sh later reads it back into the Worker
# with `op read | wrangler`. Nothing secret is ever printed.
#
# RATE LIMIT: Monarch throttles login by IP (429). Repeated tries extend the block.
# If you hit 429, egress over IPv6 (a separate bucket) or wait ~20 min, then run ONCE.
#
# USAGE (1Password app unlocked, CLI integration on):
#   pip3 install --user git+https://github.com/keithah/monarchmoney-enhanced
#   python3 scripts/mint-monarch-token.py
#   ./scripts/set-secrets.sh MONARCH_TOKEN
#
import asyncio
import subprocess
import sys

OP_VAULT = "Private"
OP_ITEM = "Monarch sux"
OP_FIELD = "token"


def stash_in_1password(token: str) -> None:
    """Write the token into 1Password without ever printing it. Edit if the item
    exists, else create it. The value passes as an op arg, not through the shell."""
    assign = f"{OP_FIELD}={token}"
    edit = subprocess.run(
        ["op", "item", "edit", OP_ITEM, assign, "--vault", OP_VAULT],
        capture_output=True,
        text=True,
    )
    if edit.returncode == 0:
        print(f"✓ updated 1Password item '{OP_ITEM}' field '{OP_FIELD}'")
        return
    create = subprocess.run(
        ["op", "item", "create", "--category", "API Credential",
         "--title", OP_ITEM, "--vault", OP_VAULT, assign],
        capture_output=True,
        text=True,
    )
    if create.returncode == 0:
        print(f"✓ created 1Password item '{OP_ITEM}' with field '{OP_FIELD}'")
        return
    sys.exit(
        "Failed to write to 1Password. Unlock the app and enable Settings > "
        f"Developer > Integrate with 1Password CLI.\nop said: {edit.stderr.strip()} "
        f"/ {create.stderr.strip()}"
    )


async def main() -> None:
    try:
        from monarchmoney import MonarchMoney
    except ImportError:
        sys.exit(
            "monarchmoney not installed. Run:\n  pip3 install --user "
            "git+https://github.com/keithah/monarchmoney-enhanced"
        )

    mm = MonarchMoney(use_encryption=False)
    # Prompts Email, Password, and a Two-Factor code if MFA is on.
    await mm.interactive_login(use_saved_session=False, save_session=False)
    if not mm.token:
        sys.exit("Login returned no token.")
    stash_in_1password(mm.token)
    print("Now run:  ./scripts/set-secrets.sh MONARCH_TOKEN")


if __name__ == "__main__":
    asyncio.run(main())
