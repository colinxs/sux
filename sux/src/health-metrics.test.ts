import { describe, expect, it } from "vitest";
import { bindingsOk, deriveMetrics, probeBindings, redactPublicHealth } from "./github-handler";
import { applyEvent, emptyMetrics } from "./metrics";

// The /health "cache & routing" card and its ?format=json "metrics" key are both
// fed by deriveMetrics — presentation only, mirroring observability.ts's rate math
// (r4() 4-dp rounding, rate = hits/calls). These lock the exact formulas + guards.

describe("deriveMetrics (health cache & routing figures)", () => {
	it("returns nulls (not NaN) on an empty/cold-isolate metrics blob", () => {
		expect(deriveMetrics(emptyMetrics(0))).toEqual({
			calls: 0,
			cache_hit_rate: null,
			residential_ratio: null,
			error_rate: null,
			proxied: 0,
			route_total: 0,
		});
	});

	it("computes cache_hit_rate = cache_hits/total and error_rate = errors/total", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "scrape", ms: 10 });
		applyEvent(m, { tool: "scrape", ms: 10, cache: true });
		applyEvent(m, { tool: "scrape", ms: 10, cache: true });
		applyEvent(m, { tool: "scrape", ms: 10, error: true, err: "boom" });
		const d = deriveMetrics(m);
		expect(d.calls).toBe(4);
		expect(d.cache_hit_rate).toBe(0.5); // 2/4
		expect(d.error_rate).toBe(0.25); // 1/4
	});

	it("computes residential_ratio = routes.proxied / sum(all routes), 4-dp rounded", () => {
		const m = emptyMetrics(0);
		m.routes = { proxied: 1, direct: 1, proxy_fallback: 1 };
		const d = deriveMetrics(m);
		expect(d.proxied).toBe(1);
		expect(d.route_total).toBe(3);
		expect(d.residential_ratio).toBe(0.3333); // 1/3 → r4
	});

	it("guards a zero route tally with null (no fetches recorded yet)", () => {
		const m = emptyMetrics(0);
		m.total = 5; // calls happened, but none went through smartFetch's route tally
		const d = deriveMetrics(m);
		expect(d.residential_ratio).toBeNull();
		expect(d.route_total).toBe(0);
	});
});

// /health is served by the OAuth defaultHandler before any auth gate, so its
// payload is anonymous-visible. redactPublicHealth must strip everything that
// deanonymizes the residential proxy node (exit IP, geo, ISP org, node hostname,
// Tailscale IPs) while keeping the up/down signals a status page needs.
describe("redactPublicHealth (anonymous /health must not leak the node)", () => {
	const sampleHealth = () => ({
		status: "ok",
		config: { kagiKey: true, githubClient: true, allowlist: true },
		tailscale: {
			configured: true,
			proxy_url_valid: true,
			routing: true,
			tunnel_ms: 42,
			residential: { ip: "73.15.20.99", city: "Portland", region: "Oregon", country: "US", colo: "PDX", org: "Comcast Cable" },
			datacenter: { ip: "104.28.1.1", city: "SF", region: "CA", country: "US", colo: "SJC", org: "Cloudflare" },
			node: { available: true, backendState: "Running", hostname: "home-node", tailscaleIPs: ["100.64.0.1", "fd7a::1"], online: true, peers: 3, peersOnline: 2, version: "1.2.3" },
		},
		upstream: { reachable: true, status: 200 },
		metrics: null,
	});

	it("strips the residential exit IP / geo / ISP org", () => {
		const r = redactPublicHealth(sampleHealth()) as any;
		expect(r.tailscale.residential).toBeNull();
		expect(JSON.stringify(r)).not.toContain("73.15.20.99");
		expect(JSON.stringify(r)).not.toContain("Comcast Cable");
		expect(JSON.stringify(r)).not.toContain("Portland");
	});

	it("strips the node hostname and Tailscale IPs", () => {
		const r = redactPublicHealth(sampleHealth()) as any;
		expect(r.tailscale.node.hostname).toBeUndefined();
		expect(r.tailscale.node.tailscaleIPs).toBeUndefined();
		expect(JSON.stringify(r)).not.toContain("home-node");
		expect(JSON.stringify(r)).not.toContain("100.64.0.1");
	});

	it("keeps the non-identifying up/down signals and the datacenter exit", () => {
		const r = redactPublicHealth(sampleHealth()) as any;
		expect(r.status).toBe("ok");
		expect(r.tailscale.routing).toBe(true);
		expect(r.tailscale.tunnel_ms).toBe(42);
		expect(r.tailscale.node.available).toBe(true);
		expect(r.tailscale.node.online).toBe(true);
		expect(r.tailscale.node.peersOnline).toBe(2);
		expect(r.tailscale.datacenter.ip).toBe("104.28.1.1");
		expect(r.upstream.reachable).toBe(true);
	});

	it("does not mutate the caller's original object", () => {
		const h = sampleHealth();
		redactPublicHealth(h);
		expect(h.tailscale.residential.ip).toBe("73.15.20.99");
		expect(h.tailscale.node.hostname).toBe("home-node");
	});
});

// probeBindings gives /health a real up/down signal for the storage/compute bindings
// the ~95 fns depend on — a free read-only roundtrip for KV + R2, a presence check for
// the pay-per-call trio (AI/IMAGES/BROWSER). bindingsOk folds them into ok/degraded.
describe("probeBindings + bindingsOk (binding reachability on /health)", () => {
	const stubEnv = (over: any = {}) => ({
		OAUTH_KV: { get: async () => null },
		R2: { head: async () => null },
		AI: { run: async () => ({}) },
		IMAGES: {},
		BROWSER: {},
		...over,
	});

	it("reports ok roundtrips for KV + R2 and bound for the pay-per-call trio", async () => {
		const b = await probeBindings(stubEnv() as any);
		expect((b.kv as any).ok).toBe(true);
		expect((b.r2 as any).ok).toBe(true);
		expect((b.ai as any).bound).toBe(true);
		expect((b.images as any).bound).toBe(true);
		expect((b.browser as any).bound).toBe(true);
		expect(bindingsOk(b)).toBe(true);
	});

	it("captures the reason and degrades when the R2 roundtrip throws", async () => {
		const b = await probeBindings(stubEnv({ R2: { head: async () => { throw new Error("R2 down"); } } }) as any);
		expect((b.r2 as any).ok).toBe(false);
		expect((b.r2 as any).reason).toContain("R2 down");
		expect(bindingsOk(b)).toBe(false);
	});

	it("treats a missing/unwired AI binding (no .run) as unbound → degraded", async () => {
		const b = await probeBindings(stubEnv({ AI: undefined }) as any);
		expect((b.ai as any).bound).toBe(false);
		expect(bindingsOk(b)).toBe(false);
	});

	it("bindingsOk is false on the timeout fallback shape", () => {
		expect(bindingsOk({ kv: { ok: false, reason: "timeout" }, r2: { ok: false, reason: "timeout" }, ai: { bound: false }, images: { bound: false }, browser: { bound: false } })).toBe(false);
	});
});
