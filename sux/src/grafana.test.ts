import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGithubBillingSnapshot, buildInfluxSnapshot, shipEgress, shipGithubBillingSnapshot, shipMetricsSnapshot, shipToLoki } from "./grafana";
import { applyEvent, type CallEvent, emptyMetrics } from "./metrics";
import type { RtEnv } from "./registry";

// A ctx whose waitUntil collects the fire-and-forget promises so tests can await
// the push completing before asserting.
function fakeCtx() {
	const promises: Promise<unknown>[] = [];
	return {
		promises,
		ctx: { waitUntil: (p: Promise<unknown>) => void promises.push(p) },
		settle: () => Promise.all(promises),
	};
}

const CONFIGURED = { GRAFANA_LOKI_URL: "https://loki.test/push", GRAFANA_LOKI_USER: "u1", GRAFANA_LOKI_TOKEN: "t1" } as unknown as RtEnv;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("shipToLoki", () => {
	it("is inert (no fetch) unless all three Grafana secrets are set", () => {
		const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const e: CallEvent = { tool: "dns", ms: 12 };
		// Every combination that is missing at least one secret must be a no-op.
		const partials: Partial<RtEnv>[] = [
			{},
			{ GRAFANA_LOKI_URL: "https://loki.test/push" },
			{ GRAFANA_LOKI_USER: "u1" },
			{ GRAFANA_LOKI_TOKEN: "t1" },
			{ GRAFANA_LOKI_URL: "https://loki.test/push", GRAFANA_LOKI_USER: "u1" },
			{ GRAFANA_LOKI_URL: "https://loki.test/push", GRAFANA_LOKI_TOKEN: "t1" },
			{ GRAFANA_LOKI_USER: "u1", GRAFANA_LOKI_TOKEN: "t1" },
		];
		for (const env of partials) {
			const { ctx, promises } = fakeCtx();
			shipToLoki(env as RtEnv, ctx, e);
			expect(promises).toHaveLength(0);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts one authed JSON line whose payload is exactly the telemetry allowlist (no tool args)", async () => {
		const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const e: CallEvent = { tool: "fetch", ms: 42, cache: true, error: true, err: "boom", routes: { proxied: 1 }, at: 1_700_000_000_000 };
		const { ctx, settle } = fakeCtx();
		shipToLoki(CONFIGURED, ctx, e);
		await settle();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const url = fetchSpy.mock.calls[0][0];
		const init = fetchSpy.mock.calls[0][1]!;
		expect(url).toBe("https://loki.test/push");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		expect(headers.authorization).toBe(`Basic ${btoa("u1:t1")}`);

		const payload = JSON.parse(init.body as string);
		// Low-cardinality stream labels only: service + tool + level.
		expect(payload.streams[0].stream).toEqual({ service: "sux", tool: "fetch", level: "error" });
		const [tsNanos, line] = payload.streams[0].values[0];
		expect(tsNanos).toBe("1700000000000000000");
		// The log line ships exactly the intended fields — never tool arguments.
		const parsed = JSON.parse(line);
		expect(Object.keys(parsed).sort()).toEqual(["cache", "err", "error", "ms", "routes", "tool"]);
		expect(parsed).toEqual({ tool: "fetch", ms: 42, cache: true, error: true, err: "boom", routes: { proxied: 1 } });
	});

	it("omits optional err/routes when absent and marks level info on success", async () => {
		const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const e: CallEvent = { tool: "dns", ms: 5, at: 1_700_000_000_000 };
		const { ctx, settle } = fakeCtx();
		shipToLoki(CONFIGURED, ctx, e);
		await settle();

		const payload = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
		expect(payload.streams[0].stream.level).toBe("info");
		const line = JSON.parse(payload.streams[0].values[0][1]);
		expect(Object.keys(line).sort()).toEqual(["cache", "error", "ms", "tool"]);
		expect(line).toEqual({ tool: "dns", ms: 5, cache: false, error: false });
	});
});

describe("shipEgress", () => {
	it("is a no-op (no fetch) unless all three Grafana secrets are set", () => {
		const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const partials: Partial<RtEnv>[] = [
			{},
			{ GRAFANA_LOKI_URL: "https://loki.test/push" },
			{ GRAFANA_LOKI_USER: "u1" },
			{ GRAFANA_LOKI_TOKEN: "t1" },
			{ GRAFANA_LOKI_URL: "https://loki.test/push", GRAFANA_LOKI_USER: "u1" },
			{ GRAFANA_LOKI_URL: "https://loki.test/push", GRAFANA_LOKI_TOKEN: "t1" },
			{ GRAFANA_LOKI_USER: "u1", GRAFANA_LOKI_TOKEN: "t1" },
		];
		for (const env of partials) {
			const { ctx, promises } = fakeCtx();
			shipEgress(env as RtEnv, ctx, { reqId: "abc12345", host: "www.homedepot.com", rung: "proxied", residential: true, status: 200 });
			expect(promises).toHaveLength(0);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ships one authed egress line: host only, chosen rung, residential flag, status, reqId", async () => {
		const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const { ctx, settle } = fakeCtx();
		shipEgress(CONFIGURED, ctx, { reqId: "abc12345", host: "www.homedepot.com", rung: "proxied", residential: true, status: 200 });
		await settle();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const url = fetchSpy.mock.calls[0][0];
		const init = fetchSpy.mock.calls[0][1]!;
		expect(url).toBe("https://loki.test/push");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		expect(headers.authorization).toBe(`Basic ${btoa("u1:t1")}`);

		const payload = JSON.parse(init.body as string);
		// Low-cardinality stream labels only: service + a fixed kind + residential bool.
		expect(payload.streams[0].stream).toEqual({ service: "sux", kind: "egress", residential: "true" });
		const [tsNanos, line] = payload.streams[0].values[0];
		expect(tsNanos).toMatch(/^\d+000000$/);
		const parsed = JSON.parse(line);
		expect(parsed).toEqual({ host: "www.homedepot.com", rung: "proxied", residential: true, status: 200, reqId: "abc12345" });
		// Forensics discipline: a host, never a full URL that could carry a secret.
		expect(init.body as string).not.toContain("https://www.homedepot.com");
		expect(init.body as string).not.toContain("://www.homedepot.com");
	});

	it("omits optional status/reqId when absent and marks a direct exit residential=false", async () => {
		const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const { ctx, settle } = fakeCtx();
		shipEgress(CONFIGURED, ctx, { host: "example.com", rung: "direct", residential: false });
		await settle();

		const payload = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
		expect(payload.streams[0].stream.residential).toBe("false");
		const line = JSON.parse(payload.streams[0].values[0][1]);
		expect(Object.keys(line).sort()).toEqual(["host", "residential", "rung"]);
		expect(line).toEqual({ host: "example.com", rung: "direct", residential: false });
	});
});

// A KV stub whose single map backs every OAUTH_KV.get so readMetrics sees the doc.
function fakeEnv(kv: Record<string, string>, extra: Partial<RtEnv> = {}): RtEnv {
	const get = vi.fn(async (k: string) => kv[k] ?? null);
	return { ...extra, OAUTH_KV: { get } as unknown } as unknown as RtEnv;
}

const PROM_CONFIGURED = {
	GRAFANA_PROM_URL: "https://prom.test/api/v1/push/influx/write",
	GRAFANA_PROM_USER: "12345",
	GRAFANA_LOKI_TOKEN: "t1",
} as const;

describe("buildInfluxSnapshot", () => {
	it("emits Influx line protocol reusing the raw counters, derived rates and SLO gauges", () => {
		let m = emptyMetrics(0);
		m = applyEvent(m, { tool: "fetch", ms: 100, cache: true, routes: { proxied: 3, direct: 1 } });
		m = applyEvent(m, { tool: "fetch", ms: 200, error: true, err: "boom" });
		const body = buildInfluxSnapshot(m, 1_700_000_000_000);
		const lines = body.split("\n");
		// Every line carries the same nanosecond timestamp and a `value=` field.
		for (const l of lines) expect(l).toMatch(/ value=-?\d+(\.\d+)? 1700000000000000000$/);
		// Lifetime counters.
		expect(lines).toContain("sux_calls_total value=2 1700000000000000000");
		expect(lines).toContain("sux_errors_total value=1 1700000000000000000");
		expect(lines).toContain("sux_cache_hits_total value=1 1700000000000000000");
		// Per-tool series carry the tool as a tag.
		expect(lines).toContain("sux_tool_calls_total,tool=fetch value=2 1700000000000000000");
		expect(lines).toContain("sux_tool_errors_total,tool=fetch value=1 1700000000000000000");
		expect(lines).toContain("sux_tool_latency_ms_avg,tool=fetch value=150 1700000000000000000");
		// Fetch-route tally.
		expect(lines).toContain("sux_fetch_route_total,route=proxied value=3 1700000000000000000");
		expect(lines).toContain("sux_fetch_route_total,route=direct value=1 1700000000000000000");
		// Derived rates (deriveMetrics): error 1/2, cache 1/2, residential 3/4.
		expect(lines).toContain("sux_error_rate value=0.5 1700000000000000000");
		expect(lines).toContain("sux_cache_hit_rate value=0.5 1700000000000000000");
		expect(lines).toContain("sux_residential_ratio value=0.75 1700000000000000000");
		// SLO/latency gauges.
		expect(lines).toContain("sux_latency_ms,quantile=0.5 value=100 1700000000000000000");
		expect(lines).toContain("sux_latency_ms,quantile=0.95 value=200 1700000000000000000");
		expect(lines).toContain("sux_slo_breaches value=0 1700000000000000000");
	});

	it("omits null rates instead of emitting NaN (empty metrics have no sample)", () => {
		const body = buildInfluxSnapshot(emptyMetrics(0), 1_700_000_000_000);
		expect(body).not.toContain("NaN");
		// deriveMetrics rates are null with no calls → those series are omitted.
		expect(body).not.toContain("sux_error_rate");
		expect(body).not.toContain("sux_cache_hit_rate");
		expect(body).not.toContain("sux_residential_ratio");
		// But the raw counters and the always-defined SLO gauges are still present.
		expect(body).toContain("sux_calls_total value=0 1700000000000000000");
		expect(body).toContain("sux_success_rate value=1 1700000000000000000");
	});
});

describe("shipMetricsSnapshot", () => {
	it("is a pure no-op (no KV read, no fetch) unless both GRAFANA_PROM_* secrets and the token are set", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const partials: Partial<typeof PROM_CONFIGURED>[] = [
			{},
			{ GRAFANA_PROM_URL: PROM_CONFIGURED.GRAFANA_PROM_URL },
			{ GRAFANA_PROM_USER: PROM_CONFIGURED.GRAFANA_PROM_USER },
			{ GRAFANA_LOKI_TOKEN: PROM_CONFIGURED.GRAFANA_LOKI_TOKEN },
			{ GRAFANA_PROM_URL: PROM_CONFIGURED.GRAFANA_PROM_URL, GRAFANA_PROM_USER: PROM_CONFIGURED.GRAFANA_PROM_USER },
			{ GRAFANA_PROM_URL: PROM_CONFIGURED.GRAFANA_PROM_URL, GRAFANA_LOKI_TOKEN: PROM_CONFIGURED.GRAFANA_LOKI_TOKEN },
			{ GRAFANA_PROM_USER: PROM_CONFIGURED.GRAFANA_PROM_USER, GRAFANA_LOKI_TOKEN: PROM_CONFIGURED.GRAFANA_LOKI_TOKEN },
		];
		for (const extra of partials) {
			const env = fakeEnv({}, extra as Partial<RtEnv>);
			const { ctx, promises } = fakeCtx();
			await shipMetricsSnapshot(env, ctx);
			expect(promises).toHaveLength(0);
			// Dormant means no KV read at all — not just a suppressed POST.
			expect((env.OAUTH_KV.get as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("posts the Influx snapshot with basic auth from the shared Loki token", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		let m = emptyMetrics(1_700_000_000_000);
		m = applyEvent(m, { tool: "dns", ms: 5 });
		const env = fakeEnv({ "sux:metrics:0": JSON.stringify(m) }, PROM_CONFIGURED as Partial<RtEnv>);
		const { ctx, settle } = fakeCtx();
		await shipMetricsSnapshot(env, ctx);
		await settle();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(PROM_CONFIGURED.GRAFANA_PROM_URL);
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("text/plain");
		expect(headers.authorization).toBe(`Basic ${btoa("12345:t1")}`);
		expect(init.body as string).toContain("sux_tool_calls_total,tool=dns value=1");
	});
});

describe("buildGithubBillingSnapshot", () => {
	it("emits both gauges when both fields are present", () => {
		const body = buildGithubBillingSnapshot({ total_minutes_used: 42, included_minutes: 2000 }, 1_700_000_000_000);
		const lines = body.split("\n");
		expect(lines).toContain("gh_actions_minutes_used_total value=42 1700000000000000000");
		expect(lines).toContain("gh_actions_minutes_included value=2000 1700000000000000000");
	});

	it("omits a missing/non-finite field instead of emitting 0 or NaN", () => {
		const body = buildGithubBillingSnapshot({ total_minutes_used: 7 }, 1_700_000_000_000);
		expect(body).toContain("gh_actions_minutes_used_total value=7");
		expect(body).not.toContain("gh_actions_minutes_included");
		expect(body).not.toContain("NaN");
	});
});

describe("shipGithubBillingSnapshot", () => {
	const GH_CONFIGURED = { ...PROM_CONFIGURED, GITHUB_TOKEN: "gh-tok" } as const;

	it("is a no-op (returns dormant, no fetch) unless the Prometheus secrets and GITHUB_TOKEN are all set", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);
		const partials: Partial<typeof GH_CONFIGURED>[] = [{}, { GITHUB_TOKEN: "gh-tok" }, PROM_CONFIGURED as Partial<typeof GH_CONFIGURED>];
		for (const extra of partials) {
			const env = fakeEnv({}, extra as Partial<RtEnv>);
			const { ctx, promises } = fakeCtx();
			const report = await shipGithubBillingSnapshot(env, ctx);
			expect(report).toEqual({ dormant: true });
			expect(promises).toHaveLength(0);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("fetches billing usage from the default org and pushes the gauges via the shared transport", async () => {
		const fetchSpy = vi.fn(async (url: string) => {
			if (String(url) === "https://api.github.com/orgs/SuxOS/settings/billing/actions") {
				return new Response(JSON.stringify({ total_minutes_used: 100, included_minutes: 2000 }), { status: 200 });
			}
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal("fetch", fetchSpy);
		const env = fakeEnv({}, GH_CONFIGURED as Partial<RtEnv>);
		const { ctx, settle } = fakeCtx();
		const report = await shipGithubBillingSnapshot(env, ctx);
		await settle();

		expect(report).toEqual({ ok: true, total_minutes_used: 100, included_minutes: 2000 });
		const billingCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("settings/billing/actions")) as unknown as [string, RequestInit] | undefined;
		expect(billingCall?.[1]?.headers).toMatchObject({ Authorization: "Bearer gh-tok" });
		const pushCall = fetchSpy.mock.calls.find(([u]) => u === GH_CONFIGURED.GRAFANA_PROM_URL);
		expect(pushCall).toBeTruthy();
		const [, init] = pushCall as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("12345:t1")}`);
		expect(init.body as string).toContain("gh_actions_minutes_used_total value=100");
	});

	it("returns an error report (no push) on a non-OK GitHub response", async () => {
		const fetchSpy = vi.fn(async () => new Response("rate limited", { status: 403 }));
		vi.stubGlobal("fetch", fetchSpy);
		const env = fakeEnv({}, GH_CONFIGURED as Partial<RtEnv>);
		const { ctx, promises } = fakeCtx();
		const report = await shipGithubBillingSnapshot(env, ctx);
		expect(report).toMatchObject({ error: expect.stringContaining("403") });
		expect(promises).toHaveLength(0);
	});
});
