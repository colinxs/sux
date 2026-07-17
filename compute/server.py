"""Status server for the sux-compute box.

GET /       -> JSON status: identity, uptime, dockerd state, docker ps.
GET /health -> 200 "ok" (cheap liveness for the Container class port check).

Deliberately no mutation endpoints: arbitrary docker use goes through
`wrangler containers ssh` or the Worker-side ctx.container.exec(), both of
which authenticate against the Cloudflare account.
"""

import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

BOOT = time.time()


def sh(cmd, timeout=5):
    try:
        out = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return {"code": out.returncode, "out": out.stdout.strip()[:2000], "err": out.stderr.strip()[:500]}
    except Exception as e:  # noqa: BLE001 - report, never crash the status server
        return {"code": -1, "out": "", "err": str(e)[:500]}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        status = {
            "box": "sux-compute",
            "deployment_id": os.environ.get("CLOUDFLARE_DEPLOYMENT_ID", "unknown"),
            "uptime_s": int(time.time() - BOOT),
            "docker_sock": os.path.exists("/var/run/docker.sock"),
            "docker_version": sh("docker version --format '{{.Server.Version}}'"),
            "docker_ps": sh("docker ps --format '{{.Names}} {{.Image}} {{.Status}}'"),
            "path": self.path,
        }
        body = json.dumps(status, indent=1).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep container logs quiet
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
