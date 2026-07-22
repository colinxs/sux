import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPublicKey, generateKeyPairSync, verify as nodeVerify } from "node:crypto";

// Route the App-token mint POST through a mockable seam, exactly like the other
// proxy-backed tests (vault-mcp.test.ts, kagi.test.ts).
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response | Promise<Response>) }));
vi.mock("./proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { hasSuxbotApp, pkcs1ToPkcs8, vaultAuthHeaders } from "./github-app";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}

// A REAL RSA keypair, private key in PKCS#1 PEM ("BEGIN RSA PRIVATE KEY") — the
// exact shape GitHub hands out an App key in — so importRsaKey's PKCS#1→PKCS#8
// conversion + RS256 signing actually run end to end (not a stub).
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const VAULT_URL = "https://api.github.com/repos/SuxOS/vault/contents/Daily%2F2026-07-22.md";
const iso1h = () => new Date(Date.now() + 3_600_000).toISOString();

describe("hasSuxbotApp", () => {
	it("is true only when all three App secrets are set", () => {
		expect(hasSuxbotApp({ SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: "k", SUX_BOT_INSTALLATION_ID: "2" })).toBe(true);
		expect(hasSuxbotApp({ SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: "k" })).toBe(false);
		expect(hasSuxbotApp({ SUX_BOT_APP_ID: "1", SUX_BOT_INSTALLATION_ID: "2" })).toBe(false);
		expect(hasSuxbotApp({})).toBe(false);
	});
});

describe("vaultAuthHeaders — no App configured (fallback to GITHUB_TOKEN)", () => {
	beforeEach(() => {
		routes.handler = () => {
			throw new Error("smartFetch must not be called when the App is not configured");
		};
	});

	it("falls back to the ambient GITHUB_TOKEN bearer for a github host", async () => {
		expect(await vaultAuthHeaders({ GITHUB_TOKEN: "pat" }, VAULT_URL)).toEqual({ Authorization: "Bearer pat" });
	});

	it("never attaches a token off-github, even with a PAT set", async () => {
		expect(await vaultAuthHeaders({ GITHUB_TOKEN: "pat" }, "https://evil.example.com/repos/SuxOS/vault")).toEqual({});
		expect(await vaultAuthHeaders({ GITHUB_TOKEN: "pat" }, "https://api.github.com.evil.com/x")).toEqual({});
	});

	it("returns {} when neither an App nor a PAT is configured", async () => {
		expect(await vaultAuthHeaders({}, VAULT_URL)).toEqual({});
	});

	it("returns {} for a malformed url", async () => {
		expect(await vaultAuthHeaders({ GITHUB_TOKEN: "pat" }, "not a url")).toEqual({});
	});
});

describe("vaultAuthHeaders — suxbot App configured", () => {
	let mints: number;
	let lastMint: { url: string; init: any } | null;

	function appEnv() {
		return {
			SUX_BOT_APP_ID: "1234567",
			SUX_BOT_PRIVATE_KEY: privateKey,
			SUX_BOT_INSTALLATION_ID: "146421817",
			GITHUB_TOKEN: "pat-fallback",
			OAUTH_KV: kvStub(),
		} as any;
	}

	beforeEach(() => {
		mints = 0;
		lastMint = null;
		routes.handler = (url, init) => {
			if (url.includes("/access_tokens")) {
				mints++;
				lastMint = { url, init };
				return new Response(JSON.stringify({ token: "ghs_installtok", expires_at: iso1h() }), { status: 201 });
			}
			throw new Error(`unexpected mint url ${url}`);
		};
	});

	it("mints and prefers the org installation token over the PAT for vault traffic", async () => {
		const env = appEnv();
		expect(await vaultAuthHeaders(env, VAULT_URL)).toEqual({ Authorization: "Bearer ghs_installtok" });
		expect(mints).toBe(1);
		// Minted against the configured installation, as a POST.
		expect(lastMint!.url).toBe("https://api.github.com/app/installations/146421817/access_tokens");
		expect(lastMint!.init.method).toBe("POST");
	});

	it("signs the App JWT with a verifiable RS256 signature over the right claims", async () => {
		await vaultAuthHeaders(appEnv(), VAULT_URL);
		const jwt = String(lastMint!.init.headers.Authorization).replace(/^Bearer /, "");
		const [h, p, sig] = jwt.split(".");
		// The PKCS#1→PKCS#8 import + WebCrypto sign must produce a signature the
		// public half verifies — this is the real check on pkcs1ToPkcs8/importRsaKey.
		const ok = nodeVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey(publicKey), Buffer.from(sig, "base64url"));
		expect(ok).toBe(true);
		const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
		expect(claims.iss).toBe("1234567");
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600); // under GitHub's 10-min ceiling
	});

	it("caches the token in KV and reuses it (no second mint)", async () => {
		const env = appEnv();
		await vaultAuthHeaders(env, VAULT_URL);
		const again = await vaultAuthHeaders(env, VAULT_URL);
		expect(again).toEqual({ Authorization: "Bearer ghs_installtok" });
		expect(mints).toBe(1);
		expect(env.OAUTH_KV.map.get("cache:suxbot:installation-token")).toBeTruthy();
	});

	it("does not mint (or attach anything) for a non-github host", async () => {
		expect(await vaultAuthHeaders(appEnv(), "https://evil.example.com/x")).toEqual({});
		expect(mints).toBe(0);
	});

	it("falls back to the PAT when the mint fails (non-201)", async () => {
		routes.handler = () => new Response("boom", { status: 500 });
		expect(await vaultAuthHeaders(appEnv(), VAULT_URL)).toEqual({ Authorization: "Bearer pat-fallback" });
	});
});

describe("pkcs1ToPkcs8", () => {
	it("wraps a PKCS#1 key so WebCrypto can import it", async () => {
		// Strip the PKCS#1 PEM to DER, wrap to PKCS#8, and confirm importKey accepts it.
		const der = Uint8Array.from(Buffer.from(privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));
		const pkcs8 = pkcs1ToPkcs8(der);
		const key = await crypto.subtle.importKey("pkcs8", pkcs8 as unknown as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
		expect(key.type).toBe("private");
	});
});
