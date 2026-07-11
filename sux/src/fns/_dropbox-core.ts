import { type RtEnv } from "../registry";

// Shared Dropbox token-lifecycle + fetch/rpc plumbing. Both Dropbox scopes — the
// App-folder credential (Mode A, dropbox.ts) and the whole-account credential
// (Mode B, _dropbox-full.ts) — refresh a short-lived access token from a long-lived
// refresh token, cache it in KV until just before it expires, and self-heal a 401 by
// re-minting once. The ONLY differences are the credential set and the KV key, so both
// are captured in a DropboxScope the callers build; this owns the identical machinery.
//
// Auth supports both confidential (app secret → HTTP Basic) and public (PKCE, no
// secret → client_id in the body) clients; a static token is honored as a quick-test
// fallback. Kept out of scope on purpose: path normalization (Mode A and Mode B differ
// on trailing slashes) stays in each caller.

export const DROPBOX_API = "https://api.dropboxapi.com/2";
export const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";
const OAUTH_TOKEN_URL = "https://api.dropbox.com/oauth2/token";

/** Above this, reads return metadata + a link instead of inlining bytes. */
export const MAX_INLINE_BYTES = 4 * 1024 * 1024;
export const TEXT_EXT = /\.(md|txt|json|csv|tsv|ya?ml|xml|html?|js|ts|css)$/i;

// Dropbox requires the Dropbox-API-Arg header to be HTTP-header-safe JSON:
// every char >= 0x7F escaped as \uXXXX (raw UTF-8 header bytes get a 400).
export const headerSafeJson = (v: unknown): string => JSON.stringify(v).replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** One Dropbox credential scope: the KV key its access token caches under plus the
 * refresh/app/static credentials that mint it. `label` prefixes token-refresh errors;
 * `notConfigured` is thrown when neither the refresh flow nor a static token is set. */
export interface DropboxScope {
	tokenKey: string;
	refreshToken?: unknown;
	appKey?: unknown;
	appSecret?: unknown;
	staticToken?: unknown;
	label: string;
	notConfigured: string;
}

/** True when the scope is usable by EITHER path — the durable refresh flow or a static token. */
export const scopeConfigured = (s: DropboxScope): boolean => Boolean((s.refreshToken && s.appKey) || s.staticToken);

/** Mint a short-lived access token from the refresh token and cache it in KV (TTL = expires_in - 60, clamped to KV's 60s floor). */
async function mintToken(env: RtEnv, s: DropboxScope): Promise<string> {
	// Confidential client (app secret set) → HTTP Basic auth. Public client (PKCE, no
	// secret) → client_id in the body, no Authorization header. Both are valid Dropbox
	// refresh flows; the public path lets the Worker hold NO long-lived app secret —
	// only the app key (public) + the refresh token.
	const hasSecret = Boolean(s.appSecret);
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
	if (hasSecret) headers.Authorization = `Basic ${btoa(`${s.appKey}:${s.appSecret}`)}`;
	const resp = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers,
		body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(String(s.refreshToken))}${hasSecret ? "" : `&client_id=${encodeURIComponent(String(s.appKey))}`}`,
		signal: AbortSignal.timeout(20_000),
	});
	const j: any = await resp.json().catch(() => null);
	if (!resp.ok || !j?.access_token) throw new Error(`${s.label} token refresh HTTP ${resp.status}: ${j?.error_description ?? j?.error ?? "no access_token"}`);
	const ttl = Math.max(60, (Number(j?.expires_in) || 14_400) - 60);
	await env.OAUTH_KV?.put(s.tokenKey, String(j.access_token), { expirationTtl: ttl });
	return String(j.access_token);
}

/** Resolve a bearer token for the scope: KV-cached refresh token, else a fresh mint, else the static fallback. */
export async function dropboxToken(env: RtEnv, s: DropboxScope): Promise<string> {
	if (s.refreshToken && s.appKey) {
		const cached = await env.OAUTH_KV?.get(s.tokenKey);
		if (cached) return cached;
		return mintToken(env, s);
	}
	if (s.staticToken) return String(s.staticToken);
	throw new Error(s.notConfigured);
}

/** Drop the cached access token so the next call re-mints from the refresh token
 * (called on a 401 so a server-side revocation self-heals instead of failing the whole KV TTL). */
async function invalidateToken(env: RtEnv, s: DropboxScope): Promise<void> {
	try {
		await env.OAUTH_KV?.delete(s.tokenKey);
	} catch {}
}

/** Fetch with per-scope 401 self-heal: on a 401 under the refresh flow, drop the cached token and re-mint ONCE (never touches the other scope's credential). */
export async function dropboxFetch(env: RtEnv, s: DropboxScope, url: string, build: (token: string) => RequestInit): Promise<Response> {
	const first = await fetch(url, build(await dropboxToken(env, s)));
	if (first.status !== 401 || !(s.refreshToken && s.appKey)) return first;
	await invalidateToken(env, s);
	return fetch(url, build(await dropboxToken(env, s)));
}

/** POST a JSON-RPC Dropbox API call, returning the status and parsed body. */
export async function dropboxRpc(env: RtEnv, s: DropboxScope, path: string, body: unknown): Promise<{ status: number; json: any }> {
	const resp = await dropboxFetch(env, s, `${DROPBOX_API}${path}`, (token) => ({
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	}));
	return { status: resp.status, json: await resp.json().catch(() => null) };
}
