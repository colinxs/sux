import { afterEach, describe, expect, it, vi } from "vitest";

import { ebay } from "./ebay";

// Map-backed KV stub (env.OAUTH_KV) — mirrors the KVNamespace surface ebay uses.
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

const RESULTS = {
	itemSummaries: [
		{
			itemId: "v1|1234567890|0",
			title: "Apple iPhone 13 128GB",
			price: { value: "499.00", currency: "USD" },
			image: { imageUrl: "https://img/iphone.jpg" },
			itemWebUrl: "https://www.ebay.com/itm/1234567890",
			condition: "Used",
			seller: { username: "topseller" },
		},
	],
};

/** Install a global.fetch mock that routes by URL and counts token mints. */
function installFetch() {
	const calls = { token: 0, urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("/identity/v1/oauth2/token")) {
			calls.token++;
			return json({ access_token: "TOK", expires_in: 7200 });
		}
		if (url.includes("/item_summary/search")) return json(RESULTS);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const keyedEnv = () => ({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "sec", OAUTH_KV: kvStub() }) as any;

afterEach(() => vi.restoreAllMocks());

describe("ebay", () => {
	it("fails clearly when the API keys are not configured", async () => {
		const r = await ebay.run({ OAUTH_KV: kvStub() } as any, { action: "search", term: "iphone" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/EBAY_CLIENT_ID/);
	});

	it("search returns normalized products", async () => {
		const { calls } = installFetch();
		const r = await ebay.run(keyedEnv(), { action: "search", term: "iphone", limit: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.products[0]).toMatchObject({
			id: "v1|1234567890|0",
			title: "Apple iPhone 13 128GB",
			price: 499,
			currency: "USD",
			image: "https://img/iphone.jpg",
			url: "https://www.ebay.com/itm/1234567890",
			condition: "Used",
		});
		const searchUrl = calls.urls.find((u) => u.includes("/item_summary/search"))!;
		expect(searchUrl).toContain("q=iphone");
		expect(searchUrl).toContain("limit=5");
	});

	it("mints the token once and reuses it across searches (KV-cached)", async () => {
		const { calls } = installFetch();
		const env = keyedEnv();
		await ebay.run(env, { action: "search", term: "iphone" });
		await ebay.run(env, { action: "search", term: "ipad" });
		expect(calls.token).toBe(1);
		expect(env.OAUTH_KV.map.get("sux:ebay:token")).toBe("TOK");
		// TTL applied = expires_in - 60.
		expect(env.OAUTH_KV.put).toHaveBeenCalledWith("sux:ebay:token", "TOK", { expirationTtl: 7140 });
	});

	it("self-heals a 401 (stale app token) by dropping the cache and re-minting once", async () => {
		const env = keyedEnv();
		env.OAUTH_KV.map.set("sux:ebay:token", "STALE");
		let mints = 0;
		global.fetch = vi.fn(async (input: any, init?: any) => {
			const url = String(input);
			if (url.includes("/oauth2/token")) {
				mints++;
				return json({ access_token: "FRESH", expires_in: 7200 });
			}
			if (url.includes("/item_summary/search")) return init?.headers?.Authorization === "Bearer STALE" ? json({ errors: [] }, 401) : json(RESULTS);
			return json({}, 404);
		}) as any;
		const r = await ebay.run(env, { action: "search", term: "iphone" });
		expect(r.isError).toBeFalsy(); // recovered
		expect(mints).toBe(1); // re-minted exactly once
		expect(env.OAUTH_KV.map.get("sux:ebay:token")).toBe("FRESH");
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/identity/v1/oauth2/token")) return json({ access_token: "TOK", expires_in: 7200 });
			return json({ errors: [{ message: "nope" }] }, 429);
		}) as any;
		const r = await ebay.run(keyedEnv(), { action: "search", term: "iphone" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
