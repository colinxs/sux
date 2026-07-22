// Runtime GitHub App installation-token minting for the `suxbot` org App —
// the WRITE-auth path for the git vault backend (fns/obsidian.ts).
//
// The vault repo (OBSIDIAN_VAULT_REPO) lives under the SuxOS org, which the
// suxbot App is installed on org-wide (repository_selection: all) with
// contents:write. Authing vault writes AS the App — rather than a single human's
// PAT — moves them onto the org's own installation-token budget (and off any one
// account's rate ceiling), and keeps the write credential org-scoped and
// rotatable at the App rather than tied to a personal token.
//
// Installation tokens are short-lived (~1h), so they can't live as a static
// Cloudflare secret: we mint one on demand from the App id + private key (a JWT
// signed RS256, exchanged for an installation token), cache it in KV until just
// before it expires, and reuse it across requests.
//
// The whole path is OPT-IN — it arms only when SUX_BOT_APP_ID +
// SUX_BOT_PRIVATE_KEY + SUX_BOT_INSTALLATION_ID are ALL set. Absent any of them,
// vaultAuthHeaders returns nothing and vault writes fall back to the ambient
// GITHUB_TOKEN exactly as before, so shipping this changes NOTHING until the
// secrets exist and OBSIDIAN_VAULT_REPO is pointed at the org repo.

import { smartFetch } from "./proxy";
import { isGithubHost } from "./github-auth";

const GH = "https://api.github.com";
// Cache-key PREFIX; the scoped repo name is appended (`${TOKEN_KEY}:${repo}`) so a
// token minted for one repo — or a pre-scoping org-wide token cached under the
// bare key — is never served for another. Bumped to :v2 to retire any broad token
// already sitting under the old bare "cache:suxbot:installation-token" key.
const TOKEN_KEY = "cache:suxbot:installation-token:v2";
// Re-mint this far ahead of the real expiry so an in-flight vault write never
// races the 1h boundary and lands with a token that expires mid-request.
const EXPIRY_SKEW_MS = 120_000;

interface SuxbotEnv {
	SUX_BOT_APP_ID?: string;
	SUX_BOT_PRIVATE_KEY?: string;
	SUX_BOT_INSTALLATION_ID?: string;
	// "owner/repo" of the vault the token is scoped to (least-privilege). The token
	// is minted for just this repo, so the write credential can't reach anything
	// else the org App is installed on.
	OBSIDIAN_VAULT_REPO?: string;
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

// ── PEM → DER ────────────────────────────────────────────────────────────────
function pemBodyToDer(pem: string): Uint8Array {
	const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// ── PKCS#1 → PKCS#8 ────────────────────────────────────────────────────────────
// GitHub distributes App private keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but
// WebCrypto's importKey only accepts PKCS#8 ("BEGIN PRIVATE KEY") for RSA. Wrap
// the PKCS#1 DER in the fixed PKCS#8 envelope (version 0 + the rsaEncryption
// AlgorithmIdentifier + the PKCS#1 key as an OCTET STRING). Both PEM labels are
// accepted so the same secret works whichever format the App key was downloaded in.

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
	// iat backdated 60s for clock skew; exp under GitHub's 10-min ceiling with margin.
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

/** Bare repo name of the scoped vault ("owner/repo" → "repo"), or null when
 * OBSIDIAN_VAULT_REPO is unset/malformed. The `repositories` param of the
 * access-tokens endpoint takes repo NAMES, not "owner/repo", so the owner prefix
 * is stripped. Derived (not hardcoded "vault") so it tracks a vault retarget. */
function vaultRepoName(env: SuxbotEnv): string | null {
	const parts = String(env.OBSIDIAN_VAULT_REPO ?? "").split("/");
	return parts.length === 2 && parts[1] ? parts[1] : null;
}

/**
 * A valid suxbot installation token, minting a fresh one when the KV-cached copy
 * is missing or within EXPIRY_SKEW_MS of expiry. Returns null (never throws) when
 * the App secrets are unset or any step fails, so the caller falls back cleanly to
 * GITHUB_TOKEN. KV has no compare-and-swap, so two concurrent misses may both mint;
 * harmless (each token is independently valid) — the same tradeoff obsidian's HEAD
 * cache already accepts for this single-user vault.
 *
 * Least-privilege: the ONLY consumer of this token is vault writes, so the mint
 * scopes it to just the vault repo (`repositories: [<repo>]`) instead of letting
 * it inherit the App's org-wide installation (an empty body → repository_selection:
 * all). Without a parseable OBSIDIAN_VAULT_REPO there is nothing to scope to (and
 * vault writes aren't configured), so it refuses to mint rather than fall back to a
 * broad token, and vault traffic uses GITHUB_TOKEN instead.
 */
export async function suxbotInstallationToken(env: SuxbotEnv): Promise<string | null> {
	if (!hasSuxbotApp(env)) return null;
	const repo = vaultRepoName(env);
	if (!repo) return null;
	// Scope is part of the cache identity — never serve a token minted for a
	// different (or a pre-scoping org-wide) target for this repo.
	const cacheKey = `${TOKEN_KEY}:${repo}`;
	try {
		const cachedRaw = await env.OAUTH_KV?.get(cacheKey).catch(() => null);
		if (cachedRaw) {
			const cached = JSON.parse(cachedRaw) as CachedToken;
			if (cached?.token && cached.exp - Date.now() > EXPIRY_SKEW_MS) return cached.token;
		}
		const jwt = await appJwt(env);
		const resp = await smartFetch(env, `${GH}/app/installations/${encodeURIComponent(String(env.SUX_BOT_INSTALLATION_ID))}/access_tokens`, {
			method: "POST",
			headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "sux-github-app", "X-GitHub-Api-Version": "2022-11-28" },
			body: JSON.stringify({ repositories: [repo] }),
		});
		if (resp.status !== 201) return null;
		const json = (await resp.json().catch(() => null)) as { token?: string; expires_at?: string } | null;
		if (!json?.token) return null;
		const exp = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 3_600_000;
		await env.OAUTH_KV?.put(cacheKey, JSON.stringify({ token: json.token, exp } as CachedToken)).catch(() => {});
		return json.token;
	} catch {
		return null;
	}
}

/**
 * Authorization header for a GitHub request against the vault repo. Prefers a
 * freshly-minted suxbot installation token (org App, contents:write, scoped to the
 * single vault repo) when the App secrets are configured, else falls back to
 * GITHUB_TOKEN — identical to the
 * ambient injection smartFetch already does, so the absent-App-secrets path is a
 * no-op change. Returns {} for non-GitHub hosts: the token is NEVER attached
 * off-GitHub, the same trust boundary githubAuthHeaders enforces. Because
 * smartFetch merges caller headers OVER its ambient GITHUB_TOKEN, setting this on a
 * vault request overrides that PAT for vault traffic ONLY — no other fetch changes.
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
