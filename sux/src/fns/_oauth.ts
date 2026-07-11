import { withRetry } from "../proxy";
import type { RtEnv } from "../registry";

// Shared OAuth2 client-credentials token lifecycle — the mint-once-and-KV-cache
// pattern that ebay/kroger/tailscale each hand-rolled identically. Parameterised by
// the token endpoint, credentials, cache key, and the two axes that actually differ
// between providers: how the client authenticates (HTTP Basic header vs client_id/
// secret in the body) and whether a scope is sent. The per-provider `api()` wrappers
// keep their own 401/403 self-heal (delete cache → mintToken again) — this owns only
// the mint + cache + read.

export interface OAuthClientCreds {
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	/** KV key the minted access token is cached under. */
	cacheKey: string;
	/** OAuth scope, when the provider requires one (ebay/kroger); omit for none (tailscale). */
	scope?: string;
	/** Client authentication: "basic" = HTTP Basic header (default), "body" = client_id/secret in the form body. */
	auth?: "basic" | "body";
	/** A client-credentials mint has no side effect, so a transient blip is safe to retry with backoff. */
	retry?: boolean;
	/** Fallback lifetime (seconds) when the token response omits expires_in. */
	defaultTtl?: number;
}

/** Mint a fresh access token from the client-credentials endpoint and cache it in KV
 * with TTL = expires_in - 60 (never used in its final minute; clamped to KV's 60s floor). */
export async function mintClientToken(env: RtEnv, o: OAuthClientCreds): Promise<string> {
	const params = new URLSearchParams({ grant_type: "client_credentials" });
	if (o.scope) params.set("scope", o.scope);
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
	if ((o.auth ?? "basic") === "basic") {
		headers.Authorization = `Basic ${btoa(`${o.clientId}:${o.clientSecret}`)}`;
	} else {
		params.set("client_id", o.clientId);
		params.set("client_secret", o.clientSecret);
	}
	const doFetch = () => fetch(o.tokenUrl, { method: "POST", headers, body: params.toString() });
	const resp = await (o.retry ? withRetry(doFetch) : doFetch());
	if (!resp.ok) throw new Error(`OAuth token HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	const j: any = await resp.json();
	const token = String(j?.access_token ?? "");
	if (!token) throw new Error("OAuth token response had no access_token.");
	const ttl = Math.max(60, (Number(j?.expires_in) || o.defaultTtl || 3600) - 60);
	await env.OAUTH_KV.put(o.cacheKey, token, { expirationTtl: ttl });
	return token;
}

/** Get a valid access token — from KV if present, else mint one and cache it. */
export async function getClientToken(env: RtEnv, o: OAuthClientCreds): Promise<string> {
	const cached = await env.OAUTH_KV.get(o.cacheKey);
	return cached || mintClientToken(env, o);
}
