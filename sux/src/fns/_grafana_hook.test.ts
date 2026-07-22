import { describe, expect, it, vi } from "vitest";
import { handleGrafanaWebhook, renderAlertLine, upsertAlertEntry } from "./_grafana_hook";

vi.mock("./_webpush", () => ({ hasWebPush: vi.fn(() => false), notify: vi.fn(async () => ({ sent: 0, failed: 0 })) }));

const obsidianRun = vi.hoisted(() => vi.fn());
vi.mock("./obsidian", () => ({ obsidian: { run: (...args: any[]) => obsidianRun(...args) } }));

const env = (extra: Record<string, unknown> = {}) => ({ GRAFANA_WEBHOOK_TOKEN: "secret", ...extra }) as any;

function req(body: unknown, opts: { token?: string; asQuery?: boolean } = {}): { request: Request; url: URL } {
	const u = new URL("https://sux.example/hooks/grafana");
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.token && !opts.asQuery) headers.authorization = `Bearer ${opts.token}`;
	if (opts.token && opts.asQuery) u.searchParams.set("t", opts.token);
	return { request: new Request(u.toString(), { method: "POST", headers, body: JSON.stringify(body) }), url: u };
}

describe("renderAlertLine", () => {
	it("renders a firing alert line with folder + summary + startsAt", () => {
		const r = renderAlertLine({ status: "firing", labels: { alertname: "HighLatency", grafana_folder: "sux" }, annotations: { summary: "p99 > 2s" }, startsAt: "2026-07-22T00:00:00Z" });
		expect(r?.name).toBe("HighLatency");
		expect(r?.line).toContain("**HighLatency**: firing (sux) — p99 > 2s");
		expect(r?.line).toContain("since 2026-07-22T00:00:00Z");
	});

	it("returns null when the alert has no alertname label", () => {
		expect(renderAlertLine({ status: "firing", labels: {} })).toBeNull();
	});
});

describe("upsertAlertEntry", () => {
	it("appends a new alert line to a note that doesn't have one yet", () => {
		const out = upsertAlertEntry("# Grafana Alerts\n", "Foo", "- **Foo**: firing — bad");
		expect(out).toContain("- **Foo**: firing — bad");
	});

	it("replaces an existing entry for the same alertname instead of duplicating it", () => {
		const body = "# Grafana Alerts\n\n- **Foo**: firing — bad\n- **Bar**: firing — also bad\n";
		const out = upsertAlertEntry(body, "Foo", "- **Foo**: firing — worse now");
		expect(out).toContain("- **Foo**: firing — worse now");
		expect(out).not.toContain("firing — bad\n");
		expect(out).toContain("- **Bar**: firing — also bad");
		expect(out.match(/\*\*Foo\*\*/g)?.length).toBe(1);
	});

	it("removes the entry (dedupe) when the alert resolves", () => {
		const body = "# Grafana Alerts\n\n- **Foo**: firing — bad\n- **Bar**: firing — also bad\n";
		const out = upsertAlertEntry(body, "Foo", null);
		expect(out).not.toContain("**Foo**");
		expect(out).toContain("- **Bar**: firing — also bad");
	});

	it("is a no-op when a resolved alert was never recorded", () => {
		const body = "# Grafana Alerts\n";
		expect(upsertAlertEntry(body, "Ghost", null)).toBe(body);
	});
});

describe("handleGrafanaWebhook", () => {
	it("returns null for any other path (lets index.ts fall through)", async () => {
		const { request, url } = req({}, {});
		const other = new URL("https://sux.example/other");
		expect(await handleGrafanaWebhook(other, request, env())).toBeNull();
	});

	it("404s when GRAFANA_WEBHOOK_TOKEN is unset (feature off)", async () => {
		const { request, url } = req({ alerts: [] }, { token: "secret" });
		const r = await handleGrafanaWebhook(url, request, env({ GRAFANA_WEBHOOK_TOKEN: undefined }));
		expect(r?.status).toBe(404);
	});

	it("401s on a wrong/missing token", async () => {
		const { request, url } = req({ alerts: [] }, { token: "wrong" });
		const r = await handleGrafanaWebhook(url, request, env());
		expect(r?.status).toBe(401);
	});

	it("accepts the token via ?t= query param", async () => {
		obsidianRun.mockResolvedValue({ isError: true }); // note doesn't exist yet
		const { request, url } = req({ alerts: [] }, { token: "secret", asQuery: true });
		const r = await handleGrafanaWebhook(url, request, env());
		expect(r?.status).toBe(200);
	});

	it("upserts a firing alert into the vault note and skips a write when nothing rendered", async () => {
		obsidianRun.mockReset();
		obsidianRun.mockImplementation(async (_env: unknown, args: any) => {
			if (args.action === "read") return { isError: true };
			return { isError: false };
		});
		const { request, url } = req({ alerts: [{ status: "firing", labels: { alertname: "HighLatency" }, annotations: { summary: "p99 > 2s" } }] }, { token: "secret" });
		const r = await handleGrafanaWebhook(url, request, env());
		const out = await r!.json();
		expect(out).toMatchObject({ ok: true, alerts: 1, updated: 1, firing: 1 });
		const writeCall = obsidianRun.mock.calls.find((c: any[]) => c[1]?.action === "write");
		expect(writeCall?.[1]?.content).toContain("**HighLatency**: firing");
	});

	it("400s on invalid JSON", async () => {
		const u = new URL("https://sux.example/hooks/grafana");
		const request = new Request(u.toString(), { method: "POST", headers: { authorization: "Bearer secret" }, body: "not json" });
		const r = await handleGrafanaWebhook(u, request, env());
		expect(r?.status).toBe(400);
	});
});
