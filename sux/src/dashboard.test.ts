import { afterEach, describe, expect, it, vi } from "vitest";

// The dashboard's notes route dispatches straight into obsidian.run (git backend) —
// mock that seam directly instead of the network, mirroring how other tests here
// stub a fn's `run` rather than reimplementing GitHub's API surface.
const obsidianState = vi.hoisted(() => ({ run: null as null | ((env: any, args: any) => Promise<any>) }));
vi.mock("./fns/obsidian", () => ({
	obsidian: { name: "obsidian", run: (env: any, args: any) => obsidianState.run!(env, args) },
}));

// verifyAccessJwt has its own dedicated test coverage in access-jwt.test.ts (real
// crypto, real fail-closed cases). Here it's mocked so these tests exercise the
// route's business logic, not JWT plumbing — defaulted to "verified" so existing
// assertions read as the authenticated-request path; the gating tests below flip it.
const accessJwtState = vi.hoisted(() => ({ verified: true }));
vi.mock("./access-jwt", () => ({
	verifyAccessJwt: async () => accessJwtState.verified,
}));

import { applyEvent, emptyMetrics } from "./metrics";
import { handleDashboardRoutes } from "./dashboard";

afterEach(() => {
	vi.restoreAllMocks();
	accessJwtState.verified = true;
});

function fakeEnv() {
	const store = new Map<string, string>();
	return {
		store,
		OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) },
	} as any;
}

const get = (env: any, path: string, init?: RequestInit) => handleDashboardRoutes(new URL(`https://sux.test${path}`), new Request(`https://sux.test${path}`, init), env);
const getJson = async (env: any, path: string): Promise<any> => (await get(env, path))!.json();

const ok = (text: string) => ({ isError: false, content: [{ type: "text", text }] });
const err = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

