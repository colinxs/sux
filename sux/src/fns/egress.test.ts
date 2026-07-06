import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configured: true, enabled: true }));

vi.mock("../proxy", () => ({
	isTailscaleConfigured: () => state.configured,
	proxyEnabled: () => state.enabled,
	smartFetch: vi.fn(),
}));

import { egress } from "./egress";
import { smartFetch } from "../proxy";

const trace = (ip: string) => new Response(`fl=123\nip=${ip}\nloc=US\ncolo=SEA\n`, { status: 200 });
const geo = (org: string, city = "Portland") => new Response(JSON.stringify({ success: true, city, region: "OR", country: "United States", connection: { org } }), { status: 200 });

// Direct fetch = datacenter (Cloudflare); proxy = residential (Comcast).
const directFetch = vi.fn(async (u: string) => (String(u).includes("trace") ? trace("9.9.9.9") : geo("Cloudflare", "San Francisco")));

afterEach(() => {
	state.configured = true;
	state.enabled = true;
	vi.clearAllMocks();
});

describe("egress", () => {
	it("reports routing:true when residential and direct IPs differ", async () => {
		(smartFetch as any).mockImplementation(async (_e: any, u: string) => (String(u).includes("trace") ? trace("1.2.3.4") : geo("Comcast")));
		vi.stubGlobal("fetch", directFetch);
		const r = await egress.run({} as any, {});
		vi.unstubAllGlobals();
		const j = JSON.parse(r.content[0].text);
		expect(j.routing).toBe(true);
		expect(j.residential.ip).toBe("1.2.3.4");
		expect(j.datacenter.ip).toBe("9.9.9.9");
		expect(j.residential.org).toBe("Comcast");
		expect(j.verdict).toMatch(/Routing residentially/);
	});

	it("reports routing:false and 'falling back' when the IPs match (node down)", async () => {
		(smartFetch as any).mockImplementation(async (_e: any, u: string) => (String(u).includes("trace") ? trace("9.9.9.9") : geo("Cloudflare")));
		vi.stubGlobal("fetch", directFetch);
		const r = await egress.run({} as any, {});
		vi.unstubAllGlobals();
		const j = JSON.parse(r.content[0].text);
		expect(j.routing).toBe(false);
		expect(j.verdict).toMatch(/falling back to direct/);
	});

	it("reports not-configured clearly", async () => {
		state.configured = false;
		state.enabled = false;
		(smartFetch as any).mockImplementation(async (_e: any, u: string) => (String(u).includes("trace") ? trace("9.9.9.9") : geo("Cloudflare")));
		vi.stubGlobal("fetch", directFetch);
		const r = await egress.run({} as any, {});
		vi.unstubAllGlobals();
		const j = JSON.parse(r.content[0].text);
		expect(j.routing).toBe(false);
		expect(j.configured).toBe(false);
		expect(j.verdict).toMatch(/not configured/);
	});
});
