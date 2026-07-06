import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { fetchGitHubUser, fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, isAllowedLogin, type Props } from "./utils";
import {
	addApprovedClient,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
} from "./workers-oauth-utils";

// The OAuth provider injects OAUTH_PROVIDER onto env and passes it to this
// default handler. Secrets (GITHUB_*, COOKIE_ENCRYPTION_KEY, ALLOWED_GITHUB_LOGIN,
// KAGI_API_KEY) come from wrangler secrets / .dev.vars.
type HandlerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers } & {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	ALLOWED_GITHUB_LOGIN?: string;
	KAGI_API_KEY?: string;
};

const text = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Default handler for everything the OAuth provider doesn't intercept:
 * /authorize, /callback, /health. Plain routing — no framework.
 */
export const GitHubHandler = {
	async fetch(request: Request, env: HandlerEnv): Promise<Response> {
		const url = new URL(request.url);
		const p = url.pathname;
		const m = request.method;
		if (m === "GET" && p === "/health") return handleHealth(url, env);
		if (m === "GET" && p === "/authorize") return handleAuthorizeGet(request, env);
		if (m === "POST" && p === "/authorize") return handleAuthorizePost(request, env);
		if (m === "GET" && p === "/callback") return handleCallback(request, url, env);
		return text("Not found", 404);
	},
};

/**
 * GET /health — unauthenticated liveness + config sanity for uptime monitors.
 * Reports only whether required config is present (never the values). `?deep=1`
 * also pings Kagi to confirm reachability.
 */
async function handleHealth(url: URL, env: HandlerEnv): Promise<Response> {
	const body: Record<string, unknown> = {
		status: "ok",
		config: {
			kagiKey: Boolean(env.KAGI_API_KEY),
			allowlist: Boolean(env.ALLOWED_GITHUB_LOGIN?.trim()),
			githubClient: Boolean(env.GITHUB_CLIENT_ID),
		},
	};

	if (url.searchParams.get("deep") === "1") {
		try {
			const r = await fetch("https://mcp.kagi.com/mcp", {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.KAGI_API_KEY ?? ""}`,
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
			return json({ ...body, status: "degraded", upstream: { reachable: false, status: 0 } }, 503);
		}
	}

	return json(body);
}

// CSRF: we protect the GitHub round-trip with the OAuth `state` token — an
// unguessable value stored one-time in KV with a TTL (createOAuthState / the
// /callback lookup). The upstream template also bound state to a
// `__Host-CONSENTED_STATE` cookie, but Claude's connector OAuth doesn't carry
// that cookie through the GitHub redirect (it made /callback fail and Claude
// re-prompt forever), so we dropped it. The KV state token is the standard,
// sufficient CSRF defense.

async function handleAuthorizeGet(request: Request, env: HandlerEnv): Promise<Response> {
	const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const { clientId } = oauthReqInfo;
	if (!clientId) return text("Invalid request", 400);

	// If this client was already approved on this browser, skip the dialog.
	if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
		return redirectToGithub(request, env, stateToken);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(request, {
		client: await env.OAUTH_PROVIDER.lookupClient(clientId),
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
}

async function handleAuthorizePost(request: Request, env: HandlerEnv): Promise<Response> {
	try {
		const formData = await request.formData();

		// CSRF on the approval form itself (double-submit cookie).
		validateCSRFToken(formData, request);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return text("Invalid request", 400);
		}

		// Remember this client so future authorizations skip the dialog.
		const approvedClientCookie = await addApprovedClient(
			request,
			state.oauthReqInfo.clientId,
			env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, env.OAUTH_KV);

		return redirectToGithub(request, env, stateToken, { "Set-Cookie": approvedClientCookie });
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) return error.toResponse();
		return text(`Internal server error: ${error.message}`, 500);
	}
}

function redirectToGithub(
	request: Request,
	env: HandlerEnv,
	stateToken: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(null, {
		status: 302,
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
	});
}

/**
 * GET /callback — GitHub redirects here after authorization. The `state` must
 * exist in KV (one-time, TTL). We exchange the code for a GitHub token, gate on
 * the allowed login, then completeAuthorization() to mint Claude's token.
 */
async function handleCallback(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
	const stateFromQuery = url.searchParams.get("state");
	if (!stateFromQuery) return text("Missing state parameter", 400);

	const storedDataJson = await env.OAUTH_KV.get(`oauth:state:${stateFromQuery}`);
	if (!storedDataJson) return text("Invalid or expired state", 400);
	await env.OAUTH_KV.delete(`oauth:state:${stateFromQuery}`); // one-time use

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
	} catch (_e) {
		return text("Invalid state data", 500);
	}
	if (!oauthReqInfo.clientId) return text("Invalid OAuth request data", 400);

	// Exchange the code for a GitHub access token.
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: env.GITHUB_CLIENT_ID,
		client_secret: env.GITHUB_CLIENT_SECRET,
		code: url.searchParams.get("code") ?? undefined,
		redirect_uri: new URL("/callback", request.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	const { login, name, email } = await fetchGitHubUser(accessToken);

	// Gate at login time (defense in depth; clearer than a later silent 403).
	if (!isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)) {
		console.warn(`auth gate: rejected login=${JSON.stringify(login)}`);
		return text(`GitHub user "${login}" is not authorized for this connector.`, 403);
	}

	console.log(`callback: issuing token for login=${JSON.stringify(login)} client=${oauthReqInfo.clientId}`);

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: name ?? login },
		props: { accessToken, email, login, name } as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	return new Response(null, { status: 302, headers: { Location: redirectTo } });
}
