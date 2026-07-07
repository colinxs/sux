import { afterEach, describe, expect, it, vi } from "vitest";
import { shipToLoki } from "./grafana";
import type { CallEvent } from "./metrics";
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
