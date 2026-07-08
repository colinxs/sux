import { afterEach, describe, expect, it, vi } from "vitest";

import { tailscale } from "./tailscale";

// Map-backed KV stub (env.OAUTH_KV) — mirrors the KVNamespace surface tailscale uses.
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEVICES = {
	devices: [
		{
			id: "n1",
			name: "laptop.tail1234.ts.net",
			hostname: "laptop",
			addresses: ["100.64.0.1", "fd7a::1"],
			os: "macOS",
			clientVersion: "1.62.0",
			lastSeen: "2026-07-01T12:00:00Z",
			online: true,
			tags: ["tag:home"],
			// A field we deliberately do NOT surface — proves the normalizer allowlists.
			nodeKey: "nodekey:secret",
		},
	],
};

const KEYS = {
	keys: [
		{
			id: "k1",
			description: "ci key",
			created: "2026-06-01T00:00:00Z",
			expires: "2026-09-01T00:00:00Z",
			revoked: null,
			capabilities: { devices: { create: { reusable: true, ephemeral: false } } },
			// The one-time secret must NEVER be echoed.
			key: "tskey-auth-SUPERSECRET",
		},
	],
};

const NAMESERVERS = { dns: ["1.1.1.1", "8.8.8.8"] };
const PREFERENCES = { magicDNS: true };

