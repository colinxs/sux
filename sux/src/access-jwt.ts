// Verifies Cloudflare Access JWTs (the `Cf-Access-Jwt-Assertion` header Access
// injects on every request it fronts) server-side. Access is still the primary
// gate — this is defense in depth so the route fails *closed* (401) instead of
// open if the Access application is ever removed/misconfigured, or the Worker
// is reached directly via its workers.dev origin instead of the Access-fronted
// hostname.
//
// Ref: https://developers.cloudflare.com/cloudflare-one/identity/users/validating-json/

import type { RtEnv } from "./registry";

type Jwk = { kid: string; kty: string; n: string; e: string };
type Jwks = { keys: Jwk[] };

// JWKS rotate rarely; a short in-memory cache avoids a certs fetch per request
// without risking a stale key surviving a real rotation for long.
let cachedJwks: { teamDomain: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

function base64UrlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function base64UrlDecodeJson(s: string): any {
	return JSON.parse(new TextDecoder().decode(base64UrlDecode(s)));
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
	if (cachedJwks && cachedJwks.teamDomain === teamDomain && Date.now() - cachedJwks.fetchedAt < JWKS_TTL_MS) {
		return cachedJwks.keys;
	}
	const res = await fetch(`${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs fetch failed: HTTP ${res.status}`);
	const jwks = (await res.json()) as Jwks;
	cachedJwks = { teamDomain, keys: jwks.keys, fetchedAt: Date.now() };
	return jwks.keys;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
	return crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/**
 * Verify a Cloudflare Access JWT: RS256 signature against the team's published
 * JWKS, plus aud/exp/nbf checks. Fails closed (false) on any missing config,
 * malformed token, or verification failure — callers should treat `false` as
 * "block this request", never "let it through".
 */
export async function verifyAccessJwt(request: Request, env: RtEnv): Promise<boolean> {
	const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
	const aud = env.CF_ACCESS_AUD;
	if (!teamDomain || !aud) return false;

	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return false;

	const parts = token.split(".");
	if (parts.length !== 3) return false;
	const [headerB64, payloadB64, sigB64] = parts;

	let header: { kid?: string; alg?: string };
	let payload: { aud?: string[] | string; exp?: number; nbf?: number };
	try {
		header = base64UrlDecodeJson(headerB64);
		payload = base64UrlDecodeJson(payloadB64);
	} catch {
		return false;
	}
	if (header.alg !== "RS256" || !header.kid) return false;

	const now = Math.floor(Date.now() / 1000);
	if (typeof payload.exp !== "number" || payload.exp < now) return false;
	if (typeof payload.nbf === "number" && payload.nbf > now) return false;
	const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
	if (!auds.includes(aud)) return false;

	let keys: Jwk[];
	try {
		keys = await getJwks(teamDomain);
	} catch {
		return false;
	}
	const jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) return false;

	try {
		const key = await importRsaKey(jwk);
		const signature = base64UrlDecode(sigB64);
		const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
	} catch {
		return false;
	}
}
