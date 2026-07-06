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
		expect(body.tools.dns).toMatchObject({ calls: 3, error_rate: 0.3333, hit_rate: 0.3333, avg_ms: 200, last_error: "upstream 500" });
		expect(body.slo).toBeDefined();
		expect(body.recent).toBeUndefined();
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
