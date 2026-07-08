import { afterEach, describe, expect, it, vi } from "vitest";

import { reddit } from "./reddit";

// Map-backed KV stub (env.OAUTH_KV) — mirrors the KVNamespace surface reddit uses.
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LISTING = {
	kind: "Listing",
	data: {
		children: [
			{
				kind: "t3",
				data: {
					id: "abc123",
					title: "Test Post",
					subreddit: "test",
					author: "alice",
					score: 42,
					num_comments: 7,
					created_utc: 1700000000,
					permalink: "/r/test/comments/abc123/test_post/",
					url: "https://example.com/x",
					selftext: "body text",
				},
			},
		],
	},
};

/** Install a global.fetch mock that routes by URL, records init, and counts token mints. */
function installFetch() {
	const calls = { token: 0, urls: [] as string[], inits: [] as any[] };
	const f = vi.fn(async (input: any, init: any) => {
		const url = String(input);
		calls.urls.push(url);
		calls.inits.push(init);
		if (url.includes("/api/v1/access_token")) {
			calls.token++;
			return json({ access_token: "TOK", expires_in: 3600, token_type: "bearer" });
		}
		if (url.startsWith("https://oauth.reddit.com")) return json(LISTING);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const keyedEnv = () => ({ REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "sec", OAUTH_KV: kvStub() }) as any;

afterEach(() => vi.restoreAllMocks());

describe("reddit", () => {
	it("fails clearly when the API keys are not configured", async () => {
		const r = await reddit.run({ OAUTH_KV: kvStub() } as any, { action: "search", q: "cats" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toMatch(/REDDIT_CLIENT_ID/);
	});

	it("search returns normalized posts and sends the descriptive User-Agent + Bearer on the API call", async () => {
		const { calls } = installFetch();
		const r = await reddit.run(keyedEnv(), { action: "search", q: "cats" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.service).toBe("reddit");
		expect(j.action).toBe("search");
		expect(j.count).toBe(1);
		expect(j.items[0]).toMatchObject({
			id: "abc123",
			title: "Test Post",
			subreddit: "test",
			author: "alice",
			score: 42,
			num_comments: 7,
			created_utc: 1700000000,
			permalink: "https://reddit.com/r/test/comments/abc123/test_post/",
			url: "https://example.com/x",
			selftext: "body text",
		});

		// The API request carried the descriptive User-Agent and the Bearer token.
		const apiIdx = calls.urls.findIndex((u) => u.startsWith("https://oauth.reddit.com"));
		const apiInit = calls.inits[apiIdx];
		expect(apiInit.headers["User-Agent"]).toBe("sux/1.0 (by /u/sux)");
		expect(apiInit.headers.Authorization).toBe("Bearer TOK");
		expect(calls.urls[apiIdx]).toContain("/search?");
		expect(calls.urls[apiIdx]).toContain("q=cats");
	});

	it("the token POST carries Basic auth and the descriptive User-Agent, and caches the token in KV with expires_in-60 TTL", async () => {
		const { calls } = installFetch();
		const env = keyedEnv();
		await reddit.run(env, { action: "search", q: "cats" });
		const tokIdx = calls.urls.findIndex((u) => u.includes("/api/v1/access_token"));
		const tokInit = calls.inits[tokIdx];
		expect(tokInit.method).toBe("POST");
		expect(tokInit.headers["User-Agent"]).toBe("sux/1.0 (by /u/sux)");
		expect(tokInit.headers.Authorization).toBe(`Basic ${btoa("id:sec")}`);
		expect(tokInit.body).toBe("grant_type=client_credentials");
		// Token cached in KV with TTL = expires_in - 60.
		expect(env.OAUTH_KV.map.get("sux:reddit:token")).toBe("TOK");
		expect(env.OAUTH_KV.put).toHaveBeenCalledWith("sux:reddit:token", "TOK", { expirationTtl: 3540 });
	});

	it("mints the token once and reuses it across calls (KV-cached)", async () => {
		const { calls } = installFetch();
		const env = keyedEnv();
		await reddit.run(env, { action: "search", q: "cats" });
		await reddit.run(env, { action: "search", q: "dogs" });
		expect(calls.token).toBe(1);
	});

	it("subreddit lists by sort and scopes to /r/<name>", async () => {
		const { calls } = installFetch();
		const r = await reddit.run(keyedEnv(), { action: "subreddit", subreddit: "test", sort: "new", limit: 10 });
		expect(r.isError).toBeFalsy();
		const url = calls.urls.find((u) => u.startsWith("https://oauth.reddit.com"))!;
		expect(url).toContain("/r/test/new");
		expect(url).toContain("limit=10");
	});

	it("search scoped to a subreddit sets restrict_sr and hits the subreddit search path", async () => {
		const { calls } = installFetch();
		await reddit.run(keyedEnv(), { action: "search", q: "cats", subreddit: "test" });
		const url = calls.urls.find((u) => u.startsWith("https://oauth.reddit.com"))!;
		expect(url).toContain("/r/test/search?");
		expect(url).toContain("restrict_sr=1");
	});

	it("comments normalizes the post listing from the [post, comments] array", async () => {
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/api/v1/access_token")) return json({ access_token: "TOK", expires_in: 3600 });
			if (url.startsWith("https://oauth.reddit.com")) return json([LISTING, { kind: "Listing", data: { children: [] } }]);
			return json({}, 404);
		}) as any;
		const r = await reddit.run(keyedEnv(), { action: "comments", article_id: "abc123" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0].id).toBe("abc123");
	});

	it("user returns normalized about info", async () => {
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/api/v1/access_token")) return json({ access_token: "TOK", expires_in: 3600 });
			if (url.includes("/user/alice/about")) return json({ kind: "t2", data: { id: "u1", name: "alice", created_utc: 1600000000, link_karma: 100, comment_karma: 200, is_mod: true } });
			return json({}, 404);
		}) as any;
		const r = await reddit.run(keyedEnv(), { action: "user", username: "alice" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.items[0]).toMatchObject({ name: "alice", link_karma: 100, comment_karma: 200, is_mod: true, url: "https://reddit.com/user/alice" });
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/api/v1/access_token")) return json({ access_token: "TOK", expires_in: 3600 });
			return json({ error: "nope" }, 429);
		}) as any;
		const r = await reddit.run(keyedEnv(), { action: "search", q: "cats" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
