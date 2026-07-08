import { afterEach, describe, expect, it, vi } from "vitest";

import { tailscale } from "./tailscale";

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

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
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

const keyedEnv = (extra: Record<string, unknown> = {}) => ({ TAILSCALE_API_KEY: "tskey-api-XXX", ...extra }) as any;

afterEach(() => vi.restoreAllMocks());

describe("tailscale", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await tailscale.run({} as any, { action: "devices" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toMatch(/TAILSCALE_API_KEY/);
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
		expect(calls.urls[0]).toContain("/tailnet/-/devices");
	});

	it("honors TAILSCALE_TAILNET in the request path", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv({ TAILSCALE_TAILNET: "example.com" }), { action: "devices" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.tailnet).toBe("example.com");
		expect(calls.urls[0]).toContain("/tailnet/example.com/devices");
	});

	it("device fetches one machine by device_id", async () => {
		const { calls } = installFetch();
		const r = await tailscale.run(keyedEnv(), { action: "device", device_id: "n1" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0].id).toBe("n1");
		expect(calls.urls[0]).toContain("/device/n1");
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

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async () => json({ message: "unauthorized" }, 401)) as any;
		const r = await tailscale.run(keyedEnv(), { action: "devices" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(r.content[0].text).toMatch(/HTTP 401/);
	});
});
