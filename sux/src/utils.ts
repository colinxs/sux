/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstream_url - The base URL of the upstream service.
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (state) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

/**
 * Fetches an authorization token from an upstream service.
 *
 * @param {Object} options
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.client_secret - The client secret of the application.
 * @param {string} options.code - The authorization code.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} options.upstream_url - The token endpoint URL of the upstream service.
 *
 * @returns {Promise<[string, null] | [null, Response]>} A promise that resolves to an array containing the access token or an error response.
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[string, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		console.log(await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const body = await resp.formData();
	const accessToken = body.get("access_token") as string;
	if (!accessToken) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [accessToken, null];
}

/**
 * Fetch the authenticated GitHub user. Replaces the `octokit` SDK (12 MB in
 * node_modules, one call used) with a single REST request — GitHub requires a
 * User-Agent header.
 */
export async function fetchGitHubUser(
	accessToken: string,
): Promise<{ login: string; name: string | null; email: string | null }> {
	const resp = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "kagi-mcp",
		},
	});
	if (!resp.ok) {
		throw new Error(`GitHub /user failed: HTTP ${resp.status}`);
	}
	const u = (await resp.json()) as { login: string; name: string | null; email: string | null };
	return { login: u.login, name: u.name ?? null, email: u.email ?? null };
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
export type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

/**
 * Parse ALLOWED_GITHUB_LOGIN (a comma-separated list of GitHub usernames) into a
 * lower-cased Set. Empty/unset → empty set, which makes the gate fail closed
 * (nobody is allowed).
 */
export function parseAllowedLogins(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

/** Case-insensitive membership check against the allowlist. */
export function isAllowedLogin(login: string | undefined, raw: string | undefined): boolean {
	if (!login) return false;
	return parseAllowedLogins(raw).has(login.toLowerCase());
}
