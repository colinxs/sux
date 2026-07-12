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
			"vault_backlinks",
			"vault_query",
			"vault_patch",
			"vault_tags",
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

	it("vault_backlinks / vault_query / vault_tags scan the git store (§4)", async () => {
		const notes: Record<string, string> = {
			"Projects/sux.md": "---\nstatus: active\ntags: [project]\n---\n# sux\ncore stuff",
			"Notes/a.md": "---\nstatus: draft\n---\nsee [[sux]] and #idea here",
			"Notes/b.md": "plain note, no links, no tags",
		};
		routes.handler = (url) => {
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "s1" }), { status: 200 });
		};
		const call = async (name: string, args: any) => JSON.parse((await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name, arguments: args })))).result.content[0].text);

		const bl = await call("vault_backlinks", { path: "Projects/sux.md" });
		expect(bl.backlinks.map((x: any) => x.path)).toEqual(["Notes/a.md"]); // [[sux]] resolves by basename

		const q = await call("vault_query", { field: "status", value: "active" });
		expect(q.notes.map((x: any) => x.path)).toEqual(["Projects/sux.md"]);

		const t = await call("vault_tags", {});
		expect(t.tags.map((x: any) => x.tag).sort()).toEqual(["idea", "project"]);
	});

	it("scanVault serves the HEAD-keyed KV index — ~N note reads collapse to 1, rebuilt only on HEAD change", async () => {
		// In-memory KV so vaultHead + the index blob are exercised (the earlier scan
		// test has no OAUTH_KV and rides the direct fallback).
		const store = new Map<string, string>();
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
		const env = { OBSIDIAN_VAULT_REPO: "me/vault", OAUTH_KV: kv } as any;
		const notes: Record<string, string> = {
			"Projects/sux.md": "---\nstatus: active\ntags: [project]\n---\n# sux\ncore",
			"Notes/a.md": "---\nstatus: draft\n---\nsee [[sux]] and #idea",
			"Notes/b.md": "plain, no links",
		};
		let head = "head-1";
		const reads: string[] = [];
		routes.handler = (url, init) => {
			if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: head } }), { status: 200 });
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (init?.method === "PUT") {
				notes[path] = Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8");
				return new Response(JSON.stringify({ commit: { sha: head } }), { status: 201 });
			}
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			reads.push(path);
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: head }), { status: 200 });
		};
		const call = async (name: string, args: any) => JSON.parse((await parse(await handleVaultRpc(env, CTX, rpc("tools/call", { name, arguments: args })))).result.content[0].text);

		// First scan builds the index: reads every note once.
		const t1 = await call("vault_tags", {});
		expect(t1.tags.map((x: any) => x.tag).sort()).toEqual(["idea", "project"]);
		expect(reads.length).toBe(3);

		// Two more scans at the same HEAD read ZERO notes — served from the index blob.
		reads.length = 0;
		const q = await call("vault_query", { field: "status", value: "active" });
		expect(q.notes.map((x: any) => x.path)).toEqual(["Projects/sux.md"]);
		const bl = await call("vault_backlinks", { path: "Projects/sux.md" });
		expect(bl.backlinks.map((x: any) => x.path)).toEqual(["Notes/a.md"]);
		expect(reads.length).toBe(0);

		// A write lands (through the same vault) → the commit sha becomes the new HEAD
		// and the note cache is warmed inline → the index blob's sha no longer matches,
		// so the next scan rebuilds BEFORE returning and reflects the new note. Never
		// stale: a sux-driven write invalidates the index the moment it commits.
		head = "head-2";
		await call("vault_write", { path: "Notes/c.md", content: "---\nstatus: active\n---\nfresh" });
		reads.length = 0;
		const q2 = await call("vault_query", { field: "status", value: "active" });
		expect(q2.notes.map((x: any) => x.path).sort()).toEqual(["Notes/c.md", "Projects/sux.md"]);
	});

	it("scanVault index respects folder scoping and cap", async () => {
		const store = new Map<string, string>();
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
		const env = { OBSIDIAN_VAULT_REPO: "me/vault", OAUTH_KV: kv } as any;
		const notes: Record<string, string> = {
			"Projects/a.md": "#work",
			"Projects/b.md": "#work",
			"Notes/c.md": "#idea",
		};
		routes.handler = (url) => {
			if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: "h" } }), { status: 200 });
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "h" }), { status: 200 });
		};
		const call = async (name: string, args: any) => JSON.parse((await parse(await handleVaultRpc(env, CTX, rpc("tools/call", { name, arguments: args })))).result.content[0].text);

		const folder = await call("vault_tags", { folder: "Projects" });
		expect(folder.tags.map((x: any) => x.tag)).toEqual(["work"]); // Notes/c.md's #idea excluded
		expect(folder.scanned).toBe(2);

		const capped = await call("vault_tags", { cap: 1 });
		expect(capped.scanned).toBe(1);
		expect(capped.total).toBe(3);
		expect(capped.truncated).toBe(true);
	});

	it("vault_query JsonLogic filter + vault_patch on the git backend (§obsidian)", async () => {
		const call = async (name: string, args: any) => JSON.parse((await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name, arguments: args })))).result.content[0].text);
		const notes: Record<string, string> = {
			"P/a.md": "---\ntype: project\nstatus: active\n---\n# Log\nold",
			"P/b.md": "---\ntype: note\nstatus: active\n---\nx",
		};
		let putBody = "";
		routes.handler = (url, init) => {
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (init?.method === "PUT") {
				putBody = Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8");
				return new Response(JSON.stringify({ commit: { sha: "c1" } }), { status: 201 });
			}
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "s1" }), { status: 200 });
		};
		const q = await call("vault_query", { filter: { and: [{ "==": ["type", "project"] }, { "==": ["status", "active"] }] } });
		expect(q.notes.map((x: any) => x.path)).toEqual(["P/a.md"]); // only a.md is a project AND active

		const p = await call("vault_patch", { path: "P/a.md", heading: "Log", mode: "replace", content: "new entry" });
		expect(p.changed).toBe(true);
		expect(putBody).toContain("# Log\nnew entry"); // section body replaced, heading kept
	});

	it("vault_patch PUTs the read-time sha — a concurrent write yields a 409, not a silent lost update", async () => {
		let putSha: string | undefined;
		routes.handler = (url, init) => {
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (init?.method === "PUT") {
				putSha = JSON.parse(init.body).sha;
				return new Response(JSON.stringify({ message: "does not match" }), { status: 409 }); // note moved under us
			}
			if (path === "P/a.md") return new Response(JSON.stringify({ content: b64("---\ntype: project\n---\n# Log\nold"), sha: "read-sha" }), { status: 200 });
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		const out = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_patch", arguments: { path: "P/a.md", heading: "Log", content: "new" } })));
		expect(putSha).toBe("read-sha"); // the sha threaded from the read, not a re-fetched HEAD-at-write
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toMatch(/changed since read/);
	});

	it("codes the obvious error buckets via failWith ([bad_input]/[not_found])", async () => {
		routes.handler = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		const bad = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_query", arguments: {} })));
		expect(bad.result.isError).toBe(true);
		expect(bad.result.content[0].text).toMatch(/^\[bad_input\]/); // missing field/filter
		const gone = await parse(await handleVaultRpc(ENV, CTX, rpc("tools/call", { name: "vault_patch", arguments: { path: "missing.md", heading: "H", content: "x" } })));
		expect(gone.result.isError).toBe(true);
		expect(gone.result.content[0].text).toMatch(/^\[not_found\]/); // patch a note that isn't there
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
