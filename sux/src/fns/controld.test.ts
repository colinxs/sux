import { afterEach, describe, expect, it, vi } from "vitest";

import { controld } from "./controld";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PROFILES = {
	success: true,
	body: {
		profiles: [
			{ PK: "abc123", name: "Home", updated: 1700000000 },
			{ PK: "def456", name: "Kids", updated: 1700000100 },
		],
	},
};

const DEVICES = {
	success: true,
	body: {
		devices: [
			{ PK: "dev1", name: "Laptop", status: 1, last_activity: 1700000200, profile: { PK: "abc123" } },
			{ PK: "dev2", name: "Phone", status: 0, profile_id: "def456" },
		],
	},
};

const RULES = {
	success: true,
	body: {
		rules: [
			{ PK: "ads.example.com", action: { do: 0, status: 1 }, group: 10, comment: "block ads" },
			{ PK: "allow.example.com", action: { do: 1 } },
		],
	},
};

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any, init: any) => {
		const url = String(input);
		calls.urls.push(url);
		(calls as any).lastInit = init;
		if (url.includes("/profiles/") && url.includes("/rules")) return json(RULES);
		if (url.endsWith("/devices")) return json(DEVICES);
		if (url.endsWith("/profiles")) return json(PROFILES);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const keyedEnv = () => ({ CONTROLD_API_TOKEN: "TOK" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("controld", () => {
	it("returns not_configured when the token is absent", async () => {
		const r = await controld.run({} as any, { action: "profiles" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toMatch(/CONTROLD_API_TOKEN/);
	});

	it("profiles (default action) normalizes ids and names and sends the Bearer token", async () => {
		const { calls } = installFetch();
		const r = await controld.run(keyedEnv(), {});
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j).toMatchObject({ service: "controld", action: "profiles", count: 2 });
		expect(j.items[0]).toMatchObject({ id: "abc123", name: "Home", updated: 1700000000 });
		expect(calls.urls[0]).toBe("https://api.controld.com/profiles");
		expect((calls as any).lastInit.headers.Authorization).toBe("Bearer TOK");
	});

	it("devices normalizes status and profile linkage", async () => {
		const { calls } = installFetch();
		const r = await controld.run(keyedEnv(), { action: "devices" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(j.items[0]).toMatchObject({ id: "dev1", name: "Laptop", profile_id: "abc123", status: 1 });
		expect(j.items[1]).toMatchObject({ id: "dev2", profile_id: "def456", status: 0 });
		expect(calls.urls[0]).toBe("https://api.controld.com/devices");
	});

	it("rules requires a profile_id", async () => {
		installFetch();
		const r = await controld.run(keyedEnv(), { action: "rules" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
	});

	it("rules fetches a profile's rules and pulls hostname/action", async () => {
		const { calls } = installFetch();
		const r = await controld.run(keyedEnv(), { action: "rules", profile_id: "abc123" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j).toMatchObject({ service: "controld", action: "rules", profile_id: "abc123", count: 2 });
		expect(j.items[0]).toMatchObject({ hostname: "ads.example.com", action: 0, group: 10 });
		expect(calls.urls[0]).toBe("https://api.controld.com/profiles/abc123/rules");
	});

	it("carries the upstream HTTP status into an upstream_error failure", async () => {
		global.fetch = vi.fn(async () => json({ error: "nope" }, 500)) as any;
		const r = await controld.run(keyedEnv(), { action: "profiles" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(r.content[0].text).toMatch(/HTTP 500/);
	});

	it("tolerates an array delivered directly on body", async () => {
		global.fetch = vi.fn(async () => json({ body: [{ PK: "x1", name: "Solo" }] })) as any;
		const r = await controld.run(keyedEnv(), { action: "profiles" });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0]).toMatchObject({ id: "x1", name: "Solo" });
	});
});
