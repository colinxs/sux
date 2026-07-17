#!/bin/sh
# Boot dockerd (dind) in the background, then run the status server as PID-1's
# foreground child. If dockerd fails, the status server still comes up and
# reports the failure — the box stays reachable for debugging via SSH/exec.
(dockerd-entrypoint.sh >/var/log/dockerd.log 2>&1 &)
exec python3 /srv/server.py
