import { afterEach, describe, expect, it, vi } from "vitest";
import {
	consensusConnected,
	consensusRedirectUri,
	ensureConsensusClient,
	handleConsensusRoutes,
	mintConsensusAccessToken,
	readConsensusGrant,
} from "./consensus";
import { challengeFor, makeVerifier } from "./mychart";

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

const GATE = "operator-secret";
const baseEnv = (over: Record<string, unknown> = {}) => ({ SUX_CRON_TOKEN: GATE, OAUTH_KV: kvStub(), ...over }) as any;

const fetchRouter =
	(handlers: Record<string, () => Response>) =>
	async (u: any, init?: any): Promise<Response> => {
		const url = String(u);
		for (const [match, handler] of Object.entries(handlers)) {
			if (url.includes(match)) return handler();
		}
		throw new Error(`unexpected fetch ${url} ${init ? JSON.stringify(init.body ?? "") : ""}`);
	};

const registerResponse = () => new Response(JSON.stringify({ client_id: "reg-client-123" }), { status: 200 });
const tokenResponse = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "search", ...over }), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe("PKCE challenge generation (shared with mychart)", () => {
	it("S256 challenge is the base64url SHA-256 of the verifier — deterministic, url-safe, unpadded", async () => {
		const verifier = makeVerifier();
		const challenge = await challengeFor(verifier);
		expect(challenge).toBe(await challengeFor(verifier)); // stable
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no + / =
		// a different verifier yields a different challenge
		expect(await challengeFor(makeVerifier())).not.toBe(challenge);
	});
});

describe("dynamic client registration", () => {
	it("registers once and caches the client_id in KV (public client — no secret)", async () => {
		const env = baseEnv();
		const spy = vi.fn(fetchRouter({ "/oauth/register/": registerResponse }));
		vi.stubGlobal("fetch", spy);
		expect(await ensureConsensusClient(env)).toBe("reg-client-123");
		// second call reads the cached client_id — no second registration POST
		expect(await ensureConsensusClient(env)).toBe("reg-client-123");
		expect(spy).toHaveBeenCalledTimes(1);
		const stored = JSON.parse(env.OAUTH_KV.map.get("sux:consensus:client"));
		expect(stored.client_id).toBe("reg-client-123");
	});

	it("sends the callback redirect_uri and 'none' auth method in the registration body", async () => {
		const env = baseEnv();
		const spy = vi.fn(fetchRouter({ "/oauth/register/": registerResponse }));
		vi.stubGlobal("fetch", spy);
		await ensureConsensusClient(env);
		const body = JSON.parse(spy.mock.calls[0][1].body);
		expect(body.redirect_uris).toEqual([consensusRedirectUri(env)]);
		expect(body.token_endpoint_auth_method).toBe("none");
		expect(body.grant_types).toContain("refresh_token");
	});
});

