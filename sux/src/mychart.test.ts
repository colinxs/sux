import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleAppleHealth,
	handleMychartRoutes,
	isUnderFhirBase,
	jwtMode,
	makeClientAssertion,
	mintAccessToken,
	mychartConfigured,
	mychartConnected,
	mychartFetch,
	publicJwk,
	readDcrGrant,
	readGrant,
	resolveFhirPath,
} from "./mychart";
import { handleObservability } from "./observability";

const BASE = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";
const AUTHZ = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize";
const TOKEN = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
const REGISTER = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/register";

// Generate a throwaway RSA keypair and return its private key as a PKCS#8 PEM — the
// same shape EPIC_JWT_PRIVATE_KEY takes. No key material is hardcoded in the repo.
async function genPrivateKeyPem(): Promise<string> {
	const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
	let bin = "";
	for (let i = 0; i < der.length; i++) bin += String.fromCharCode(der[i]);
	const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
	return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

const b64urlToBytes = (s: string): Uint8Array => {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};
const decodeJwtPart = (part: string): any => JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));

const smartCfgWithRegister = () => new Response(JSON.stringify({ authorization_endpoint: AUTHZ, token_endpoint: TOKEN, registration_endpoint: REGISTER }), { status: 200 });

function kvStub() {
	const map = new Map<string, string>();
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => {
			map.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			map.delete(k);
		}),
	};
}

function r2Stub() {
	const map = new Map<string, { body: any; contentType?: string }>();
	return {
		map,
		put: vi.fn(async (key: string, body: any, opts?: any) => {
			map.set(key, { body, contentType: opts?.httpMetadata?.contentType });
		}),
		get: vi.fn(async (key: string) => {
			const o = map.get(key);
			if (!o) return null;
			const bytes = typeof o.body === "string" ? new TextEncoder().encode(o.body) : new Uint8Array(o.body);
			return { size: bytes.length, httpMetadata: { contentType: o.contentType }, arrayBuffer: async () => bytes.buffer, text: async () => new TextDecoder().decode(bytes) };
		}),
	};
}

const baseEnv = (over: Record<string, unknown> = {}) =>
	({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", EPIC_FHIR_BASE: BASE, OAUTH_KV: kvStub(), R2: r2Stub(), ...over }) as any;

const smartCfgResponse = () => new Response(JSON.stringify({ authorization_endpoint: AUTHZ, token_endpoint: TOKEN }), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe("mychart FHIR base validation", () => {
	it("isUnderFhirBase accepts on-base URLs and rejects origin/path escapes", () => {
		const env = baseEnv();
		expect(isUnderFhirBase(env, `${BASE}/Observation?patient=1`)).toBe(true);
		expect(isUnderFhirBase(env, `${BASE}`)).toBe(true);
		expect(isUnderFhirBase(env, "https://evil.com/interconnect-fhir-oauth/api/FHIR/R4/Observation")).toBe(false);
		// prefix that isn't a path-segment boundary must not match
		expect(isUnderFhirBase(env, "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4x/Observation")).toBe(false);
	});

	it("resolveFhirPath resolves relative paths and refuses escapes", () => {
		const env = baseEnv();
		expect(resolveFhirPath(env, "Observation?category=laboratory")).toBe(`${BASE}/Observation?category=laboratory`);
		expect(resolveFhirPath(env, "https://evil.com/x")).toBeNull();
		expect(resolveFhirPath(env, "")).toBeNull();
	});
});

describe("mychart OAuth callback (PKCE round-trip)", () => {
	it("exchanges code+verifier, persists the grant, caches the access token", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:mychart:pkce:STATE1", JSON.stringify({ verifier: "VERIFIER123", created: Date.now() }));
		const seen: any = {};
		vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
			if (url === TOKEN) {
				seen.body = init.body;
				seen.auth = init.headers.Authorization;
				return new Response(JSON.stringify({ access_token: "AT1", refresh_token: "RT1", patient: "PatientA", scope: "patient/*.read", expires_in: 3600 }), { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		}));
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/callback?code=CODE1&state=STATE1"), new Request("https://suxos.net/mychart/callback?code=CODE1&state=STATE1"), env);
		expect(resp?.status).toBe(200);
		expect(await resp!.text()).toContain("MyChart connected");
		expect(seen.body).toContain("grant_type=authorization_code");
		expect(seen.body).toContain("code_verifier=VERIFIER123");
		expect(seen.auth).toBe(`Basic ${btoa("cid:csec")}`);
		const grant = await readGrant(env);
		expect(grant).toMatchObject({ refresh_token: "RT1", patient: "PatientA", scope: "patient/*.read" });
		expect(env.OAUTH_KV.map.get("sux:mychart:token")).toBe("AT1");
		// one-time state consumed
		expect(env.OAUTH_KV.map.has("sux:mychart:pkce:STATE1")).toBe(false);
	});

	it("refuses an unknown/expired state (CSRF check)", async () => {
		const env = baseEnv();
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/callback?code=X&state=NOPE"), new Request("https://suxos.net/mychart/callback?code=X&state=NOPE"), env);
		expect(resp?.status).toBe(400);
		expect(await resp!.text()).toMatch(/CSRF/i);
	});
});

describe("mychart /connect gate", () => {
	it("404s when the operator token is unset, 401 on mismatch, 302 with S256 when correct", async () => {
		const noGate = baseEnv();
		expect((await handleMychartRoutes(new URL("https://suxos.net/mychart/connect"), new Request("https://suxos.net/mychart/connect"), noGate))?.status).toBe(404);

		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		expect((await handleMychartRoutes(new URL("https://suxos.net/mychart/connect?token=wrong"), new Request("https://suxos.net/mychart/connect?token=wrong"), env))?.status).toBe(401);

		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			if (String(u).includes(".well-known/smart-configuration")) return smartCfgResponse();
			throw new Error("no other fetch");
		}));
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/connect?token=op-secret"), new Request("https://suxos.net/mychart/connect?token=op-secret"), env);
		expect(resp?.status).toBe(302);
		const loc = new URL(resp!.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe(AUTHZ);
		expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
		expect(loc.searchParams.get("aud")).toBe(BASE);
		expect(loc.searchParams.get("redirect_uri")).toBe("https://suxos.net/mychart/callback");
		const state = loc.searchParams.get("state")!;
		expect(env.OAUTH_KV.map.has(`sux:mychart:pkce:${state}`)).toBe(true);
	});
});

