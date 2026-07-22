// Runtime GitHub App installation-token minting for the `suxbot` org App.
//
// The vault repo (OBSIDIAN_VAULT_REPO) lives under the SuxOS org, which the
// suxbot App is installed on org-wide (repository_selection: all) with
// contents:write. Authing vault writes AS the App — rather than a personal PAT —
// moves them onto the org's own installation-token budget (and off any one
// human's account ceiling), and keeps the write credential org-scoped rather
// than tied to a single user.
//
// Installation tokens are short-lived (~1h), so they can't live as a static
// secret: we mint one on demand from the App id + private key (a JWT signed
// RS256, exchanged for an installation token), cache it in KV until just before
// it expires, and reuse it across requests. The whole path is OPT-IN — it arms
// only when SUX_BOT_APP_ID + SUX_BOT_PRIVATE_KEY + SUX_BOT_INSTALLATION_ID are
// all set; absent any of them, vaultAuthHeaders falls back to GITHUB_TOKEN
// (today's behavior), so shipping this changes nothing until the secrets exist.

import { smartFetch } from "./proxy";
import { isGithubHost } from "./github-auth";

const GH = "https://api.github.com";
const TOKEN_KEY = "cache:suxbot:installation-token";
// Re-mint this far ahead of the real expiry so an in-flight vault write never
// races the 1h boundary and lands with a token that expires mid-request.
const EXPIRY_SKEW_MS = 120_000;

interface SuxbotEnv {
	SUX_BOT_APP_ID?: string;
	SUX_BOT_PRIVATE_KEY?: string;
	SUX_BOT_INSTALLATION_ID?: string;
	GITHUB_TOKEN?: string;
	OAUTH_KV?: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: unknown): Promise<void> };
}

/** True when all three App secrets needed to mint an installation token are set. */
export function hasSuxbotApp(env: SuxbotEnv): boolean {
	return Boolean(env.SUX_BOT_APP_ID && env.SUX_BOT_PRIVATE_KEY && env.SUX_BOT_INSTALLATION_ID);
}

// ── base64url ──────────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── PEM → PKCS#8 DER ───────────────────────────────────────────────────────────
// GitHub distributes App private keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but
// WebCrypto's importKey only accepts PKCS#8 ("BEGIN PRIVATE KEY") for RSA. Decode
// the PEM body to DER; if it's PKCS#1, wrap it in the fixed PKCS#8 envelope
// (version 0 + the rsaEncryption AlgorithmIdentifier + the PKCS#1 key as an OCTET
// STRING). Both PEM labels are accepted so the same secret works either way.
function pemBodyToDer(pem: string): Uint8Array {
	const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** DER length octets (short form under 128, else long form). */
function derLen(n: number): number[] {
	if (n < 0x80) return [n];
	const bytes: number[] = [];
	for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
	return [0x80 | bytes.length, ...bytes];
}

/** DER tag-length-value. */
function derTlv(tag: number, content: Uint8Array): Uint8Array {
	const len = derLen(content.length);
	const out = new Uint8Array(1 + len.length + content.length);
	out[0] = tag;
	out.set(len, 1);
	out.set(content, 1 + len.length);
	return out;
}

// AlgorithmIdentifier for rsaEncryption (OID 1.2.840.113549.1.1.1) with NULL params.
const RSA_ALG_ID = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
const PKCS8_VERSION = Uint8Array.from([0x02, 0x01, 0x00]);

export function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
	const octet = derTlv(0x04, pkcs1Der);
	const body = new Uint8Array(PKCS8_VERSION.length + RSA_ALG_ID.length + octet.length);
	body.set(PKCS8_VERSION, 0);
	body.set(RSA_ALG_ID, PKCS8_VERSION.length);
	body.set(octet, PKCS8_VERSION.length + RSA_ALG_ID.length);
	return derTlv(0x30, body);
}

async function importRsaKey(pem: string): Promise<CryptoKey> {
	const der = pemBodyToDer(pem);
	const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
	return crypto.subtle.importKey("pkcs8", pkcs8 as unknown as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// ── App JWT (RS256) ────────────────────────────────────────────────────────────
async function appJwt(env: SuxbotEnv): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	// iat backdated 60s for clock skew; exp is GitHub's 10-min ceiling minus a margin.
	const payload = b64url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(env.SUX_BOT_APP_ID) })));
	const signingInput = `${header}.${payload}`;
	const key = await importRsaKey(String(env.SUX_BOT_PRIVATE_KEY));
	const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
	return `${signingInput}.${b64url(sig)}`;
}

interface CachedToken {
	token: string;
	exp: number;
}

/**
 * A valid suxbot installation token, minting a fresh one when the KV-cached copy
 * is missing or within EXPIRY_SKEW_MS of expiry. Returns null (never throws) when
 * the App secrets are unset or any step fails, so the caller falls back cleanly to
 * GITHUB_TOKEN. KV has no compare-and-swap, so two concurrent misses may both mint;
 * harmless (each token is independently valid), same tradeoff obsidian's head cache
 * already accepts for this single-user vault.
 */
export async function suxbotInstallationToken(env: SuxbotEnv): Promise<string | null> {
	if (!hasSuxbotApp(env)) return null;
	try {
		const cachedRaw = await env.OAUTH_KV?.get(TOKEN_KEY).catch(() => null);
		if (cachedRaw) {
			const cached = JSON.parse(cachedRaw) as CachedToken;
			if (cached?.token && cached.exp - Date.now() > EXPIRY_SKEW_MS) return cached.token;
		}
		const jwt = await appJwt(env);
		const resp = await smartFetch(env, `${GH}/app/installations/${encodeURIComponent(String(env.SUX_BOT_INSTALLATION_ID))}/access_tokens`, {
			method: "POST",
			headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "sux-github-app", "X-GitHub-Api-Version": "2022-11-28" },
			body: "{}",
		});
		if (resp.status !== 201) return null;
		const json = (await resp.json().catch(() => null)) as { token?: string; expires_at?: string } | null;
		if (!json?.token) return null;
		const exp = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 3_600_000;
		await env.OAUTH_KV?.put(TOKEN_KEY, JSON.stringify({ token: json.token, exp } as CachedToken)).catch(() => {});
		return json.token;
	} catch {
		return null;
	}
}

/**
 * Authorization header for a GitHub request against the vault repo. Prefers a
 * freshly-minted suxbot installation token (org App, contents:write) when the App
 * secrets are configured, else falls back to GITHUB_TOKEN — identical to the
 * ambient injection in proxy.ts, so the absent-App-secrets path is a no-op change.
 * Returns {} for non-GitHub hosts: the token is never attached off-GitHub, the same
 * boundary githubAuthHeaders enforces. Caller headers win in smartFetch, so setting
 * this on a vault request overrides that ambient GITHUB_TOKEN for vault traffic only.
 */
export async function vaultAuthHeaders(env: SuxbotEnv, url: string): Promise<Record<string, string>> {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return {};
	}
	if (!isGithubHost(hostname)) return {};
	const appToken = await suxbotInstallationToken(env);
	if (appToken) return { Authorization: `Bearer ${appToken}` };
	if (env.GITHUB_TOKEN) return { Authorization: `Bearer ${env.GITHUB_TOKEN}` };
	return {};
}
