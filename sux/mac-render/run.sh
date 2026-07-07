#!/bin/sh
# Launch the residential render service, kept awake by caffeinate. launchd
# (com.sux.render) runs this at load and restarts it if it dies.
export PATH="$HOME/Library/Python/3.9/bin:$PATH"
export RENDER_SECRET=$(cat "$HOME/.sux-render.secret")
export PORT=8790
export CONCURRENCY=4
cd "$(dirname "$0")"
exec caffeinate -s /usr/bin/python3 render_server.py