describe("mychart token lifecycle (mint / rotate / 401 self-heal)", () => {
	it("mints from the refresh grant, caches the access token, persists a ROTATED refresh token", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:mychart:grant", JSON.stringify({ refresh_token: "OLD_RT", patient: "P", issued_at: 1 }));
		vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
			if (url === TOKEN) {
				expect(String(init.body)).toContain("grant_type=refresh_token");
				expect(String(init.body)).toContain("refresh_token=OLD_RT");
				return new Response(JSON.stringify({ access_token: "AT2", refresh_token: "NEW_RT", expires_in: 3600 }), { status: 200 });
			}
			throw new Error(`unexpected ${url}`);
		}));
		const tok = await mintAccessToken(env);
		expect(tok).toBe("AT2");
		expect(env.OAUTH_KV.map.get("sux:mychart:token")).toBe("AT2");
		expect(JSON.parse(env.OAUTH_KV.map.get("sux:mychart:grant")!).refresh_token).toBe("NEW_RT");
	});

	it("keeps the old refresh token when the response doesn't rotate it", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:mychart:grant", JSON.stringify({ refresh_token: "KEEP_RT", patient: "P", issued_at: 1 }));
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			if (String(u).includes(".well-known/smart-configuration")) return smartCfgResponse();
			return new Response(JSON.stringify({ access_token: "AT3", expires_in: 3600 }), { status: 200 });
		}));
		await mintAccessToken(env);
		expect(JSON.parse(env.OAUTH_KV.map.get("sux:mychart:grant")!).refresh_token).toBe("KEEP_RT");
	});

	it("mychartFetch drops the cached token and re-mints once on a 401", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:mychart:grant", JSON.stringify({ refresh_token: "RT", patient: "P", issued_at: 1 }));
		await env.OAUTH_KV.put("sux:mychart:token", "STALE_AT");
		let minted = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
			if (url === TOKEN) {
				minted++;
				return new Response(JSON.stringify({ access_token: "FRESH_AT", expires_in: 3600 }), { status: 200 });
			}
			// The FHIR resource: 401 with the stale token, 200 with the fresh one.
			const bearer = init.headers.Authorization;
			if (bearer === "Bearer STALE_AT") return new Response("unauthorized", { status: 401 });
			return new Response(JSON.stringify({ resourceType: "Patient", id: "P" }), { status: 200 });
		}));
		const resp = await mychartFetch(env, `${BASE}/Patient/P`);
		expect(resp.status).toBe(200);
		expect(minted).toBe(1);
		expect(env.OAUTH_KV.map.get("sux:mychart:token")).toBe("FRESH_AT");
	});
});

