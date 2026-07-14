import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAccessJwt } from "./access-jwt";

const TEAM_DOMAIN = "https://sux-team.cloudflareaccess.com";
const AUD = "test-aud-tag";

function base64UrlEncode(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(obj: unknown): string {
	return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function generateKeyPairAndJwk() {
	const keyPair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
	return { privateKey: keyPair.privateKey, jwk: { kid: "test-kid", kty: jwk.kty!, n: jwk.n!, e: jwk.e! } };
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
	const header = { alg: "RS256", typ: "JWT", kid };
	const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput));
	return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function req(token?: string): Request {
	const headers: Record<string, string> = token ? { "Cf-Access-Jwt-Assertion": token } : {};
	return new Request("https://sux.test/dashboard", { headers });
}

afterEach(() => vi.restoreAllMocks());

describe("verifyAccessJwt", () => {
	it("fails closed when CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD aren't configured", async () => {
		expect(await verifyAccessJwt(req("anything"), {} as any)).toBe(false);
		expect(await verifyAccessJwt(req("anything"), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN } as any)).toBe(false);
	});

	it("fails closed when the header is missing", async () => {
		expect(await verifyAccessJwt(req(), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});

	it("fails closed on a malformed token", async () => {
		expect(await verifyAccessJwt(req("not-a-jwt"), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});

	it("accepts a validly signed, unexpired token whose aud matches, verified against the team's JWKS", async () => {
		const { privateKey, jwk } = await generateKeyPairAndJwk();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				expect(url).toBe(`${TEAM_DOMAIN}/cdn-cgi/access/certs`);
				return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
			}),
		);
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(privateKey, jwk.kid, { aud: [AUD], exp: now + 3600, nbf: now - 60, email: "colin@example.com" });

		const env = { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any;
		expect(await verifyAccessJwt(req(token), env)).toBe(true);
	});

	it("rejects a validly signed token with the wrong audience", async () => {
		const { privateKey, jwk } = await generateKeyPairAndJwk();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(privateKey, jwk.kid, { aud: ["someone-elses-app"], exp: now + 3600 });

		expect(await verifyAccessJwt(req(token), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});

	it("rejects an expired token", async () => {
		const { privateKey, jwk } = await generateKeyPairAndJwk();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(privateKey, jwk.kid, { aud: [AUD], exp: now - 60 });

		expect(await verifyAccessJwt(req(token), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});

	it("rejects a token signed by a key not present in the team's JWKS (forged/unknown kid)", async () => {
		const { privateKey } = await generateKeyPairAndJwk();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })));
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(privateKey, "unknown-kid", { aud: [AUD], exp: now + 3600 });

		expect(await verifyAccessJwt(req(token), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});

	it("rejects a token whose signature doesn't match its payload (tampered claims)", async () => {
		const { privateKey, jwk } = await generateKeyPairAndJwk();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(privateKey, jwk.kid, { aud: [AUD], exp: now + 3600 });
		const [h, p, s] = token.split(".");
		const tamperedPayload = base64UrlEncodeJson({ aud: [AUD], exp: now + 3600 * 24 * 365 });
		const tampered = `${h}.${tamperedPayload}.${s}`;

		expect(await verifyAccessJwt(req(tampered), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});

	it("fails closed when the certs fetch fails", async () => {
		const { privateKey, jwk } = await generateKeyPairAndJwk();
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(privateKey, jwk.kid, { aud: [AUD], exp: now + 3600 });

		expect(await verifyAccessJwt(req(token), { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD } as any)).toBe(false);
	});
});
