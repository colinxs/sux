import { afterEach, describe, expect, it, vi } from "vitest";

import { kroger } from "./kroger";

// Map-backed KV stub (env.OAUTH_KV) — mirrors the KVNamespace surface kroger uses.
function kvStub() {
	const map = new Map<string, string>();
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => {
			map.set(k, v);
		}),
	};
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PRODUCTS = {
	data: [
		{
			productId: "0001111041700",
			upc: "0001111041700",
			brand: "Kroger",
			description: "Kroger 2% Reduced Fat Milk",
			images: [{ sizes: [{ size: "medium", url: "https://img/m.jpg" }, { size: "large", url: "https://img/l.jpg" }] }],
			items: [{ size: "1 gal", price: { regular: 3.99, promo: 2.99 }, fulfillment: { curbside: true, delivery: false, inStore: true, shipToHome: false } }],
		},
	],
};

const LOCATIONS = {
	data: [
		{ locationId: "70100123", chain: "QFC", name: "QFC Broadway", address: { addressLine1: "123 Broadway", city: "Seattle", state: "WA", zipCode: "98122" }, phone: "206-555-0100" },
	],
};

/** Install a global.fetch mock that routes by URL and counts token mints. */
function installFetch() {
	const calls = { token: 0, urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("/connect/oauth2/token")) {
			calls.token++;
			return json({ access_token: "TOK", expires_in: 1800 });
		}
		if (url.includes("/v1/locations")) return json(LOCATIONS);
		if (/\/v1\/products\/[^?]+/.test(url)) return json({ data: PRODUCTS.data[0] });
		if (url.includes("/v1/products")) return json(PRODUCTS);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const keyedEnv = () => ({ KROGER_CLIENT_ID: "id", KROGER_CLIENT_SECRET: "sec", OAUTH_KV: kvStub() }) as any;

afterEach(() => vi.restoreAllMocks());

describe("kroger", () => {
	it("fails clearly when the API keys are not configured", async () => {
		const r = await kroger.run({ OAUTH_KV: kvStub() } as any, { action: "search", term: "milk" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/KROGER_CLIENT_ID/);
	});

	it("search returns normalized products", async () => {
		installFetch();
		const r = await kroger.run(keyedEnv(), { action: "search", term: "milk", location_id: "70100123" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.products[0]).toMatchObject({
			id: "0001111041700",
			title: "Kroger 2% Reduced Fat Milk",
			brand: "Kroger",
			price: 3.99,
			promo_price: 2.99,
			currency: "USD",
			size: "1 gal",
			image: "https://img/l.jpg",
			url: "https://www.kroger.com/p/-/0001111041700",
		});
		expect(j.products[0].fulfillment).toEqual(["curbside", "inStore"]);
	});

	it("mints the token once and reuses it across searches (KV-cached)", async () => {
		const { calls } = installFetch();
		const env = keyedEnv();
		await kroger.run(env, { action: "search", term: "milk", location_id: "70100123" });
		await kroger.run(env, { action: "search", term: "eggs", location_id: "70100123" });
		expect(calls.token).toBe(1);
		expect(env.OAUTH_KV.map.get("sux:kroger:token")).toBe("TOK");
		// TTL applied = expires_in - 60.
		expect(env.OAUTH_KV.put).toHaveBeenCalledWith("sux:kroger:token", "TOK", { expirationTtl: 1740 });
	});

	it("locations returns normalized stores and passes the chain filter through", async () => {
		const { calls } = installFetch();
		const r = await kroger.run(keyedEnv(), { action: "locations", zip: "98122", chain: "QFC" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.locations[0]).toMatchObject({ locationId: "70100123", chain: "QFC", name: "QFC Broadway", address: "123 Broadway, Seattle, WA, 98122", phone: "206-555-0100" });
		const locUrl = calls.urls.find((u) => u.includes("/v1/locations"))!;
		expect(locUrl).toContain("filter.chain=QFC");
		expect(locUrl).toContain("filter.zipCode.near=98122");
	});

	it("search auto-resolves a location from zip when location_id is absent", async () => {
		const { calls } = installFetch();
		const r = await kroger.run(keyedEnv(), { action: "search", term: "milk", zip: "98122", chain: "QFC" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.location_id).toBe("70100123");
		// A locations lookup happened before the product search.
		expect(calls.urls.some((u) => u.includes("/v1/locations"))).toBe(true);
		const prodUrl = calls.urls.find((u) => /\/v1\/products\?/.test(u))!;
		expect(prodUrl).toContain("filter.locationId=70100123");
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		installFetch();
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/connect/oauth2/token")) return json({ access_token: "TOK", expires_in: 1800 });
			return json({ errors: { reason: "nope" } }, 429);
		}) as any;
		const r = await kroger.run(keyedEnv(), { action: "search", term: "milk", location_id: "70100123" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