describe("apple-health ingest", () => {
	const post = (env: any, headers: Record<string, string>, body = '{"data":{"metrics":[]}}') =>
		handleAppleHealth(new URL("https://suxos.net/apple-health"), new Request("https://suxos.net/apple-health", { method: "POST", headers, body }), env);

	it("404s when HEALTH_INGEST_TOKEN is unset (feature off)", async () => {
		const resp = await post(baseEnv(), { authorization: "Bearer x" });
		expect(resp?.status).toBe(404);
	});

	it("401s on a wrong/missing bearer", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		expect((await post(env, {}))?.status).toBe(401);
		expect((await post(env, { authorization: "Bearer nope" }))?.status).toBe(401);
	});

	it("accepts a valid POST, writes under phi/, and a re-POST is an idempotent upsert", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		const headers = { authorization: "Bearer secret", "x-automation-id": "auto1", "x-period": "2026-07-13" };
		const r1 = await post(env, headers);
		expect(r1?.status).toBe(200);
		const body1 = JSON.parse(await r1!.text());
		expect(body1.ok).toBe(true);
		expect(body1.key.startsWith("phi/apple-health/")).toBe(true);
		expect(env.R2.map.size).toBe(1);
		// Same automation-id + period ⇒ same key ⇒ one object, not two.
		const r2 = await post(env, headers);
		expect(JSON.parse(await r2!.text()).key).toBe(body1.key);
		expect(env.R2.map.size).toBe(1);
	});

	it("rejects a non-POST method", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		const resp = await handleAppleHealth(new URL("https://suxos.net/apple-health"), new Request("https://suxos.net/apple-health", { method: "GET" }), env);
		expect(resp?.status).toBe(405);
	});
});

describe("PHI gate: /s/ handler refuses phi/ keys", () => {
	it("404s a store handle that resolves to the private phi/ prefix", async () => {
		const kv = kvStub();
		const r2 = r2Stub();
		await r2.put("phi/mychart/P/Patient/x.json", '{"resourceType":"Patient"}', { httpMetadata: { contentType: "application/fhir+json" } });
		await kv.put("store:11111111-1111-1111-1111-111111111111", JSON.stringify({ key: "phi/mychart/P/Patient/x.json", content_type: "application/fhir+json" }));
		const env = { OAUTH_KV: kv, R2: r2 } as any;
		const resp = await handleObservability(new URL("https://suxos.net/s/11111111-1111-1111-1111-111111111111"), new Request("https://suxos.net/s/11111111-1111-1111-1111-111111111111"), env);
		expect(resp?.status).toBe(404);
	});
});

describe("mychart auth-mode selection", () => {
	it("jwtMode + configured reflect which secrets are present", async () => {
		const pem = await genPrivateKeyPem();
		// refresh mode: secret present, no private key
		expect(jwtMode(baseEnv())).toBe(false);
		expect(mychartConfigured(baseEnv())).toBe(true);
		// jwt mode: private key present (no client secret needed)
		const jwtEnv = baseEnv({ EPIC_CLIENT_SECRET: undefined, EPIC_JWT_PRIVATE_KEY: pem });
		expect(jwtMode(jwtEnv)).toBe(true);
		expect(mychartConfigured(jwtEnv)).toBe(true);
		// unconfigured: no auth method at all
		expect(mychartConfigured(baseEnv({ EPIC_CLIENT_SECRET: undefined }))).toBe(false);
	});
});

describe("mychart jwt-bearer client assertion", () => {
	it("builds a well-formed, correctly-signed RS384 assertion (WebCrypto)", async () => {
		const pem = await genPrivateKeyPem();
		const env = baseEnv({ EPIC_CLIENT_SECRET: undefined, EPIC_JWT_PRIVATE_KEY: pem });
		const jwt = await makeClientAssertion(env, "the-client-id", TOKEN);
		const [h, c, s] = jwt.split(".");
		const header = decodeJwtPart(h);
		const claims = decodeJwtPart(c);
		expect(header).toMatchObject({ alg: "RS384", typ: "JWT" });
		expect(typeof header.kid).toBe("string");
		expect(header.kid.length).toBeGreaterThan(0);
		expect(claims.iss).toBe("the-client-id");
		expect(claims.sub).toBe("the-client-id");
		expect(claims.aud).toBe(TOKEN);
		expect(typeof claims.jti).toBe("string");
		const now = Math.floor(Date.now() / 1000);
		expect(claims.exp).toBeGreaterThan(now);
		expect(claims.exp - now).toBeLessThanOrEqual(300); // ≤5 min per SMART
		// Signature verifies against the derived public JWK.
		const pub = await publicJwk(env);
		const verifyKey = await crypto.subtle.importKey("jwk", { kty: pub.kty, n: pub.n, e: pub.e, alg: "RS384" } as any, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, false, ["verify"]);
		const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, verifyKey, b64urlToBytes(s), new TextEncoder().encode(`${h}.${c}`));
		expect(ok).toBe(true);
	});
});

