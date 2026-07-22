import { afterEach, describe, expect, it, vi } from "vitest";
import { MONARCH_API, MONARCH_GRANT_KEY, handleMonarchRoutes, probeMonarchToken, readMonarchGrant, writeMonarchGrant } from "./monarch";

function kvStub() {
	const map = new Map<string, string>();
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => {
			map.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			map.delete(k);
		}),
	};
}

const baseEnv = (over: Record<string, unknown> = {}) => ({ OAUTH_KV: kvStub(), ...over }) as any;
const req = (u: string, method: string, bearer?: string, body?: unknown) =>
	new Request(u, {
		method,
		headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});

afterEach(() => vi.restoreAllMocks());

const URL_CONNECT = "https://suxos.net/monarch/connect";

describe("monarch /connect paste-door — operator-Bearer gate", () => {
	it("returns null for any other path", async () => {
		expect(await handleMonarchRoutes(new URL("https://suxos.net/other"), req("https://suxos.net/other", "GET"), baseEnv({ SUX_CRON_TOKEN: "op" }))).toBeNull();
	});

	it("404s when the operator gate secret is unset", async () => {
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "GET"), baseEnv());
		expect(resp?.status).toBe(404);
	});

	it("the POST (token-storing op) is the Bearer boundary — 401 on a missing or wrong bearer", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		expect((await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", undefined, { token: "x" }), env))?.status).toBe(401);
		expect((await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", "wrong", { token: "x" }), env))?.status).toBe(401);
	});

	it("GET with a valid Bearer embeds the operator token for the POST", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "GET", "op-secret"), env);
		expect(resp?.status).toBe(200);
		expect(resp?.headers.get("content-type")).toMatch(/text\/html/);
		expect(resp?.headers.get("cache-control")).toBe("no-store");
		const html = await resp!.text();
		expect(html).toContain("<textarea");
		expect(html).toMatch(/Local Storage/i);
		expect(html).toContain("app.monarch.com");
		expect(html).toContain('"op-secret"'); // embedded for the same-holder POST
		// Self-contained (CSP-safe): no external asset URLs, no src=/href= fetches.
		expect(html).not.toMatch(/https?:\/\//i);
		expect(html).not.toMatch(/\b(src|href)\s*=/i);
	});

	it("GET WITHOUT a bearer still renders the form (plain-browser path) but embeds NO token — JS falls back to the URL fragment", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		const noBearer = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "GET"), env);
		expect(noBearer?.status).toBe(200);
		const html = await noBearer!.text();
		expect(html).toContain("<textarea");
		expect(html).not.toContain("op-secret"); // never embed the secret when unauthenticated
		expect(html).toContain("location.hash"); // fragment fallback wired
		// A WRONG bearer must likewise never be echoed.
		const wrong = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "GET", "guess"), env);
		expect((await wrong!.text())).not.toContain("guess");
	});
});

describe("monarch /connect POST — token probe accept/reject + grant round-trip", () => {
	it("400s when no token is provided", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", "op-secret", {}), env);
		expect(resp?.status).toBe(400);
		expect(JSON.parse(await resp!.text())).toMatchObject({ ok: false });
	});

	it("accepts a token that probes 200 → stores the grant (round-trip)", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL, init?: any) => {
				expect(String(u)).toBe(MONARCH_API);
				expect(init.headers.Authorization).toBe("Token good-tok");
				expect(init.headers["Client-Platform"]).toBe("web");
				return new Response(JSON.stringify({ data: { me: { id: "u1" } } }), { status: 200 });
			}),
		);
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", "op-secret", { token: "good-tok" }), env);
		expect(resp?.status).toBe(200);
		expect(JSON.parse(await resp!.text())).toMatchObject({ ok: true });
		const grant = await readMonarchGrant(env);
		expect(grant?.token).toBe("good-tok");
		expect(typeof grant?.issued_at).toBe("number");
	});

	it("rejects a token that probes 401 → 401, grant NOT stored", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", "op-secret", { token: "bad-tok" }), env);
		expect(resp?.status).toBe(401);
		expect(JSON.parse(await resp!.text())).toMatchObject({ ok: false });
		expect(await readMonarchGrant(env)).toBeNull();
	});

	it("a transient 5xx probe → 502, grant NOT stored", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", "op-secret", { token: "t" }), env);
		expect(resp?.status).toBe(502);
		expect(await readMonarchGrant(env)).toBeNull();
	});

	it("trims a pasted token and never puts the raw token in the response body", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(init.headers.Authorization).toBe("Token spaced-tok"); // trimmed
			return new Response("{}", { status: 200 });
		}));
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "POST", "op-secret", { token: "  spaced-tok\n" }), env);
		const text = await resp!.text();
		expect(text).not.toContain("spaced-tok");
		expect((await readMonarchGrant(env))?.token).toBe("spaced-tok");
	});

	it("405s on an unsupported verb", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		const resp = await handleMonarchRoutes(new URL(URL_CONNECT), req(URL_CONNECT, "DELETE", "op-secret"), env);
		expect(resp?.status).toBe(405);
	});
});

describe("probeMonarchToken — status-based acceptance (auth == HTTP status, robust to schema drift)", () => {
	it("200 → ok; 200 with a GraphQL field error still ok (auth passed)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { status: 200 })));
		expect(await probeMonarchToken("t")).toMatchObject({ ok: true, status: 200 });
	});
	it("401/403 → not ok", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
		expect(await probeMonarchToken("t")).toMatchObject({ ok: false, status: 401 });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
		expect(await probeMonarchToken("t")).toMatchObject({ ok: false, status: 403 });
	});
});

describe("grant storage helpers", () => {
	it("write → read → grant carries token + issued_at under monarch:grant", async () => {
		const env = baseEnv();
		await writeMonarchGrant(env, "tok-123");
		expect(env.OAUTH_KV.map.has(MONARCH_GRANT_KEY)).toBe(true);
		const grant = await readMonarchGrant(env);
		expect(grant?.token).toBe("tok-123");
	});
	it("read returns null when KV is unbound", async () => {
		expect(await readMonarchGrant({} as any)).toBeNull();
	});
});