describe("dashboard", () => {
	it("returns null for paths it doesn't own (falls through the route chain)", async () => {
		const env = fakeEnv();
		expect(await get(env, "/not-the-dashboard")).toBeNull();
	});

	it("returns null for non-GET requests", async () => {
		const env = fakeEnv();
		expect(await get(env, "/dashboard", { method: "POST" })).toBeNull();
		expect(await get(env, "/dashboard/api/metrics", { method: "POST" })).toBeNull();
	});

	it("serves the HTML shell at /dashboard", async () => {
		const env = fakeEnv();
		const res = await get(env, "/dashboard");
		expect(res!.status).toBe(200);
		expect(res!.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const body = await res!.text();
		expect(body).toContain("<title>sux dashboard</title>");
		expect(body).toContain("/dashboard/api/metrics");
		expect(body).toContain("/dashboard/api/notes");
	});

	it("sets a Content-Security-Policy on the HTML shell that still permits its inline script/style", async () => {
		const env = fakeEnv();
		const res = await get(env, "/dashboard");
		const csp = res!.headers.get("content-security-policy");
		expect(csp).toBe("default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
	});

	it("serves a metrics snapshot derived from the same store /metrics reads", async () => {
		const env = fakeEnv();
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "dns", ms: 100 });
		applyEvent(m, { tool: "dns", ms: 300, cache: true });
		applyEvent(m, { tool: "dns", ms: 200, error: true, err: "upstream 500" });
		env.store.set("sux:metrics", JSON.stringify(m));
		const body = await getJson(env, "/dashboard/api/metrics");
		expect(body.calls).toBe(3);
		expect(body.top_tools[0]).toMatchObject({ name: "dns", calls: 3, errors: 1 });
		expect(body.slo).toBeDefined();
	});

	it("lists recent notes from Daily/ and Inbox/, newest-filename-first, with frontmatter stripped", async () => {
		const env = fakeEnv();
		obsidianState.run = async (_env, args) => {
			if (args.action === "list" && args.path === "Daily") return ok(JSON.stringify({ notes: ["Daily/2026-07-01.md", "Daily/2026-07-13.md"] }));
			if (args.action === "list" && args.path === "Inbox") return ok(JSON.stringify({ notes: ["Inbox/2026-07-12 idea.md"] }));
			if (args.action === "read" && args.path === "Daily/2026-07-13.md") return ok("---\ntype: daily\n---\n\nTook the dog out.");
			if (args.action === "read" && args.path === "Inbox/2026-07-12 idea.md") return ok("---\ntype: capture\n---\n\nBuild a dashboard.");
			if (args.action === "read" && args.path === "Daily/2026-07-01.md") return ok("older note");
			return err("unexpected call");
		};
		const body = await getJson(env, "/dashboard/api/notes?limit=2");
		expect(body.notes).toEqual([
			{ path: "Daily/2026-07-13.md", excerpt: "Took the dog out." },
			{ path: "Inbox/2026-07-12 idea.md", excerpt: "Build a dashboard." },
		]);
	});

	it("strips a leading OBSIDIAN_VAULT_DIR prefix before reading (list paths are dir-prefixed; read re-applies the dir)", async () => {
		const env = fakeEnv();
		env.OBSIDIAN_VAULT_DIR = "notes";
		const readPaths: string[] = [];
		// list returns REPO-relative paths that already carry the OBSIDIAN_VAULT_DIR prefix;
		// obsidian `read` re-applies the dir, so feeding a listed path straight in double-prefixes
		// into a 404 → empty excerpt. The read mock only answers the STRIPPED, vault-relative path.
		obsidianState.run = async (_env, args) => {
			if (args.action === "list" && args.path === "Daily") return ok(JSON.stringify({ notes: ["notes/Daily/2026-07-13.md"] }));
			if (args.action === "list" && args.path === "Inbox") return ok(JSON.stringify({ notes: ["notes/Inbox/2026-07-12 idea.md"] }));
			if (args.action === "read") {
				readPaths.push(args.path);
				if (args.path === "Daily/2026-07-13.md") return ok("---\ntype: daily\n---\n\nWalked the dog.");
				if (args.path === "Inbox/2026-07-12 idea.md") return ok("---\ntype: capture\n---\n\nShip the fix.");
				return err(`double-prefixed read 404: ${args.path}`);
			}
			return err("unexpected call");
		};
		const body = await getJson(env, "/dashboard/api/notes?limit=2");
		expect(readPaths).toEqual(["Daily/2026-07-13.md", "Inbox/2026-07-12 idea.md"]);
		expect(body.notes).toEqual([
			{ path: "Daily/2026-07-13.md", excerpt: "Walked the dog." },
			{ path: "Inbox/2026-07-12 idea.md", excerpt: "Ship the fix." },
		]);
	});

	it("clamps the notes ?limit and skips a folder whose listing errored", async () => {
		const env = fakeEnv();
		obsidianState.run = async (_env, args) => {
			if (args.action === "list" && args.path === "Daily") return err("boom");
			if (args.action === "list" && args.path === "Inbox") return ok(JSON.stringify({ notes: ["Inbox/2026-07-12 a.md", "Inbox/2026-07-11 b.md", "Inbox/2026-07-10 c.md"] }));
			if (args.action === "read") return ok("body");
			return err("unexpected call");
		};
		const body = await getJson(env, "/dashboard/api/notes?limit=999");
		// limit clamps to the module max (25), but only 3 notes exist across the two folders.
		expect(body.notes.map((n: any) => n.path)).toEqual(["Inbox/2026-07-12 a.md", "Inbox/2026-07-11 b.md", "Inbox/2026-07-10 c.md"]);
	});

	it("429s the API routes (not the HTML shell) when OBS_RATE_LIMITER denies", async () => {
		const env = fakeEnv();
		env.OBS_RATE_LIMITER = { limit: async () => ({ success: false }) };
		obsidianState.run = async () => ok(JSON.stringify({ notes: [] }));
		expect((await get(env, "/dashboard/api/metrics"))!.status).toBe(429);
		expect((await get(env, "/dashboard/api/notes"))!.status).toBe(429);
		expect((await get(env, "/dashboard/api/mail-sieve"))!.status).toBe(429);
		expect((await get(env, "/dashboard"))!.status).toBe(200);
	});

	it("401s every /dashboard* route, including the HTML shell, when Access verification fails", async () => {
		const env = fakeEnv();
		accessJwtState.verified = false;
		expect((await get(env, "/dashboard"))!.status).toBe(401);
		expect((await get(env, "/dashboard/api/metrics"))!.status).toBe(401);
		expect((await get(env, "/dashboard/api/notes"))!.status).toBe(401);
		expect((await get(env, "/dashboard/api/mail-sieve"))!.status).toBe(401);
	});

	it("serves the generated Sieve script (text-only, no JMAP call) at /dashboard/api/mail-sieve", async () => {
		const env = fakeEnv();
		const body = await getJson(env, "/dashboard/api/mail-sieve");
		expect(body.script).toContain('require ["imap4flags"];');
		const code = body.script
			.split("\n")
			.filter((l: string) => !l.trim().startsWith("#"))
			.join("\n");
		expect(code).not.toMatch(/fileinto|discard|reject/i);
		expect(body.rule_count).toBeGreaterThan(0);
	});

	it("the HTML shell references the mail-sieve panel, its copy button, category toggles, and the issue button", async () => {
		const env = fakeEnv();
		const body = await (await get(env, "/dashboard"))!.text();
		expect(body).toContain("/dashboard/api/mail-sieve");
		expect(body).toContain('id="sieve-copy"');
		expect(body).toContain('id="sieve-categories"');
		expect(body).toContain('id="issue-file"');
		expect(body).toContain("github.com/SuxOS/sux/issues/new");
	});

	it("narrows the generated script to a requested `categories` query param", async () => {
		const env = fakeEnv();
		const all = await getJson(env, "/dashboard/api/mail-sieve");
		const junkOnly = await getJson(env, "/dashboard/api/mail-sieve?categories=junk");
		expect(junkOnly.categories).toEqual(["junk"]);
		expect(junkOnly.rule_count).toBeLessThan(all.rule_count);
		expect(junkOnly.script).not.toContain('addflag "mailing-list"');
	});

	it("400s on an unknown category in the query param instead of silently compiling all/none", async () => {
		const env = fakeEnv();
		const res = await get(env, "/dashboard/api/mail-sieve?categories=bogus");
		expect(res!.status).toBe(400);
	});
});
