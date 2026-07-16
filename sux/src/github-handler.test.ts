import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubHandler, redactPublicHealth } from "./github-handler";
import { addApprovedClient } from "./workers-oauth-utils";

// In-memory KV mirroring the slice of the KVNamespace surface handleAuthorizePost touches: put only.
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => void store.set(key, value),
		delete: async (key: string) => void store.delete(key),
	};
}

function makeEnv() {
	return {
		COOKIE_ENCRYPTION_KEY: "test-cookie-secret",
		GITHUB_CLIENT_ID: "test-client-id",
		OAUTH_KV: makeKv(),
	} as any;
}

const stubOAuthProvider = (overrides: Record<string, unknown> = {}) => ({
	parseAuthRequest: async (_r: Request) => ({ clientId: "test-client" }),
	lookupClient: async () => ({ clientId: "test-client", clientName: "Test Client" }),
	completeAuthorization: async () => ({ redirectTo: "https://client.example.com/done" }),
	...overrides,
});

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

	it("400s when the encoded state has no oauthReqInfo.clientId", async () => {
		const csrfToken = "csrf-tok-456";
		const state = btoa(JSON.stringify({ oauthReqInfo: {} }));
		const body = new URLSearchParams({ csrf_token: csrfToken, state }).toString();
		const request = new Request("https://example.com/authorize", {
			body,
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-CSRF_TOKEN=${csrfToken}` },
			method: "POST",
		});
		const response = await GitHubHandler.fetch(request, makeEnv());
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/Invalid request/);
	});

	it("400s when state isn't valid base64/JSON", async () => {
		const csrfToken = "csrf-tok-789";
		const body = new URLSearchParams({ csrf_token: csrfToken, state: "not-valid-base64!!" }).toString();
		const request = new Request("https://example.com/authorize", {
			body,
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-CSRF_TOKEN=${csrfToken}` },
			method: "POST",
		});
		const response = await GitHubHandler.fetch(request, makeEnv());
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/Invalid state data/);
	});

	it("400s when the state field is missing entirely", async () => {
		const csrfToken = "csrf-tok-abc";
		const body = new URLSearchParams({ csrf_token: csrfToken }).toString();
		const request = new Request("https://example.com/authorize", {
			body,
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-CSRF_TOKEN=${csrfToken}` },
			method: "POST",
		});
		const response = await GitHubHandler.fetch(request, makeEnv());
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/Missing state in form data/);
	});

	it("rejects (via OAuthError.toResponse) when the CSRF cookie is missing", async () => {
		const state = btoa(JSON.stringify({ oauthReqInfo: { clientId: "test-client" } }));
		const body = new URLSearchParams({ csrf_token: "csrf-tok-no-cookie", state }).toString();
		const request = new Request("https://example.com/authorize", {
			body,
			headers: { "content-type": "application/x-www-form-urlencoded" }, // no cookie header at all
			method: "POST",
		});
		const response = await GitHubHandler.fetch(request, makeEnv());
		expect(response.status).toBe(400);
		const json = (await response.json()) as { error: string };
		expect(json.error).toBe("invalid_request");
	});

	it("rejects when the form's CSRF token doesn't match the cookie's", async () => {
		const state = btoa(JSON.stringify({ oauthReqInfo: { clientId: "test-client" } }));
		const body = new URLSearchParams({ csrf_token: "form-token", state }).toString();
		const request = new Request("https://example.com/authorize", {
			body,
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: "__Host-CSRF_TOKEN=cookie-token" },
			method: "POST",
		});
		const response = await GitHubHandler.fetch(request, makeEnv());
		expect(response.status).toBe(400);
		const json = (await response.json()) as { error: string };
		expect(json.error).toBe("invalid_request");
	});
});

describe("GET /authorize", () => {
	it("400s when parseAuthRequest yields no clientId", async () => {
		const env = { ...makeEnv(), OAUTH_PROVIDER: stubOAuthProvider({ parseAuthRequest: async () => ({}) }) };
		const response = await GitHubHandler.fetch(new Request("https://example.com/authorize"), env);
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/Invalid request/);
	});

	it("renders the approval dialog with a fresh CSRF cookie when the client isn't pre-approved", async () => {
		const env = { ...makeEnv(), OAUTH_PROVIDER: stubOAuthProvider() };
		const response = await GitHubHandler.fetch(new Request("https://example.com/authorize"), env);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		const setCookie = response.headers.get("set-cookie");
		expect(setCookie).toContain("__Host-CSRF_TOKEN=");
		expect(await response.text()).toContain("Test Client");
	});

	it("skips the dialog and redirects straight to GitHub when the client cookie says it's already approved", async () => {
		const clientId = "test-client";
		const cookieSecret = "test-cookie-secret";
		const approvalCookie = await addApprovedClient(new Request("https://example.com/authorize"), clientId, cookieSecret);
		const cookieValue = approvalCookie.split(";")[0]; // "__Host-APPROVED_CLIENTS=..."

		const env = { ...makeEnv(), OAUTH_PROVIDER: stubOAuthProvider() };
		const request = new Request("https://example.com/authorize", { headers: { cookie: cookieValue } });
		const response = await GitHubHandler.fetch(request, env);

		expect(response.status).toBe(302);
		const location = response.headers.get("location") ?? "";
		expect(location).toContain("https://github.com/login/oauth/authorize");
		expect(location).toContain("state=");
	});
});

describe("GET /callback", () => {
	afterEach(() => vi.unstubAllGlobals());

	function makeCallbackEnv(overrides: Record<string, unknown> = {}) {
		return {
			...makeEnv(),
			GITHUB_CLIENT_SECRET: "test-client-secret",
			ALLOWED_GITHUB_LOGIN: "octocat",
			OAUTH_PROVIDER: stubOAuthProvider(),
			...overrides,
		};
	}

	const stubGithubFetch = (login: string) =>
		vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url === "https://github.com/login/oauth/access_token") {
				return new Response(new URLSearchParams({ access_token: "gh-token" }).toString(), {
					status: 200,
					headers: { "content-type": "application/x-www-form-urlencoded" },
				});
			}
			if (url === "https://api.github.com/user") {
				return new Response(JSON.stringify({ login, name: "Some One", email: "someone@example.com" }), { status: 200 });
			}
			throw new Error(`unexpected fetch to ${url}`);
		});

	it("400s when the state query param is missing", async () => {
		const response = await GitHubHandler.fetch(new Request("https://example.com/callback"), makeCallbackEnv());
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/Missing state parameter/);
	});

	it("400s when the state token isn't in KV (expired or already consumed)", async () => {
		const response = await GitHubHandler.fetch(new Request("https://example.com/callback?state=unknown-token"), makeCallbackEnv());
		expect(response.status).toBe(400);
		expect(await response.text()).toMatch(/Invalid or expired state/);
	});

	it("403s a login outside the allowlist, one-time-consuming the state", async () => {
		const kv = makeKv();
		await kv.put("oauth:state:tok1", JSON.stringify({ clientId: "test-client" }));
		vi.stubGlobal("fetch", stubGithubFetch("not-allowed"));

		const env = makeCallbackEnv({ OAUTH_KV: kv });
		const response = await GitHubHandler.fetch(new Request("https://example.com/callback?state=tok1&code=abc"), env);

		expect(response.status).toBe(403);
		expect(await response.text()).toContain("not-allowed");
		expect(await kv.get("oauth:state:tok1")).toBeNull(); // consumed even on rejection
	});

	it("completes authorization and redirects for an allowed login", async () => {
		const kv = makeKv();
		await kv.put("oauth:state:tok2", JSON.stringify({ clientId: "test-client", scope: ["read"] }));
		vi.stubGlobal("fetch", stubGithubFetch("octocat"));

		const completeAuthorization = vi.fn(async () => ({ redirectTo: "https://client.example.com/done" }));
		const env = makeCallbackEnv({ OAUTH_KV: kv, OAUTH_PROVIDER: stubOAuthProvider({ completeAuthorization }) });
		const response = await GitHubHandler.fetch(new Request("https://example.com/callback?state=tok2&code=abc"), env);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://client.example.com/done");
		expect(completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({ props: expect.objectContaining({ login: "octocat" }) }),
		);
		expect(await kv.get("oauth:state:tok2")).toBeNull(); // one-time use
	});
});
