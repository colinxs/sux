import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSuxbotApp, pkcs1ToPkcs8, suxbotInstallationToken, vaultAuthHeaders } from "./github-app";

// ── DER/PEM helpers (test-only) ────────────────────────────────────────────────
function readTlv(buf: Uint8Array, off: number): { contentStart: number; contentEnd: number; end: number } {
	let len = buf[off + 1];
	let hlen = 2;
	if (len & 0x80) {
		const n = len & 0x7f;
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
		hlen = 2 + n;
	}
	return { contentStart: off + hlen, contentEnd: off + hlen + len, end: off + hlen + len };
}

/** Extract the inner PKCS#1 key (the OCTET STRING content) from a PKCS#8 DER. */
function unwrapPkcs8(pkcs8: Uint8Array): Uint8Array {
	const outer = readTlv(pkcs8, 0);
	let off = outer.contentStart;
	off = readTlv(pkcs8, off).end; // version
	off = readTlv(pkcs8, off).end; // algorithm id
	const key = readTlv(pkcs8, off); // OCTET STRING
	return pkcs8.slice(key.contentStart, key.contentEnd);
}

function toPem(der: Uint8Array, label: string): string {
	let b64 = "";
	for (let i = 0; i < der.length; i++) b64 += String.fromCharCode(der[i]);
	b64 = btoa(b64);
	const lines = b64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function b64urlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function genRsa(): Promise<{ pkcs1Pem: string; pkcs8Pem: string; pkcs1: Uint8Array; pkcs8: Uint8Array; publicKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	const pkcs1 = unwrapPkcs8(pkcs8);
	return { pkcs1Pem: toPem(pkcs1, "RSA PRIVATE KEY"), pkcs8Pem: toPem(pkcs8, "PRIVATE KEY"), pkcs1, pkcs8, publicKey: pair.publicKey };
}

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => {
			store.set(k, v);
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("hasSuxbotApp", () => {
	it("requires all three App secrets", () => {
		expect(hasSuxbotApp({})).toBe(false);
		expect(hasSuxbotApp({ SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: "k" })).toBe(false);
		expect(hasSuxbotApp({ SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: "k", SUX_BOT_INSTALLATION_ID: "9" })).toBe(true);
	});
});

describe("pkcs1ToPkcs8", () => {
	it("reconstructs the exact PKCS#8 envelope WebCrypto emits", async () => {
		const { pkcs1, pkcs8 } = await genRsa();
		expect(pkcs1ToPkcs8(pkcs1)).toEqual(pkcs8);
	});

	it("produces a DER WebCrypto can import and sign with", async () => {
		const { pkcs1 } = await genRsa();
		const key = await crypto.subtle.importKey("pkcs8", pkcs1ToPkcs8(pkcs1) as unknown as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
		const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode("hello"));
		expect(sig.byteLength).toBe(256);
	});
});

describe("vaultAuthHeaders (fallback precedence)", () => {
	it("returns {} for a non-GitHub host even with a token", async () => {
		expect(await vaultAuthHeaders({ GITHUB_TOKEN: "pat" }, "https://example.com/x")).toEqual({});
	});
	it("falls back to GITHUB_TOKEN when the App is not configured", async () => {
		expect(await vaultAuthHeaders({ GITHUB_TOKEN: "pat" }, "https://api.github.com/repos/o/r/contents/x")).toEqual({ Authorization: "Bearer pat" });
	});
	it("returns {} when neither the App nor GITHUB_TOKEN is set", async () => {
		expect(await vaultAuthHeaders({}, "https://api.github.com/repos/o/r/contents/x")).toEqual({});
	});
});

describe("suxbotInstallationToken", () => {
	it("returns null (no mint) when App secrets are absent", async () => {
		const spy = vi.spyOn(globalThis, "fetch");
		expect(await suxbotInstallationToken({ GITHUB_TOKEN: "pat" })).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});

	it("mints an installation token with a valid RS256 App JWT (PKCS#1 key)", async () => {
		const { pkcs1Pem, publicKey } = await genRsa();
		const kv = fakeKv();
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ token: "ghs_minted", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201, headers: { "content-type": "application/json" } }));
		const env = { SUX_BOT_APP_ID: "12345", SUX_BOT_PRIVATE_KEY: pkcs1Pem, SUX_BOT_INSTALLATION_ID: "146421817", OAUTH_KV: kv };

		const tok = await suxbotInstallationToken(env);
		expect(tok).toBe("ghs_minted");
		expect(spy).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = spy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
		expect(calledUrl).toContain("/app/installations/146421817/access_tokens");
		expect(init.method).toBe("POST");

		const auth = init.headers.Authorization;
		expect(auth).toMatch(/^Bearer /);
		const jwt = auth.slice("Bearer ".length);
		const [h, p, s] = jwt.split(".");
		const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
		const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });
		expect(payload.iss).toBe("12345");
		expect(payload.exp).toBeGreaterThan(payload.iat);
		const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlToBytes(s) as unknown as ArrayBuffer, new TextEncoder().encode(`${h}.${p}`));
		expect(verified).toBe(true);
	});

	it("reuses the KV-cached token without re-minting until near expiry", async () => {
		const { pkcs1Pem } = await genRsa();
		const kv = fakeKv();
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ token: "ghs_first", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201, headers: { "content-type": "application/json" } }));
		const env = { SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: pkcs1Pem, SUX_BOT_INSTALLATION_ID: "9", OAUTH_KV: kv };

		expect(await suxbotInstallationToken(env)).toBe("ghs_first");
		expect(await suxbotInstallationToken(env)).toBe("ghs_first");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("re-mints when the cached token is within the expiry skew", async () => {
		const { pkcs1Pem } = await genRsa();
		const kv = fakeKv();
		kv.store.set("cache:suxbot:installation-token", JSON.stringify({ token: "ghs_stale", exp: Date.now() + 30_000 }));
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ token: "ghs_fresh", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201, headers: { "content-type": "application/json" } }));
		const env = { SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: pkcs1Pem, SUX_BOT_INSTALLATION_ID: "9", OAUTH_KV: kv };

		expect(await suxbotInstallationToken(env)).toBe("ghs_fresh");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("returns null when the token endpoint does not return 201", async () => {
		const { pkcs1Pem } = await genRsa();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 403 }));
		const env = { SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: pkcs1Pem, SUX_BOT_INSTALLATION_ID: "9", OAUTH_KV: fakeKv() };
		expect(await suxbotInstallationToken(env)).toBeNull();
	});

	it("prefers the minted App token over GITHUB_TOKEN in vaultAuthHeaders", async () => {
		const { pkcs1Pem } = await genRsa();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ token: "ghs_app", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201, headers: { "content-type": "application/json" } }));
		const env = { SUX_BOT_APP_ID: "1", SUX_BOT_PRIVATE_KEY: pkcs1Pem, SUX_BOT_INSTALLATION_ID: "9", GITHUB_TOKEN: "pat", OAUTH_KV: fakeKv() };
		expect(await vaultAuthHeaders(env, "https://api.github.com/repos/SuxOS/vault/contents/x")).toEqual({ Authorization: "Bearer ghs_app" });
	});
});
