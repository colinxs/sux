import { describe, expect, it } from "vitest";

// portal.ts dispatches into scanVault (vault-mcp.ts) and obsidian.run, both of
// which go through the proxy seam for GitHub — mock it exactly like
// vault-mcp.test.ts does, so this exercises the real filter/render logic against
// a real (mocked) git backend rather than re-stubbing obsidian.run itself.
import { vi } from "vitest";
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response) }));
vi.mock("./proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { handlePortalRoutes } from "./portal";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const ENV = { OBSIDIAN_VAULT_REPO: "me/vault", PORTAL_ENABLED: "1" } as any;

function serveNotes(notes: Record<string, string>) {
	routes.handler = (url) => {
		if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
		const m = /\/contents\/(.+?)(\?|$)/.exec(url);
		const path = m ? decodeURIComponent(m[1]) : "";
		if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		return new Response(JSON.stringify({ content: b64(notes[path]), sha: "s1" }), { status: 200 });
	};
}

const get = (env: any, path: string, init?: RequestInit) => handlePortalRoutes(new URL(`https://portal.test${path}`), new Request(`https://portal.test${path}`, init), env);

// The real portal.suxos.net hostname (routed at this Worker via a Cloudflare
// custom domain/route — infra, not this repo) serves the portal at root, not
// under /portal — simulate that by setting the Host header explicitly, since
// a self-constructed Request doesn't set one from its URL the way a real
// incoming Worker request does.
const getHost = (env: any, host: string, path: string, init?: RequestInit) =>
	handlePortalRoutes(new URL(`https://${host}${path}`), new Request(`https://${host}${path}`, { ...init, headers: { ...init?.headers, host } }), env);

const NOTES = {
	"Public/hello.md": "---\ntitle: Hello World\n---\n#portal\n\nWelcome! See [[Private Note]] for more.",
	"Private Note.md": "This is secret.",
	"Public/frontmatter.md": "---\nvisibility: portal\ntitle: FM Note\n---\nVisible via frontmatter.",
};

describe("portal", () => {
	it("returns null for paths it doesn't own (falls through the route chain)", async () => {
		expect(await get(ENV, "/not-the-portal")).toBeNull();
	});

	it("405s a non-GET request to a portal path", async () => {
		expect((await get(ENV, "/portal", { method: "POST" }))!.status).toBe(405);
	});

	it("404s when PORTAL_ENABLED is unset (fail-closed on its own flag)", async () => {
		const env = { OBSIDIAN_VAULT_REPO: "me/vault" };
		expect((await get(env, "/portal"))!.status).toBe(404);
	});

	it("404s when the vault isn't configured, even with PORTAL_ENABLED set", async () => {
		const env = { PORTAL_ENABLED: "1" };
		expect((await get(env, "/portal"))!.status).toBe(404);
	});

	it("indexes only #portal-tagged and visibility:portal notes, by title", async () => {
		serveNotes(NOTES);
		const res = await get(ENV, "/portal");
		expect(res!.status).toBe(200);
		const body = await res!.text();
		expect(body).toContain("Hello World");
		expect(body).toContain("FM Note");
		expect(body).not.toContain("This is secret");
		expect(body).not.toContain("Private Note<"); // not listed as its own entry
	});

	it("renders a #portal-tagged note's body, linkifying [[wikilinks]] to /portal/<basename>", async () => {
		serveNotes(NOTES);
		const res = await get(ENV, "/portal/hello");
		expect(res!.status).toBe(200);
		const body = await res!.text();
		expect(body).toContain("Hello World");
		expect(body).toContain("Welcome!");
		expect(body).toContain(`href="/portal/private%20note"`);
		expect(body).toContain(">Private Note</a>");
	});

	it("renders a visibility:portal frontmatter note directly", async () => {
		serveNotes(NOTES);
		const res = await get(ENV, "/portal/frontmatter");
		expect(res!.status).toBe(200);
		expect(await res!.text()).toContain("Visible via frontmatter.");
	});

	it("serves a private stub (not the content, not a bare 404) for a real but non-portal note", async () => {
		serveNotes(NOTES);
		const res = await get(ENV, "/portal/private%20note");
		expect(res!.status).toBe(200);
		const body = await res!.text();
		expect(body).toContain("isn't public");
		expect(body).not.toContain("This is secret");
	});

	it("404s a path that resolves to no note at all", async () => {
		serveNotes(NOTES);
		expect((await get(ENV, "/portal/does-not-exist"))!.status).toBe(404);
	});

	it("resolves a basename collision to the portal-visible note, even when the private one sorts first", async () => {
		serveNotes({
			"Private/ideas.md": "This is secret.",
			"Notes/Ideas.md": "---\ntitle: Ideas\n---\n#portal\n\nPublic idea.",
		});
		const res = await get(ENV, "/portal/ideas");
		expect(res!.status).toBe(200);
		expect(await res!.text()).toContain("Public idea.");
	});

	it("falls back to a private stub for a basename collision where no candidate is portal-visible", async () => {
		serveNotes({
			"Private/ideas.md": "This is secret.",
			"Other/Ideas.md": "Also secret.",
		});
		const res = await get(ENV, "/portal/ideas");
		expect(res!.status).toBe(200);
		const body = await res!.text();
		expect(body).toContain("isn't public");
		expect(body).not.toContain("secret");
	});

	it("re-derives visibility from the freshly-read body, not a stale scan snapshot (#848)", async () => {
		// Simulates a #portal tag being removed by a commit that lands between the
		// scan (which builds the served snapshot) and the explicit re-read that
		// fetches the note's current body for rendering.
		let reads = 0;
		routes.handler = (url) => {
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [{ type: "blob", path: "Public/race.md" }] }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (path !== "Public/race.md") return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			reads++;
			const content = reads === 1 ? "#portal\n\nOld public content." : "No longer public.";
			return new Response(JSON.stringify({ content: b64(content), sha: "s1" }), { status: 200 });
		};
		const res = await get(ENV, "/portal/race");
		expect(res!.status).toBe(200);
		const body = await res!.text();
		expect(body).toContain("isn't public");
		expect(body).not.toContain("Old public content");
		expect(body).not.toContain("No longer public");
	});

	it("429s when OBS_RATE_LIMITER denies", async () => {
		serveNotes(NOTES);
		const env = { ...ENV, OBS_RATE_LIMITER: { limit: async () => ({ success: false }) } };
		expect((await get(env, "/portal"))!.status).toBe(429);
	});

	it("serves the index at root on the default portal.suxos.net Host, no /portal prefix needed", async () => {
		serveNotes(NOTES);
		const res = await getHost(ENV, "portal.suxos.net", "/");
		expect(res!.status).toBe(200);
		const body = await res!.text();
		expect(body).toContain("Hello World");
	});

	it("serves a note at root-relative path on the default portal.suxos.net Host", async () => {
		serveNotes(NOTES);
		const res = await getHost(ENV, "portal.suxos.net", "/hello");
		expect(res!.status).toBe(200);
		expect(await res!.text()).toContain("Welcome!");
	});

	it("respects a configured PORTAL_HOST override instead of the default", async () => {
		serveNotes(NOTES);
		const env = { ...ENV, PORTAL_HOST: "portal.example.com" };
		expect(await getHost(env, "portal.suxos.net", "/")).toBeNull();
		const res = await getHost(env, "portal.example.com", "/");
		expect(res!.status).toBe(200);
	});

	it("returns null for an unrelated Host on a non-/portal path", async () => {
		expect(await getHost(ENV, "example.com", "/")).toBeNull();
	});
});