describe("mychart DCR registration on callback", () => {
	it("exchanges the code (no Basic auth), registers the public key, persists a DCR grant", async () => {
		const pem = await genPrivateKeyPem();
		const env = baseEnv({ EPIC_CLIENT_SECRET: undefined, EPIC_JWT_PRIVATE_KEY: pem });
		await env.OAUTH_KV.put("sux:mychart:pkce:ST", JSON.stringify({ verifier: "VER", created: Date.now() }));
		const seen: any = {};
		vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfgWithRegister();
			if (url === TOKEN) {
				seen.tokenAuth = init.headers.Authorization;
				return new Response(JSON.stringify({ access_token: "AT_INIT", patient: "PatB", scope: "patient/*.rs", expires_in: 3600 }), { status: 200 });
			}
			if (url === REGISTER) {
				seen.regAuth = init.headers.Authorization;
				seen.regBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ client_id: "DYN-CLIENT-1" }), { status: 201 });
			}
			throw new Error(`unexpected fetch ${url}`);
		}));
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/callback?code=C&state=ST"), new Request("https://suxos.net/mychart/callback?code=C&state=ST"), env);
		expect(resp?.status).toBe(200);
		expect(await resp!.text()).toContain("DYN-CLIENT-1");
		// jwt mode ⇒ code exchange carries NO Basic auth header
		expect(seen.tokenAuth).toBeUndefined();
		// registration authed with the interactive access token + our JWKS
		expect(seen.regAuth).toBe("Bearer AT_INIT");
		expect(seen.regBody.jwks.keys[0].kty).toBe("RSA");
		const dcr = await readDcrGrant(env);
		expect(dcr).toMatchObject({ client_id: "DYN-CLIENT-1", patient: "PatB", scope: "patient/*.rs" });
		expect(await mychartConnected(env)).toBe(true);
		expect(await readGrant(env)).toBeNull(); // no refresh grant in jwt mode
	});
});

describe("mychart jwt-bearer token mint + 401 self-heal", () => {
	it("mints via client_credentials + client_assertion using the DCR client id, caches AT", async () => {
		const pem = await genPrivateKeyPem();
		const env = baseEnv({ EPIC_CLIENT_SECRET: undefined, EPIC_JWT_PRIVATE_KEY: pem });
		await env.OAUTH_KV.put("sux:mychart:dcr", JSON.stringify({ client_id: "DYN-1", patient: "P", scope: "patient/*.rs", issued_at: 1 }));
		const seen: any = {};
		vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfgWithRegister();
			if (url === TOKEN) {
				seen.body = String(init.body);
				seen.auth = init.headers.Authorization;
				return new Response(JSON.stringify({ access_token: "JWT_AT", expires_in: 3600 }), { status: 200 });
			}
			throw new Error(`unexpected ${url}`);
		}));
		const tok = await mintAccessToken(env);
		expect(tok).toBe("JWT_AT");
		expect(seen.auth).toBeUndefined(); // no Basic auth in jwt mode
		expect(seen.body).toContain("grant_type=client_credentials");
		expect(seen.body).toContain("client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer");
		expect(seen.body).toContain("client_assertion=");
		// the signed assertion's iss/sub is the DCR client id, not EPIC_CLIENT_ID
		const params = new URLSearchParams(seen.body);
		const claims = decodeJwtPart(params.get("client_assertion")!.split(".")[1]);
		expect(claims.iss).toBe("DYN-1");
		expect(env.OAUTH_KV.map.get("sux:mychart:token")).toBe("JWT_AT");
	});

	it("mychartFetch drops the cached token and re-mints once on a 401 (jwt mode)", async () => {
		const pem = await genPrivateKeyPem();
		const env = baseEnv({ EPIC_CLIENT_SECRET: undefined, EPIC_JWT_PRIVATE_KEY: pem });
		await env.OAUTH_KV.put("sux:mychart:dcr", JSON.stringify({ client_id: "DYN-1", patient: "P", issued_at: 1 }));
		await env.OAUTH_KV.put("sux:mychart:token", "STALE");
		let minted = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: any, init?: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfgWithRegister();
			if (url === TOKEN) {
				minted++;
				return new Response(JSON.stringify({ access_token: "FRESH", expires_in: 3600 }), { status: 200 });
			}
			return init.headers.Authorization === "Bearer STALE" ? new Response("unauthorized", { status: 401 }) : new Response(JSON.stringify({ resourceType: "Patient" }), { status: 200 });
		}));
		const resp = await mychartFetch(env, `${BASE}/Patient/P`);
		expect(resp.status).toBe(200);
		expect(minted).toBe(1);
		expect(env.OAUTH_KV.map.get("sux:mychart:token")).toBe("FRESH");
	});
});
