import { describe, expect, it } from "vitest";
import { appendFeedback } from "./fns/_feedback";
import { applyEvent, emptyMetrics } from "./metrics";
import { handleObservability } from "./observability";

function fakeEnv(r2Objects: Record<string, { body: string; contentType?: string }> = {}) {
	const store = new Map<string, string>();
	return {
		store,
		OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) },
		R2: {
			get: async (key: string) => {
				const o = r2Objects[key];
				if (!o) return null;
				return { arrayBuffer: async () => new TextEncoder().encode(o.body).buffer, httpMetadata: { contentType: o.contentType } };
			},
		},
	} as any;
}

const get = (env: any, path: string) => handleObservability(new URL(`https://sux.test${path}`), new Request(`https://sux.test${path}`), env);
const getJson = async (env: any, path: string): Promise<any> => (await get(env, path))!.json();

describe("observability", () => {
	it("serves /s/<uuid> with nosniff + sandbox CSP headers", async () => {
		const env = fakeEnv({ "store/abc": { body: "<h1>hi</h1>" } });
		env.store.set("store:u1", JSON.stringify({ key: "store/abc", content_type: "text/html" }));
		const res = await get(env, "/s/u1");
		expect(res!.status).toBe(200);
		expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res!.headers.get("content-security-policy")).toBe("sandbox");
		expect(res!.headers.get("content-type")).toBe("text/html");
	});

	it("adds derived per-tool error_rate/hit_rate/avg_ms to /metrics JSON", async () => {
		const env = fakeEnv();
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "dns", ms: 100 });
		applyEvent(m, { tool: "dns", ms: 300, cache: true });
		applyEvent(m, { tool: "dns", ms: 200, error: true, err: "upstream 500" });
		env.store.set("sux:metrics", JSON.stringify(m));
		const body = await getJson(env, "/metrics");
		expect(body.tools.dns).toMatchObject({ calls: 3, error_rate: 0.3333, hit_rate: 0.3333, avg_ms: 200 });
		// last_error must NOT leak to the unauthenticated /metrics view.
		expect(body.tools.dns.last_error).toBeUndefined();
		expect(body.slo).toBeDefined();
		expect(body.recent).toBeUndefined();
	});

	it("scrubs raw err text from the unauthenticated /logs view", async () => {
		const env = fakeEnv();
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "dns", ms: 200, error: true, err: "upstream 500: http://10.0.0.1/secret leaked" });
		env.store.set("sux:metrics", JSON.stringify(m));
		const body = await getJson(env, "/logs");
		expect(body.recent).toHaveLength(1);
		// The boolean error flag stays, but the raw failure text is omitted.
		expect(body.recent[0].error).toBe(true);
		expect(body.recent[0].err).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("leaked");
	});

	it("emits only allowlisted fields from /logs (future LogEntry fields cannot leak)", async () => {
		const env = fakeEnv();
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "fetch", ms: 120, cache: true, routes: { proxied: 1 } });
		// Simulate a future LogEntry gaining sensitive fields: inject them into the stored
		// rolling-log blob. The public /logs view must NOT echo them back to anonymous callers.
		const raw = JSON.parse(JSON.stringify(m));
		raw.recent[0].secret = "sk-should-never-leak";
		raw.recent[0].args = { url: "http://10.0.0.1/internal" };
		env.store.set("sux:metrics", JSON.stringify(raw));
		const body = await getJson(env, "/logs");
		// Top-level shape is pinned to the public allowlist.
		expect(Object.keys(body).sort()).toEqual(["cache_hits", "errors", "recent", "since", "total"]);
		expect(body.recent).toHaveLength(1);
		const entry = body.recent[0];
		const allowed = ["at", "tool", "ms", "cache", "error", "routes"];
		expect(Object.keys(entry).every((k) => allowed.includes(k))).toBe(true);
		expect(entry).toMatchObject({ tool: "fetch", ms: 120, cache: true, error: false, routes: { proxied: 1 } });
		// Injected sensitive fields are dropped, not passed through.
		expect(JSON.stringify(body)).not.toContain("should-never-leak");
		expect(JSON.stringify(body)).not.toContain("10.0.0.1");
	});

	it("serves /llms.txt as CDN-cacheable markdown built from the live registry", async () => {
		const env = fakeEnv();
		const res = await get(env, "/llms.txt");
		expect(res!.status).toBe(200);
		expect(res!.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(res!.headers.get("cache-control")).toBe("public, max-age=3600");
		const body = await res!.text();
		expect(body).toContain("# sux — capability map");
		expect(body).toContain("## Domains");
		// Same source as the `sux` root verb — a known leaf must appear in the map.
		expect(body).toContain("`arxiv`");
	});

	it("returns null for non-GET requests to observability paths (falls through to OAuth)", async () => {
		const env = fakeEnv();
		for (const path of ["/logs", "/metrics", "/feedback"]) {
			const res = await handleObservability(new URL(`https://sux.test${path}`), new Request(`https://sux.test${path}`, { method: "POST" }), env);
			expect(res).toBeNull();
		}
	});

	it("filters /feedback by ?tool= alongside ?type=", async () => {
		const env = fakeEnv();
		await appendFeedback(env, "issue", "dns broke", "dns");
		await appendFeedback(env, "issue", "general gripe");
		await appendFeedback(env, "suggest", "dns idea", "dns");
		const all = await getJson(env, "/feedback");
		expect(all.count).toBe(3);
		const dnsOnly = await getJson(env, "/feedback?tool=dns");
		expect(dnsOnly.count).toBe(2);
		const dnsIssues = await getJson(env, "/feedback?type=issue&tool=dns");
		expect(dnsIssues.count).toBe(1);
		expect(dnsIssues.items[0]).toMatchObject({ kind: "issue", text: "dns broke", tool: "dns" });
	});
});