/** Install a global.fetch mock that routes by URL, counts token mints, and records auth/body. */
function installFetch() {
	const calls = { token: 0, urls: [] as string[], auth: [] as string[], tokenBody: "", tokenMethod: "", tokenUrl: "" };
	const f = vi.fn(async (input: any, init: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("/oauth/token")) {
			calls.token++;
			calls.tokenBody = String(init?.body ?? "");
			calls.tokenMethod = String(init?.method ?? "");
			calls.tokenUrl = url;
			return json({ access_token: "TSTOK", token_type: "Bearer", expires_in: 3600 });
		}
		calls.auth.push(String(init?.headers?.Authorization ?? ""));
		if (url.includes("/dns/nameservers")) return json(NAMESERVERS);
		if (url.includes("/dns/preferences")) return json(PREFERENCES);
		if (url.includes("/keys")) return json(KEYS);
		if (/\/device\/[^/?]+$/.test(url)) return json(DEVICES.devices[0]);
		if (url.includes("/devices")) return json(DEVICES);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const keyedEnv = (extra: Record<string, unknown> = {}) =>
	({ TAILSCALE_OAUTH_CLIENT_ID: "cid", TAILSCALE_OAUTH_CLIENT_SECRET: "csec", OAUTH_KV: kvStub(), ...extra }) as any;

afterEach(() => vi.restoreAllMocks());

describe("tailscale", () => {
	it("fails clearly when the OAuth client is not configured", async () => {
		const r = await tailscale.run({ OAUTH_KV: kvStub() } as any, { action: "devices" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toMatch(/TAILSCALE_OAUTH_CLIENT_ID/);
		expect(r.content[0].text).toMatch(/TAILSCALE_OAUTH_CLIENT_SECRET/);
	});

	it("mints an OAuth token (form-encoded client-credentials) then Bearers it on the API call", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv(), {});
		expect(r.isError).toBeFalsy();
		// The token POST came first: right method, right endpoint, form body carries the client-credentials grant.
		expect(calls.tokenMethod).toBe("POST");
		expect(calls.tokenUrl).toContain("/api/v2/oauth/token");
		expect(calls.tokenBody).toContain("grant_type=client_credentials");
		expect(calls.tokenBody).toContain("client_id=cid");
		expect(calls.tokenBody).toContain("client_secret=csec");
		// The subsequent API GET used the minted bearer token.
		expect(calls.auth[0]).toBe("Bearer TSTOK");
	});

	it("caches the minted token in KV with an expires_in-60 TTL and reuses it (minted once)", async () => {
		const { calls } = installFetch();
		const env = keyedEnv();
		await tailscale.run(env, { action: "devices" });
		await tailscale.run(env, { action: "keys" });
		expect(calls.token).toBe(1);
		expect(env.OAUTH_KV.map.get("sux:tailscale:token")).toBe("TSTOK");
		// TTL applied = expires_in - 60.
		expect(env.OAUTH_KV.put).toHaveBeenCalledWith("sux:tailscale:token", "TSTOK", { expirationTtl: 3540 });
	});

	it("devices returns normalized machines and defaults the tailnet to '-'", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv(), {});
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j).toMatchObject({ service: "tailscale", tailnet: "-", action: "devices", count: 1 });
		expect(j.items[0]).toEqual({
			id: "n1",
			name: "laptop.tail1234.ts.net",
			hostname: "laptop",
			addresses: ["100.64.0.1", "fd7a::1"],
			os: "macOS",
			clientVersion: "1.62.0",
			lastSeen: "2026-07-01T12:00:00Z",
			online: true,
			tags: ["tag:home"],
		});
		// Non-allowlisted fields are dropped.
		expect(j.items[0].nodeKey).toBeUndefined();
		expect(calls.urls.some((u) => u.includes("/tailnet/-/devices"))).toBe(true);
	});

	it("honors TAILSCALE_TAILNET in the request path", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv({ TAILSCALE_TAILNET: "example.com" }), { action: "devices" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.tailnet).toBe("example.com");
		expect(calls.urls.some((u) => u.includes("/tailnet/example.com/devices"))).toBe(true);
	});

	it("device fetches one machine by device_id", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv(), { action: "device", device_id: "n1" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0].id).toBe("n1");
		expect(calls.urls.some((u) => u.includes("/device/n1"))).toBe(true);
	});

	it("device requires a device_id", async () => {
		installFetch();
		const r = await tailscale.run(keyedEnv(), { action: "device" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
	});

	it("dns merges nameservers and preferences", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv(), { action: "dns" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0]).toMatchObject({ dns: ["1.1.1.1", "8.8.8.8"], magicDNS: true });
		expect(calls.urls.some((u) => u.includes("/dns/nameservers"))).toBe(true);
		expect(calls.urls.some((u) => u.includes("/dns/preferences"))).toBe(true);
	});

	it("keys returns ids + capabilities but NEVER the secret", async () => {
		installFetch();
		const r = await tailscale.run(keyedEnv(), { action: "keys" });
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).not.toContain("SUPERSECRET");
		const j = JSON.parse(text);
		expect(j.count).toBe(1);
		expect(j.items[0]).toEqual({
			id: "k1",
			description: "ci key",
			created: "2026-06-01T00:00:00Z",
			expires: "2026-09-01T00:00:00Z",
			revoked: null,
			capabilities: { devices: { create: { reusable: true, ephemeral: false } } },
		});
		expect(j.items[0].key).toBeUndefined();
	});

	it("self-heals a rejected token by re-minting on a 401 and retrying", async () => {
		// KV pre-seeded with a stale token whose delete() is a no-op for reads — models
		// Cloudflare KV serving the just-deleted token, so getToken would return it again.
		const staleKv = () => {
			const map = new Map<string, string>([["sux:tailscale:token", "STALE"]]);
			return {
				map,
				get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
				put: vi.fn(async (k: string, v: string) => {
					map.set(k, v);
				}),
				delete: vi.fn(async (_k: string) => {}),
			};
		};
		const env = { TAILSCALE_OAUTH_CLIENT_ID: "cid", TAILSCALE_OAUTH_CLIENT_SECRET: "csec", OAUTH_KV: staleKv() } as any;
		global.fetch = vi.fn(async (input: any, init: any) => {
			const url = String(input);
			if (url.includes("/oauth/token")) return json({ access_token: "FRESH", token_type: "Bearer", expires_in: 3600 });
			const auth = init?.headers?.Authorization ?? "";
			if (url.includes("/devices")) return auth === "Bearer FRESH" ? json(DEVICES) : json({ message: "unauthorized" }, 401);
			return json({}, 404);
		}) as any;
		const r = await tailscale.run(env, { action: "devices" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0].id).toBe("n1");
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/oauth/token")) return json({ access_token: "TSTOK", token_type: "Bearer", expires_in: 3600 });
			return json({ message: "server error" }, 500);
		}) as any;
		const r = await tailscale.run(keyedEnv(), { action: "devices" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(r.content[0].text).toMatch(/HTTP 500/);
	});
});
