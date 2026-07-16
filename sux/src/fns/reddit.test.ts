import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fully replace the proxy module so the keyless path's smartFetch is a controllable
// mock (and proxy.ts's github-auth/grafana imports never load).
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("{}", { status: 200 })),
}));

import { smartFetch } from "../proxy";
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

const COMMENTS_LISTING = {
	kind: "Listing",
	data: {
		children: [
			{
				kind: "t1",
				data: {
					id: "c1",
					author: "bob",
					body: "top-level comment",
					score: 5,
					created_utc: 1700000100,
					replies: {
						kind: "Listing",
						data: {
							children: [
								{ kind: "t1", data: { id: "c2", author: "carol", body: "a reply", score: 2, created_utc: 1700000200, replies: "" } },
								{ kind: "more", data: {} },
							],
						},
					},
				},
			},
			{ kind: "more", data: {} },
		],
	},
};

const UA_KEYLESS = "sux/1.0 (+https://github.com/SuxOS/sux)";
const UA_OAUTH = "sux/1.0 (by /u/sux)";

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
const keylessEnv = () => ({}) as any;

beforeEach(() => {
	vi.mocked(smartFetch).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("reddit — oauth mode (creds set)", () => {
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
		expect(apiInit.headers["User-Agent"]).toBe(UA_OAUTH);
		expect(apiInit.headers.Authorization).toBe("Bearer TOK");
		expect(calls.urls[apiIdx]).toContain("/search?");
		expect(calls.urls[apiIdx]).toContain("q=cats");
		// OAuth path never touches the keyless proxy.
		expect(smartFetch).not.toHaveBeenCalled();
	});

	it("the token POST carries Basic auth and the descriptive User-Agent, and caches the token in KV with expires_in-60 TTL", async () => {
		const { calls } = installFetch();
		const env = keyedEnv();
		await reddit.run(env, { action: "search", q: "cats" });
		const tokIdx = calls.urls.findIndex((u) => u.includes("/api/v1/access_token"));
		const tokInit = calls.inits[tokIdx];
		expect(tokInit.method).toBe("POST");
		expect(tokInit.headers["User-Agent"]).toBe(UA_OAUTH);
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

	it("comments normalizes the post listing from the [post, comments] array and parses the comment tree", async () => {
		global.fetch = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/api/v1/access_token")) return json({ access_token: "TOK", expires_in: 3600 });
			if (url.startsWith("https://oauth.reddit.com")) return json([LISTING, COMMENTS_LISTING]);
			return json({}, 404);
		}) as any;
		const r = await reddit.run(keyedEnv(), { action: "comments", article_id: "abc123" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0].id).toBe("abc123");
		expect(j.comments).toHaveLength(1);
		expect(j.comments[0]).toMatchObject({ id: "c1", author: "bob", body: "top-level comment", score: 5, created_utc: 1700000100 });
		expect(j.comments[0].replies).toHaveLength(1);
		expect(j.comments[0].replies[0]).toMatchObject({ id: "c2", author: "carol", body: "a reply" });
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

describe("reddit — keyless mode (no creds)", () => {
	// Guard: no OAuth token POST (or any oauth.reddit.com hit) ever happens keyless.
	// A global.fetch that throws makes any accidental OAuth call blow up loudly.
	function guardNoFetch() {
		const f = vi.fn(async () => {
			throw new Error("keyless mode must not call global fetch (no token POST, no oauth.reddit.com)");
		});
		global.fetch = f as any;
		return f;
	}

	it("search: no token POST, fetches the public .json via the proxy route with the descriptive UA, and normalizes posts", async () => {
		const noFetch = guardNoFetch();
		vi.mocked(smartFetch).mockResolvedValueOnce(json(LISTING));
		const r = await reddit.run(keylessEnv(), { action: "search", q: "cats" });
		expect(r.isError).toBeFalsy();

		// (a) no token POST / oauth call happened.
		expect(noFetch).not.toHaveBeenCalled();

		// (b) smartFetch got the .json URL, the descriptive UA, and the "proxy" route.
		expect(smartFetch).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("https://www.reddit.com/search.json?"),
			expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": UA_KEYLESS }) }),
			"proxy",
		);
		const url = vi.mocked(smartFetch).mock.calls[0][1] as string;
		expect(url).toContain("q=cats");

		// (c) posts normalize identically to the OAuth path.
		const j = JSON.parse(r.content[0].text);
		expect(j).toMatchObject({ service: "reddit", action: "search", count: 1 });
		expect(j.items[0]).toMatchObject({
			id: "abc123",
			title: "Test Post",
			subreddit: "test",
			author: "alice",
			permalink: "https://reddit.com/r/test/comments/abc123/test_post/",
			selftext: "body text",
		});
	});

	it("subreddit: hits /r/<name>/<sort>.json with limit via the proxy", async () => {
		guardNoFetch();
		vi.mocked(smartFetch).mockResolvedValueOnce(json(LISTING));
		const r = await reddit.run(keylessEnv(), { action: "subreddit", subreddit: "test", sort: "new", limit: 10 });
		expect(r.isError).toBeFalsy();
		const [, url, , route] = vi.mocked(smartFetch).mock.calls[0];
		expect(url).toContain("https://www.reddit.com/r/test/new.json");
		expect(url).toContain("limit=10");
		expect(route).toBe("proxy");
		expect(JSON.parse(r.content[0].text).count).toBe(1);
	});

	it("search scoped to a subreddit sets restrict_sr and hits /r/<name>/search.json", async () => {
		guardNoFetch();
		vi.mocked(smartFetch).mockResolvedValueOnce(json(LISTING));
		await reddit.run(keylessEnv(), { action: "search", q: "cats", subreddit: "test" });
		const url = vi.mocked(smartFetch).mock.calls[0][1] as string;
		expect(url).toContain("https://www.reddit.com/r/test/search.json?");
		expect(url).toContain("restrict_sr=1");
	});

	it("comments: fetches /comments/<id>.json and normalizes the post listing plus the comment tree from [post, comments]", async () => {
		guardNoFetch();
		vi.mocked(smartFetch).mockResolvedValueOnce(json([LISTING, COMMENTS_LISTING]));
		const r = await reddit.run(keylessEnv(), { action: "comments", article_id: "abc123" });
		expect(r.isError).toBeFalsy();
		const url = vi.mocked(smartFetch).mock.calls[0][1] as string;
		expect(url).toContain("https://www.reddit.com/comments/abc123.json");
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.items[0].id).toBe("abc123");
		expect(j.comments).toHaveLength(1);
		expect(j.comments[0]).toMatchObject({ id: "c1", author: "bob", body: "top-level comment" });
		expect(j.comments[0].replies).toHaveLength(1);
		expect(j.comments[0].replies[0]).toMatchObject({ id: "c2", author: "carol", body: "a reply" });
	});

	it("user: fetches /user/<name>/about.json and normalizes about info", async () => {
		guardNoFetch();
		vi.mocked(smartFetch).mockResolvedValueOnce(json({ kind: "t2", data: { id: "u1", name: "alice", created_utc: 1600000000, link_karma: 100, comment_karma: 200, is_mod: true } }));
		const r = await reddit.run(keylessEnv(), { action: "user", username: "alice" });
		expect(r.isError).toBeFalsy();
		const url = vi.mocked(smartFetch).mock.calls[0][1] as string;
		expect(url).toContain("https://www.reddit.com/user/alice/about.json");
		const j = JSON.parse(r.content[0].text);
		expect(j.items[0]).toMatchObject({ name: "alice", link_karma: 100, comment_karma: 200, is_mod: true, url: "https://reddit.com/user/alice" });
	});

	it("a 403 from the proxy maps to failWith('blocked') with the OAuth-upgrade hint", async () => {
		guardNoFetch();
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("", { status: 403 }));
		const r = await reddit.run(keylessEnv(), { action: "search", q: "cats" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("blocked");
		expect(r.content[0].text).toMatch(/REDDIT_CLIENT_ID/);
	});
});
