import { afterEach, describe, expect, it, vi } from "vitest";

import { getClientToken, mintClientToken, type OAuthClientCreds } from "./_oauth";

// The token-lifecycle helper shared by ebay/kroger/tailscale. The per-provider
// fn tests exercise it end-to-end; these lock the two axes it parameterises
// (Basic-header vs body auth, scope on/off) plus the TTL clamp and the cache read.

function kvStub(seed?: Record<string, string>) {
	const map = new Map<string, string>(Object.entries(seed ?? {}));
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = (kv = kvStub()) => ({ OAUTH_KV: kv }) as any;
const tokenResp = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("_oauth client-credentials", () => {
	it("basic auth: HTTP Basic header + scope in the body; caches with TTL = expires_in - 60", async () => {
		let seen: any = null;
		global.fetch = vi.fn(async (_u: any, init?: any) => {
			seen = init;
			return tokenResp({ access_token: "TOK", expires_in: 3600 });
		}) as any;
		const kv = kvStub();
		const o: OAuthClientCreds = { tokenUrl: "https://x/token", clientId: "id", clientSecret: "sec", cacheKey: "k", scope: "s.compact", defaultTtl: 1800 };
		const tok = await mintClientToken(env(kv), o);
		expect(tok).toBe("TOK");
		expect(seen.headers.Authorization).toBe(`Basic ${btoa("id:sec")}`);
		expect(String(seen.body)).toContain("grant_type=client_credentials");
		expect(String(seen.body)).toContain("scope=s.compact");
		expect(String(seen.body)).not.toContain("client_secret");
		expect(kv.put).toHaveBeenCalledWith("k", "TOK", { expirationTtl: 3540 });
	});

	it("body auth: client_id/secret in the body, no Authorization header, no scope", async () => {
		let seen: any = null;
		global.fetch = vi.fn(async (_u: any, init?: any) => {
			seen = init;
			return tokenResp({ access_token: "TOK", expires_in: 3600 });
		}) as any;
		const o: OAuthClientCreds = { tokenUrl: "https://x/token", clientId: "id", clientSecret: "sec", cacheKey: "k", auth: "body" };
		await mintClientToken(env(), o);
		expect(seen.headers.Authorization).toBeUndefined();
		expect(String(seen.body)).toContain("client_id=id");
		expect(String(seen.body)).toContain("client_secret=sec");
		expect(String(seen.body)).not.toContain("scope=");
	});

	it("getClientToken returns the cached token without a mint round-trip", async () => {
		const f = vi.fn();
		global.fetch = f as any;
		const tok = await getClientToken(env(kvStub({ k: "CACHED" })), { tokenUrl: "https://x/token", clientId: "id", clientSecret: "sec", cacheKey: "k" });
		expect(tok).toBe("CACHED");
		expect(f).not.toHaveBeenCalled();
	});

	it("throws on a non-ok token response and on a missing access_token", async () => {
		global.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as any;
		const o: OAuthClientCreds = { tokenUrl: "https://x/token", clientId: "id", clientSecret: "sec", cacheKey: "k" };
		await expect(mintClientToken(env(), o)).rejects.toThrow(/OAuth token HTTP 401/);
		global.fetch = vi.fn(async () => tokenResp({ token_type: "Bearer" })) as any;
		await expect(mintClientToken(env(), o)).rejects.toThrow(/no access_token/);
	});
});
