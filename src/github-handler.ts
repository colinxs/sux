import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, isAllowedLogin, type Props } from "./utils";
import {
	addApprovedClient,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

/**
 * GET /health — unauthenticated liveness + config sanity for uptime monitors.
 *
 * Reports only booleans about whether required config is present (never the
 * values). `?deep=1` additionally pings Kagi's MCP to confirm reachability
 * (costs nothing on Kagi's side — `initialize` isn't metered).
 */
app.get("/health", async (c) => {
	const e = c.env as unknown as { KAGI_API_KEY?: string; ALLOWED_GITHUB_LOGIN?: string; GITHUB_CLIENT_ID?: string };
	const body: Record<string, unknown> = {
		status: "ok",
		config: {
			kagiKey: Boolean(e.KAGI_API_KEY),
			allowlist: Boolean(e.ALLOWED_GITHUB_LOGIN?.trim()),
			githubClient: Boolean(e.GITHUB_CLIENT_ID),
		},
	};

	if (c.req.query("deep") === "1") {
		try {
			const r = await fetch("https://mcp.kagi.com/mcp", {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					Authorization: `Bearer ${e.KAGI_API_KEY ?? ""}`,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } },
				}),
			});
			body.upstream = { reachable: r.ok, status: r.status };
		} catch (_err) {
			body.upstream = { reachable: false, status: 0 };
			return c.json({ ...body, status: "degraded" }, 503);
		}
	}

	return c.json(body);
});

// NOTE ON CSRF: we protect the GitHub round-trip with the OAuth `state` token —
// an unguessable value stored one-time in KV with a TTL (see createOAuthState /
// the /callback lookup). The upstream template ALSO bound state to a
// `__Host-CONSENTED_STATE` browser cookie as defense-in-depth, but Claude's
// connector OAuth runs in a context that doesn't carry that cookie through the
// GitHub redirect, so /callback failed with "Missing session binding cookie" and
// Claude re-prompted forever. We dropped that cookie layer; the KV state token is
// the standard, sufficient CSRF defense.

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// If this client was already approved on this browser, skip the dialog.
	if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		return redirectToGithub(c.req.raw, stateToken);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description:
				"Private bridge that lets your Claude connector reach the Kagi MCP server. Sign in with the authorized GitHub account to continue.",
			logo: "https://assets.kagi.com/v2/assets/img/logo_dark.png",
			name: "Kagi MCP (private bridge)",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();

		// CSRF on the approval form itself (double-submit cookie).
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// Remember this client so future authorizations skip the dialog.
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);

		return redirectToGithub(c.req.raw, stateToken, { "Set-Cookie": approvedClientCookie });
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text(`Internal server error: ${error.message}`, 500);
	}
});

async function redirectToGithub(
	request: Request,
	stateToken: string,
	headers: Record<string, string> = {},
) {
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: env.GITHUB_CLIENT_ID,
				redirect_uri: new URL("/callback", request.url).href,
				scope: "read:user",
				state: stateToken,
				upstream_url: "https://github.com/login/oauth/authorize",
			}),
		},
		status: 302,
	});
}

/**
 * OAuth Callback — GitHub redirects here after the user authorizes.
 *
 * CSRF: the `state` in the query must exist in KV (proves our server minted it,
 * one-time, TTL-bounded). We exchange the code for a GitHub token, gate on the
 * allowed login, then completeAuthorization() to mint the token Claude receives.
 */
app.get("/callback", async (c) => {
	const stateFromQuery = c.req.query("state");
	if (!stateFromQuery) {
		return c.text("Missing state parameter", 400);
	}

	const storedDataJson = await c.env.OAUTH_KV.get(`oauth:state:${stateFromQuery}`);
	if (!storedDataJson) {
		return c.text("Invalid or expired state", 400);
	}
	// One-time use.
	await c.env.OAUTH_KV.delete(`oauth:state:${stateFromQuery}`);

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
	} catch (_e) {
		return c.text("Invalid state data", 500);
	}
	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Exchange the code for a GitHub access token.
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
	const { login, name, email } = user.data;

	// Gate at login time (defense in depth; clearer than a later silent 403).
	const allowedRaw = (c.env as unknown as { ALLOWED_GITHUB_LOGIN?: string }).ALLOWED_GITHUB_LOGIN;
	if (!isAllowedLogin(login, allowedRaw)) {
		console.warn(`auth gate: rejected login=${JSON.stringify(login)}`);
		return c.text(`GitHub user "${login}" is not authorized for this connector.`, 403);
	}

	console.log(`callback: issuing token for login=${JSON.stringify(login)} client=${oauthReqInfo.clientId}`);

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: name ?? login },
		props: { accessToken, email, login, name } as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	return new Response(null, { status: 302, headers: { Location: redirectTo } });
});

export { app as GitHubHandler };
