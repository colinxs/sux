// GitHub OAuth via the *device authorization* flow.
//
// The web (authorization-code) flow requires GitHub to redirect back to a
// registered callback URL, so a single OAuth App can serve exactly one host —
// localhost OR the deployed Worker, not both. Device flow has no redirect_uri at
// all: we ask GitHub for a short user code, the user enters it at
// github.com/login/device, and we poll GitHub for the token. The same GitHub
// OAuth App then works for local dev and production alike (just tick
// "Enable Device Flow" in the app settings).
//
// This handler still terminates Claude's OAuth: once GitHub authorizes the
// device, we call completeAuthorization() to mint the token Claude gets back.

import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import type { Props } from "./utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "read:user";
const KV_PREFIX = "device:";

type PendingAuth = {
	oauthReqInfo: AuthRequest;
	deviceCode: string;
	interval: number;
};

/**
 * GET /authorize — entry point for Claude's OAuth flow.
 *
 * We start a GitHub device authorization, stash the request under a random poll
 * key, and render a page that shows the user code and polls for completion.
 */
app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	if (!oauthReqInfo.clientId) {
		return c.text("Invalid request", 400);
	}

	const resp = await fetch(GITHUB_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, scope: SCOPE }).toString(),
	});
	if (!resp.ok) {
		console.error(`device/code failed: HTTP ${resp.status}`, await resp.text());
		return c.text(
			"Failed to start GitHub device authorization. Is 'Enable Device Flow' turned on for the GitHub OAuth App?",
			502,
		);
	}

	const dc = (await resp.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete?: string;
		expires_in: number;
		interval: number;
	};

	const pollKey = crypto.randomUUID();
	const pending: PendingAuth = {
		oauthReqInfo,
		deviceCode: dc.device_code,
		interval: dc.interval,
	};
	await c.env.OAUTH_KV.put(KV_PREFIX + pollKey, JSON.stringify(pending), {
		expirationTtl: Math.max(60, dc.expires_in),
	});

	return c.html(
		renderDevicePage({
			userCode: dc.user_code,
			verificationUri: dc.verification_uri,
			verificationUriComplete: dc.verification_uri_complete ?? dc.verification_uri,
			pollKey,
			intervalMs: Math.max(1, dc.interval) * 1000,
		}),
	);
});

/**
 * GET /authorize/poll?key=... — polled by the device page.
 *
 * Falls through to this handler (the OAuth provider only intercepts
 * metadata/token/register/api routes). Returns JSON:
 *   { status: "pending" }                      — keep polling
 *   { status: "complete", redirectTo }         — navigate back to Claude
 *   { status: "error", error }                 — stop, show message
 */
app.get("/authorize/poll", async (c) => {
	const pollKey = c.req.query("key");
	if (!pollKey) {
		return c.json({ status: "error", error: "Missing key" }, 400);
	}

	const raw = await c.env.OAUTH_KV.get(KV_PREFIX + pollKey);
	if (!raw) {
		return c.json({ status: "error", error: "Authorization expired. Reload to try again." });
	}
	const { oauthReqInfo, deviceCode } = JSON.parse(raw) as PendingAuth;

	const resp = await fetch(GITHUB_TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			device_code: deviceCode,
			grant_type: DEVICE_GRANT,
		}).toString(),
	});
	const data = (await resp.json()) as { access_token?: string; error?: string };

	// Still waiting for the user to enter the code.
	if (data.error === "authorization_pending" || data.error === "slow_down") {
		return c.json({ status: "pending" });
	}

	if (!data.access_token) {
		// expired_token, access_denied, incorrect_device_code, etc.
		console.warn(`device token error: ${data.error}`);
		await c.env.OAUTH_KV.delete(KV_PREFIX + pollKey);
		return c.json({ status: "error", error: `GitHub authorization failed (${data.error ?? "unknown"}).` });
	}

	const accessToken = data.access_token;
	const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
	const { login, name, email } = user.data;

	// Gate at auth time too — defense in depth, and a clearer failure than the
	// silent 403 the proxy would otherwise return on every later request.
	const allowed = ((c.env as unknown as { ALLOWED_GITHUB_LOGIN?: string }).ALLOWED_GITHUB_LOGIN ?? "").toLowerCase();
	if (!allowed || login.toLowerCase() !== allowed) {
		await c.env.OAUTH_KV.delete(KV_PREFIX + pollKey);
		console.warn(`auth gate: rejected login=${JSON.stringify(login)} (allowed set: ${allowed ? "yes" : "no"})`);
		return c.json({
			status: "error",
			error: `GitHub user "${login}" is not authorized for this connector.`,
		});
	}

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: name ?? login },
		props: { accessToken, email, login, name } as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	await c.env.OAUTH_KV.delete(KV_PREFIX + pollKey);
	return c.json({ status: "complete", redirectTo });
});

function renderDevicePage(opts: {
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	pollKey: string;
	intervalMs: number;
}): string {
	// user_code / URLs come from GitHub; escape before interpolating into HTML.
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const userCode = esc(opts.userCode);
	const verifyUri = esc(opts.verificationUri);
	const verifyComplete = esc(opts.verificationUriComplete);
	const pollKey = esc(opts.pollKey);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kagi MCP — authorize with GitHub</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.3rem; }
  .code { font-size: 2rem; font-weight: 700; letter-spacing: 0.15em; margin: 1rem 0; padding: 0.75rem 1rem; border: 1px solid currentColor; border-radius: 0.5rem; text-align: center; user-select: all; }
  a.btn { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1rem; border-radius: 0.5rem; background: #ffb319; color: #000; text-decoration: none; font-weight: 600; }
  #status { margin-top: 1.5rem; font-weight: 600; }
  .muted { opacity: 0.7; font-size: 0.9rem; }
</style>
</head>
<body>
  <h1>Kagi MCP — private bridge</h1>
  <p>To authorize this connector, sign in with the allowed GitHub account:</p>
  <ol>
    <li>Open <a href="${verifyUri}" target="_blank" rel="noopener">${verifyUri}</a></li>
    <li>Enter this code:</li>
  </ol>
  <div class="code">${userCode}</div>
  <a class="btn" href="${verifyComplete}" target="_blank" rel="noopener">Open GitHub &amp; prefill code</a>
  <p id="status" class="muted">Waiting for you to authorize on GitHub…</p>
<script>
  const key = ${JSON.stringify(pollKey)};
  const intervalMs = ${opts.intervalMs};
  const statusEl = document.getElementById("status");
  async function poll() {
    try {
      const r = await fetch("/authorize/poll?key=" + encodeURIComponent(key), { headers: { Accept: "application/json" } });
      const d = await r.json();
      if (d.status === "complete") {
        statusEl.textContent = "Authorized — redirecting…";
        window.location.href = d.redirectTo;
        return;
      }
      if (d.status === "error") {
        statusEl.textContent = "⚠ " + d.error;
        return;
      }
    } catch (_e) { /* transient — keep polling */ }
    setTimeout(poll, intervalMs);
  }
  setTimeout(poll, intervalMs);
</script>
</body>
</html>`;
}

export { app as GitHubHandler };
