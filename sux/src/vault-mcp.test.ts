import { describe, expect, it, vi } from "vitest";

// The vault tools dispatch into the obsidian/ingest fns, whose git backend goes
// through the proxy seam — mock it exactly like fns/obsidian.test.ts does.
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response) }));
vi.mock("./proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { handleVaultRpc, VAULT_TOOLS } from "./vault-mcp";

const ENV = { OBSIDIAN_VAULT_REPO: "me/vault" } as any;
const CTX = {} as any;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
// The vault owner's LOCAL day (default Pacific) — NOT UTC. Computing this the
// same way the code does is the point: a UTC `date` here silently blessed the
// evening-rollover bug the review caught.
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const rpc = (method: string, params?: any) => ({ jsonrpc: "2.0", id: 1, method, params }) as any;
const parse = async (r: Response) => {
	const text = await r.text();
	const m = /data: (.*)/.exec(text);
	return JSON.parse(m ? m[1] : text);
};

describe("vault MCP server (/vault/mcp)", () => {
	it("initializes as the 'vault' server", async () => {
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("initialize")));
		expect(out.result.serverInfo.name).toBe("vault");
		expect(out.result.protocolVersion).toBe("2025-06-18");
	});

	it("lists only cloud-truth tools (no live-vault dependencies in v1)", async () => {
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/list")));
		const names = out.result.tools.map((t: any) => t.name);
		expect(names).toEqual([
			"vault_read",
			"vault_list",
			"vault_write",
			"vault_append",
			"vault_edit",
			"vault_delete",
			"vault_capture",
			"vault_batch_append",
			"vault_daily_read",
			"vault_daily_append",
			"vault_query",
			"vault_patch",
		]);
		expect(names).not.toContain("vault_search"); // live-dependent — deferred to the vpc phase
		for (const t of out.result.tools) expect(t.inputSchema).toBeDefined();
	});

	it("vault_read serves through the git backend", async () => {
		routes.handler = (url) => {
			expect(url).toContain("/contents/Inbox%2Fidea.md");
			return new Response(JSON.stringify({ content: b64("# Idea"), sha: "s1" }), { status: 200 });
		};
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_read", arguments: { path: "Inbox/idea.md" } })));
		expect(out.result.content[0].text).toBe("# Idea");
		expect(out.result.isError).toBeFalsy();
	});

	it("vault_daily_append targets today's daily note", async () => {
		let putPath = "";
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putPath = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
				return new Response(JSON.stringify({ commit: { sha: "c1" } }), { status: 201 });
			}
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_daily_append", arguments: { content: "- [ ] task" } })));
		expect(out.result.isError).toBeFalsy();
		expect(putPath).toBe(`Daily/${date}.md`);
	});

	it("vault_delete refuses without confirm:true", async () => {
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_delete", arguments: { path: "old.md" } })));
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toMatch(/confirm:true/);
	});

	it("vault_edit rides the surgical find/replace (unique-match contract)", async () => {
		routes.handler = () => new Response(JSON.stringify({ content: b64("x y x"), sha: "s" }), { status: 200 });
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_edit", arguments: { path: "d.md", find: "x", replace: "z" } })));
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toMatch(/matches 2 times/);
	});

	it("vault_capture writes a provenance note via ingest", async () => {
		const puts: Record<string, string> = {};
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				const p = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
				puts[p] = Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8");
				return new Response(JSON.stringify({ commit: { sha: "c1" } }), { status: 201 });
			}
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_capture", arguments: { text: "quick thought", title: "Thought" } })));
		expect(out.result.isError).toBeFalsy();
		const note = JSON.parse(out.result.content[0].text);
		expect(note.note).toBe(`Inbox/${date} thought.md`);
		expect(puts[note.note]).toContain("type: capture");
	});

	it("path guards still bite through the MCP surface", async () => {
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_write", arguments: { path: ".github/workflows/pwn.yml", content: "x" } })));
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toMatch(/Refusing vault path/);
	});

	it("rejects unknown tools and methods; ignores notifications", async () => {
		const bad = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "nope" })));
		expect(bad.error.code).toBe(-32601);
		const meth = await parse(await handleVaultRpc(ENV, CTX, rpc("resources/list")));
		expect(meth.error.code).toBe(-32601);
		const note = await handleVaultRpc(ENV, CTX, rpc("notifications/initialized"));
		expect(note.status).toBe(202);
	});

	it("every tool schema is closed (additionalProperties: false)", () => {
		for (const t of VAULT_TOOLS) expect((t.inputSchema as any).additionalProperties).toBe(false);
	});

	it("daily notes use the vault owner's local day, not UTC", async () => {
		// The path must match Obsidian's local-time daily-notes plugin. Assert it's
		// the Pacific day and never the UTC day when they differ.
		let putPath = "";
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putPath = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
				return new Response(JSON.stringify({ commit: { sha: "c" } }), { status: 201 });
			}
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_daily_append", arguments: { content: "x" } }));
		const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
		expect(putPath).toBe(`Daily/${pacific}.md`);
	});

	it("vault_capture allowlists fields — a stray `path` can't reach ingest's overwrite branch", async () => {
		let putPath = "";
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putPath = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
				return new Response(JSON.stringify({ commit: { sha: "c" } }), { status: 201 });
			}
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		// `path: Home.md` is NOT in vault_capture's schema; it must be dropped, so the
		// capture lands in Inbox/, never overwriting the Home MOC.
		await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_capture", arguments: { text: "jot", title: "Jot", path: "Home.md" } }));
		expect(putPath).toMatch(/^Inbox\//);
		expect(putPath).not.toBe("Home.md");
	});

	it("rejects an over-large tools/call body", async () => {
		const r = await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_read", arguments: { path: "x.md" } }), 5 * 1024 * 1024);
		const out = await parse(r);
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toMatch(/too large/);
	});
});

