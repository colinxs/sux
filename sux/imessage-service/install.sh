#!/bin/sh
# Install/reinstall com.sux.imessage as a launchd agent for THIS checkout — the
# plist's ProgramArguments must be an absolute path (launchd does no variable
# expansion, no relative resolution, no $HOME), so it can't be committed as-is
# without hardcoding one machine's checkout location. This stamps the real path
# in at install time instead.
#
# A launchctl load pointed at a plist that isn't in ~/Library/LaunchAgents/, or
# whose ProgramArguments path doesn't exist, fails with the unhelpful
# "Load failed: 5: Input/output error" — this script exists so that failure
# mode doesn't recur.
set -eu
cd "$(dirname "$0")"
HERE="$(pwd)"
DEST="$HOME/Library/LaunchAgents/com.sux.imessage.plist"

sed "s#__RUN_SH_PATH__#$HERE/run.sh#" com.sux.imessage.plist > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl unload -w "$DEST" 2>/dev/null || true
launchctl load -w "$DEST"

echo "installed: $DEST -> $HERE/run.sh"
echo "next: create ~/.sux-imessage.secret (openssl rand -hex 32 > ~/.sux-imessage.secret && chmod 600 ~/.sux-imessage.secret) if absent,"
echo "      grant Full Disk Access to the process reading chat.db, then check /tmp/sux-imessage.err"
