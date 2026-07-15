import { describe, expect, it } from "vitest";
import { GitHubHandler, redactPublicHealth } from "./github-handler";

// In-memory KV mirroring the slice of the KVNamespace surface handleAuthorizePost touches: put only.
function makeKv() {
	const store = new Map<string, string>();
	return { get: async (key: string) => store.get(key) ?? null, put: async (key: string, value: string) => void store.set(key, value) };
}

function makeEnv() {
	return {
		COOKIE_ENCRYPTION_KEY: "test-cookie-secret",
		GITHUB_CLIENT_ID: "test-client-id",
		OAUTH_KV: makeKv(),
	} as any;
}

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
	it("clears __Host-CSRF_TOKEN on successful validation so it can't be replayed", async () => {
		const csrfToken = "csrf-tok-123";
		const state = btoa(JSON.stringify({ oauthReqInfo: { clientId: "test-client" } }));
		const body = new URLSearchParams({ csrf_token: csrfToken, state }).toString();

		const request = new Request("https://example.com/authorize", {
			body,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie: `__Host-CSRF_TOKEN=${csrfToken}`,
			},
			method: "POST",
		});

		const response = await GitHubHandler.fetch(request, makeEnv());

		expect(response.status).toBe(302);
		const setCookies = response.headers.getSetCookie();
		const csrfClearCookie = setCookies.find((c) => c.startsWith("__Host-CSRF_TOKEN="));
		expect(csrfClearCookie).toBeDefined();
		expect(csrfClearCookie).toContain("Max-Age=0");
	});
});