// vault_query / vault_patch ride the same git backend as the rest, so we drive
// them through the real obsidian fn over the mocked proxy: the trees API backs
// list/scan, the contents API backs read, and PUT contents is the commit.
describe("vault_query + vault_patch over the git backend", () => {
	const fmNote = (obj: Record<string, string>, body = "") => `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}`;
	// A git store the mocked proxy serves: trees → paths, contents(GET) → bodies,
	// contents(PUT) → commit (captured back into the store so a read-after-write sees it).
	const gitStore = (notes: Record<string, string>) => {
		const s = new Map(Object.entries(notes));
		const puts: Record<string, string> = {};
		routes.handler = (url, init) => {
			if (url.includes("/git/trees/")) {
				return new Response(JSON.stringify({ tree: [...s.keys()].map((path) => ({ type: "blob", path })) }), { status: 200 });
			}
			const cm = /\/contents\/([^?]+)/.exec(url);
			const path = cm ? decodeURIComponent(cm[1]) : "";
			if (init?.method === "PUT") {
				const body = Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8");
				puts[path] = body;
				s.set(path, body);
				return new Response(JSON.stringify({ commit: { sha: "c1" }, content: { sha: "b1" } }), { status: 200 });
			}
			if (s.has(path)) return new Response(JSON.stringify({ content: b64(s.get(path)!), sha: `sha-${path}` }), { status: 200 });
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		return { s, puts };
	};
	const call = async (name: string, args: any) => JSON.parse((await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name, arguments: args })))).result.content[0].text);
	const raw = async (name: string, args: any) => (await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name, arguments: args })))).result;

	it("vault_query simple field/value scans frontmatter and returns paths only", async () => {
		gitStore({ "Projects/a.md": fmNote({ type: "project", status: "active" }), "Projects/b.md": fmNote({ type: "project", status: "done" }), "Man/c.md": fmNote({ type: "note" }) });
		const out = await call("vault_query", { field: "type", value: "project" });
		expect(out.count).toBe(2);
		expect(out.matches.sort()).toEqual(["Projects/a.md", "Projects/b.md"]);
	});

	it("vault_query JsonLogic filter composes and/comparison end to end", async () => {
		gitStore({
			"p/a.md": fmNote({ type: "project", status: "active", year: "2021" }),
			"p/b.md": fmNote({ type: "project", status: "active", year: "2018" }),
			"p/c.md": fmNote({ type: "project", status: "done", year: "2022" }),
		});
		const out = await call("vault_query", { filter: { and: [{ "==": ["type", "project"] }, { "==": ["status", "active"] }, { ">=": ["year", 2020] }] } });
		expect(out.matches).toEqual(["p/a.md"]);
	});

	it("vault_query surfaces an invalid filter as a failure", async () => {
		gitStore({ "a.md": fmNote({ type: "note" }) });
		const r = await raw("vault_query", { filter: { bogus: [] } });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/invalid filter/);
	});

	it("vault_patch sets a frontmatter field and commits the rewrite", async () => {
		const { puts } = gitStore({ "a.md": fmNote({ type: "project", status: "active" }, "# A") });
		const out = await call("vault_patch", { path: "a.md", frontmatter_field: "status", content: "done" });
		expect(out).toMatchObject({ ok: true, changed: true, target: "frontmatter_field" });
		expect(puts["a.md"]).toContain("status: done");
	});

	it("vault_patch target-not-found fails and never commits", async () => {
		const { puts } = gitStore({ "a.md": "# A\nno headings here" });
		const r = await raw("vault_patch", { path: "a.md", heading: "Ghost", mode: "replace", content: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not found/);
		expect(Object.keys(puts)).toHaveLength(0);
	});
});