describe("token refresh path", () => {
	it("mints an access token from the stored grant with NO Authorization header (public client)", async () => {
		const env = baseEnv();
		env.OAUTH_KV.map.set("sux:consensus:client", JSON.stringify({ client_id: "cid" }));
		env.OAUTH_KV.map.set("sux:consensus:grant", JSON.stringify({ refresh_token: "rt-old", issued_at: 1 }));
		const spy = vi.fn(fetchRouter({ "/oauth/token/": () => tokenResponse() }));
		vi.stubGlobal("fetch", spy);
		const token = await mintConsensusAccessToken(env);
		expect(token).toBe("at-1");
		const init = spy.mock.calls[0][1];
		expect(init.headers.Authorization).toBeUndefined();
		expect(String(init.body)).toContain("grant_type=refresh_token");
		expect(String(init.body)).toContain("client_id=cid");
		// access token cached
		expect(env.OAUTH_KV.map.get("sux:consensus:token")).toBe("at-1");
	});

	it("persists a rotated refresh_token back to the grant", async () => {
		const env = baseEnv();
		env.OAUTH_KV.map.set("sux:consensus:client", JSON.stringify({ client_id: "cid" }));
		env.OAUTH_KV.map.set("sux:consensus:grant", JSON.stringify({ refresh_token: "rt-old", issued_at: 1 }));
		vi.stubGlobal("fetch", vi.fn(fetchRouter({ "/oauth/token/": () => tokenResponse({ refresh_token: "rt-new" }) })));
		await mintConsensusAccessToken(env);
		const grant = await readConsensusGrant(env);
		expect(grant?.refresh_token).toBe("rt-new");
	});

	it("throws not-connected when no grant exists", async () => {
		const env = baseEnv();
		await expect(mintConsensusAccessToken(env)).rejects.toThrow(/not connected/i);
	});

	it("surfaces the OAuth error code (not free-text) on a refused refresh", async () => {
		const env = baseEnv();
		env.OAUTH_KV.map.set("sux:consensus:client", JSON.stringify({ client_id: "cid" }));
		env.OAUTH_KV.map.set("sux:consensus:grant", JSON.stringify({ refresh_token: "rt-old", issued_at: 1 }));
		vi.stubGlobal("fetch", vi.fn(fetchRouter({ "/oauth/token/": () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret leak" }), { status: 400 }) })));
		await expect(mintConsensusAccessToken(env)).rejects.toThrow(/invalid_grant/);
		await expect(mintConsensusAccessToken(env)).rejects.not.toThrow(/secret leak/);
	});
});

describe("consensusConnected", () => {
	it("false with no grant, true once a refresh grant is stored", async () => {
		const env = baseEnv();
		expect(await consensusConnected(env)).toBe(false);
		env.OAUTH_KV.map.set("sux:consensus:grant", JSON.stringify({ refresh_token: "rt", issued_at: 1 }));
		expect(await consensusConnected(env)).toBe(true);
	});
});

describe("routes: /consensus/connect", () => {
	const connect = (env: any, auth?: string) =>
		handleConsensusRoutes(new URL("https://suxos.net/consensus/connect"), new Request("https://suxos.net/consensus/connect", auth ? { headers: { authorization: auth } } : {}), env);

	it("404s when the operator gate secret is unset", async () => {
		const r = await connect(baseEnv({ SUX_CRON_TOKEN: undefined }));
		expect(r?.status).toBe(404);
	});

	it("401s without a matching operator bearer", async () => {
		expect((await connect(baseEnv()))?.status).toBe(401);
		expect((await connect(baseEnv(), "Bearer wrong"))?.status).toBe(401);
	});

	it("302s to the PKCE authorize URL and stashes the verifier in KV", async () => {
		const env = baseEnv();
		vi.stubGlobal("fetch", vi.fn(fetchRouter({ "/oauth/register/": registerResponse })));
		const r = await connect(env, `Bearer ${GATE}`);
		expect(r?.status).toBe(302);
		const loc = new URL(r!.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe("https://consensus.app/oauth/authorize/");
		expect(loc.searchParams.get("response_type")).toBe("code");
		expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
		expect(loc.searchParams.get("scope")).toBe("search");
		expect(loc.searchParams.get("client_id")).toBe("reg-client-123");
		expect(loc.searchParams.get("redirect_uri")).toBe("https://suxos.net/consensus/callback");
		const state = loc.searchParams.get("state")!;
		const stashed = JSON.parse(env.OAUTH_KV.map.get(`sux:consensus:pkce:${state}`));
		expect(stashed.verifier).toBeTruthy();
		// the challenge on the URL is the S256 of the stashed verifier
		expect(loc.searchParams.get("code_challenge")).toBe(await challengeFor(stashed.verifier));
	});

	it("returns null for an unrelated path", async () => {
		expect(await handleConsensusRoutes(new URL("https://suxos.net/other"), new Request("https://suxos.net/other"), baseEnv())).toBeNull();
	});
});

describe("routes: /consensus/callback", () => {
	const callback = (env: any, qs: string) =>
		handleConsensusRoutes(new URL(`https://suxos.net/consensus/callback${qs}`), new Request(`https://suxos.net/consensus/callback${qs}`), env);

	it("exchanges the code, stores the grant + access token, and returns the success page", async () => {
		const env = baseEnv();
		env.OAUTH_KV.map.set("sux:consensus:client", JSON.stringify({ client_id: "cid" }));
		env.OAUTH_KV.map.set("sux:consensus:pkce:st8", JSON.stringify({ verifier: "the-verifier", created: 1 }));
		const spy = vi.fn(fetchRouter({ "/oauth/token/": () => tokenResponse() }));
		vi.stubGlobal("fetch", spy);
		const r = await callback(env, "?code=abc&state=st8");
		expect(r?.status).toBe(200);
		expect(await r!.text()).toMatch(/Consensus connected/);
		// authorization_code grant with the PKCE verifier, no secret
		const body = String(spy.mock.calls[0][1].body);
		expect(body).toContain("grant_type=authorization_code");
		expect(body).toContain("code_verifier=the-verifier");
		expect(spy.mock.calls[0][1].headers.Authorization).toBeUndefined();
		expect((await readConsensusGrant(env))?.refresh_token).toBe("rt-1");
		expect(env.OAUTH_KV.map.get("sux:consensus:token")).toBe("at-1");
		// the one-time PKCE state is consumed
		expect(env.OAUTH_KV.map.has("sux:consensus:pkce:st8")).toBe(false);
	});

	it("400s a CSRF mismatch (unknown state)", async () => {
		const r = await callback(baseEnv(), "?code=abc&state=unknown");
		expect(r?.status).toBe(400);
		expect(await r!.text()).toMatch(/CSRF/);
	});

	it("400s an upstream authorization error and never renders it as HTML", async () => {
		const r = await callback(baseEnv(), "?error=access_denied");
		expect(r?.status).toBe(400);
		expect(r!.headers.get("content-type")).toMatch(/text\/plain/);
	});
});
