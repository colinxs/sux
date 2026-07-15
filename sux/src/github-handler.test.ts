import { describe, expect, it } from "vitest";
import { GitHubHandler, redactPublicHealth } from "./github-handler";

describe("redactPublicHealth", () => {
	it("strips cron sub-job error text but keeps the ok/stale/age_ms signal", () => {
		const h = {
			status: "ok",
			cron: {
				mail_triage: { seen: true, ok: false, stale: false, age_ms: 1000, error: "upstream 500: http://10.0.0.1/secret leaked" },
				briefing: { seen: true, ok: true, stale: false, age_ms: 2000 },
			},
		};
		const redacted = redactPublicHealth(h) as any;
		expect(redacted.cron.mail_triage).toMatchObject({ seen: true, ok: false, stale: false, age_ms: 1000 });
		expect(redacted.cron.mail_triage.error).toBeUndefined();
		expect(redacted.cron.briefing).toMatchObject({ seen: true, ok: true, stale: false, age_ms: 2000 });
		expect(JSON.stringify(redacted)).not.toContain("leaked");
	});

	it("drops the residential exit and node hostname/IPs, keeping the datacenter exit", () => {
		const h = {
			tailscale: {
				residential: { ip: "1.2.3.4", org: "Comcast" },
				node: { hostname: "my-mac.tail.ts.net", tailscaleIPs: ["100.1.2.3"], online: true },
			},
		};
		const redacted = redactPublicHealth(h) as any;
		expect(redacted.tailscale.residential).toBeNull();
		expect(redacted.tailscale.node.hostname).toBeUndefined();
		expect(redacted.tailscale.node.tailscaleIPs).toBeUndefined();
		expect(redacted.tailscale.node.online).toBe(true);
	});
});

describe("POST /authorize (CSRF one-time-use)", () => {
	// Regression for #420: validateCSRFToken's clearCookie was computed but
	// discarded at the call site, leaving __Host-CSRF_TOKEN replayable for its
	// full 600s TTL instead of being invalidated after a successful use.
	it("clears __Host-CSRF_TOKEN alongside setting the approved-client cookie", async () => {
		const formData = new FormData();
		formData.set("csrf_token", "tok-123");
		formData.set(
			"state",
			btoa(JSON.stringify({ oauthReqInfo: { clientId: "client-A" } })),
		);

		const request = new Request("https://mcp.example.com/authorize", {
			method: "POST",
			headers: { Cookie: "__Host-CSRF_TOKEN=tok-123" },
			body: formData,
		});

		const env = {
			OAUTH_KV: { put: async () => {} } as unknown as KVNamespace,
			COOKIE_ENCRYPTION_KEY: "test-cookie-secret",
			GITHUB_CLIENT_ID: "test-client-id",
		} as any;

		const response = await GitHubHandler.fetch(request, env);

		expect(response.status).toBe(302);
		const setCookies = response.headers.getSetCookie();
		expect(setCookies.some((c) => c.startsWith("__Host-APPROVED_CLIENTS="))).toBe(true);
		const csrfClear = setCookies.find((c) => c.startsWith("__Host-CSRF_TOKEN="));
		expect(csrfClear).toBeDefined();
		expect(csrfClear).toContain("__Host-CSRF_TOKEN=;");
		expect(csrfClear).toContain("Max-Age=0");
	});
});
