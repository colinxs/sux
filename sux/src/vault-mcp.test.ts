import { describe, expect, it, vi } from "vitest";

// The vault tools dispatch into the obsidian/ingest fns, whose git backend goes
// through the proxy seam — mock it exactly like fns/obsidian.test.ts does.
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response) }));
vi.mock("./proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { VAULT_TOOLS } from "./vault-mcp";

const ENV = { OBSIDIAN_VAULT_REPO: "me/vault" } as any;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
// The vault owner's LOCAL day (default Pacific) — NOT UTC. Computing this the
// same way the code does is the point: a UTC `date` here silently blessed the
// evening-rollover bug the review caught.
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const tool = (name: string) => VAULT_TOOLS.find((t) => t.name === name)!;
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("vault MCP tools", () => {
	it("exposes only cloud-truth tools (no live-vault dependencies in v1)", () => {
		const names = VAULT_TOOLS.map((t) => t.name);
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
			"vault_tasks",
			"vault_search_body",
			"vault_semantic",
		]);
		expect(names).not.toContain("vault_search"); // live-dependent — deferred to the vpc phase
		for (const t of VAULT_TOOLS) expect(t.inputSchema).toBeDefined();
	});

	it("vault_read serves through the git backend", async () => {
		routes.handler = (url) => {
			expect(url).toContain("/contents/Inbox%2Fidea.md");
			return new Response(JSON.stringify({ content: b64("# Idea"), sha: "s1" }), { status: 200 });
		};
		const out = await tool("vault_read").run(ENV, { path: "Inbox/idea.md" });
		expect(out.content[0].text).toBe("# Idea");
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

		const bl = parse(await tool("vault_backlinks").run(ENV, { path: "Projects/sux.md" }));
		expect(bl.backlinks.map((x: any) => x.path)).toEqual(["Notes/a.md"]); // [[sux]] resolves by basename

		const q = parse(await tool("vault_query").run(ENV, { field: "status", value: "active" }));
		expect(q.notes.map((x: any) => x.path)).toEqual(["Projects/sux.md"]);

		const t = parse(await tool("vault_tags").run(ENV, {}));
		expect(t.tags.map((x: any) => x.tag).sort()).toEqual(["idea", "project"]);
	});

	it("vault_tasks filters checkbox tasks by done/overdue, honoring 📅/🔁/^t- (GO condition 1a)", async () => {
		const notes: Record<string, string> = {
			"Daily/a.md": "- [ ] call plumber 📅 2020-01-01 ^t-abc\n- [x] done thing\n- [ ] no due date",
			"Daily/b.md": "```\n- [ ] not a real task (fenced)\n```\n- [ ] water plants 🔁 every week 📅 2999-01-01",
		};
		routes.handler = (url) => {
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "s1" }), { status: 200 });
		};

		const all = parse(await tool("vault_tasks").run(ENV, {}));
		expect(all.count).toBe(4); // fenced line excluded

		const overdue = parse(await tool("vault_tasks").run(ENV, { overdue: true }));
		expect(overdue.tasks).toEqual([expect.objectContaining({ path: "Daily/a.md", text: "call plumber", done: false, id: "t-abc", due: "2020-01-01" })]);

		const done = parse(await tool("vault_tasks").run(ENV, { done: true }));
		expect(done.tasks.map((t: any) => t.text)).toEqual(["done thing"]);

		const recurring = parse(await tool("vault_tasks").run(ENV, { overdue: false, done: false }));
		expect(recurring.tasks.find((t: any) => t.text.includes("water plants"))).toMatchObject({ recur: "every week", due: "2999-01-01" });
	});

	it("vault_search_body grep-quality-searches the indexed excerpt/keywords", async () => {
		const notes: Record<string, string> = {
			"Notes/a.md": "---\nstatus: draft\n---\nThe quarterly roadmap review happens Tuesday.",
			"Notes/b.md": "unrelated note about groceries",
		};
		routes.handler = (url) => {
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "s1" }), { status: 200 });
		};
		const r = parse(await tool("vault_search_body").run(ENV, { q: "roadmap" }));
		expect(r.hits.map((h: any) => h.path)).toEqual(["Notes/a.md"]);

		const empty = await tool("vault_search_body").run(ENV, {});
		expect(empty.isError).toBe(true);
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

		// First scan builds the index: reads every note once.
		const t1 = parse(await tool("vault_tags").run(env, {}));
		expect(t1.tags.map((x: any) => x.tag).sort()).toEqual(["idea", "project"]);
		expect(reads.length).toBe(3);

		// Two more scans at the same HEAD read ZERO notes — served from the index blob.
		reads.length = 0;
		const q = parse(await tool("vault_query").run(env, { field: "status", value: "active" }));
		expect(q.notes.map((x: any) => x.path)).toEqual(["Projects/sux.md"]);
		const bl = parse(await tool("vault_backlinks").run(env, { path: "Projects/sux.md" }));
		expect(bl.backlinks.map((x: any) => x.path)).toEqual(["Notes/a.md"]);
		expect(reads.length).toBe(0);

		// A write lands (through the same vault) → the commit sha becomes the new HEAD
		// and the note cache is warmed inline → the index blob's sha no longer matches,
		// so the next scan rebuilds BEFORE returning and reflects the new note. Never
		// stale: a sux-driven write invalidates the index the moment it commits.
		head = "head-2";
		await tool("vault_write").run(env, { path: "Notes/c.md", content: "---\nstatus: active\n---\nfresh" });
		reads.length = 0;
		const q2 = parse(await tool("vault_query").run(env, { field: "status", value: "active" }));
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

		const folder = parse(await tool("vault_tags").run(env, { folder: "Projects" }));
		expect(folder.tags.map((x: any) => x.tag)).toEqual(["work"]); // Notes/c.md's #idea excluded
		expect(folder.scanned).toBe(2);

		const capped = parse(await tool("vault_tags").run(env, { cap: 1 }));
		expect(capped.scanned).toBe(1);
		expect(capped.total).toBe(3);
		expect(capped.truncated).toBe(true);
	});

	it("scanVault folder scoping uses a slash-terminated prefix — folder:'Projects' excludes ProjectsArchive/", async () => {
		const store = new Map<string, string>();
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
		const env = { OBSIDIAN_VAULT_REPO: "me/vault", OAUTH_KV: kv } as any;
		const notes: Record<string, string> = {
			"Projects/a.md": "#in",
			"ProjectsArchive/b.md": "#out", // sibling folder with the scope name as a prefix
		};
		routes.handler = (url) => {
			if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: "h" } }), { status: 200 });
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "h" }), { status: 200 });
		};

		const folder = parse(await tool("vault_tags").run(env, { folder: "Projects" }));
		expect(folder.tags.map((x: any) => x.tag)).toEqual(["in"]); // ProjectsArchive/b.md's #out excluded
		expect(folder.scanned).toBe(1);
	});

	it("scanVault doesn't double-prefix list→read when OBSIDIAN_VAULT_DIR is set (would 404 every note)", async () => {
		const store = new Map<string, string>();
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
		const env = { OBSIDIAN_VAULT_REPO: "me/vault", OBSIDIAN_VAULT_DIR: "Vault", OAUTH_KV: kv } as any;
		// GitHub's tree listing is repo-relative — every note comes back dir-prefixed.
		const notes: Record<string, string> = { "Vault/Projects/sux.md": "#project" };
		routes.handler = (url) => {
			if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: "h" } }), { status: 200 });
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: "h" }), { status: 200 });
		};

		const t = parse(await tool("vault_tags").run(env, {}));
		expect(t.tags.map((x: any) => x.tag)).toEqual(["project"]);
		expect(t.scanned).toBe(1); // not silently dropped to 0 by a double-prefixed read 404
	});

	it("flags truncated when a per-note read fails during index build — even folder-scoped", async () => {
		// A note listed in the tree but failing to read (GitHub secondary-rate-limit 403
		// / 5xx on the read burst) is silently dropped from the index. That incompleteness
		// must surface as truncated:true — and must NOT be hidden once a `folder` is passed
		// (the bug the audit caught: the old `!prefix &&` guard swallowed idx.truncated).
		const store = new Map<string, string>();
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
		const env = { OBSIDIAN_VAULT_REPO: "me/vault", OAUTH_KV: kv } as any;
		const tree = ["Projects/a.md", "Projects/b.md", "Notes/c.md"];
		const body: Record<string, string> = { "Projects/a.md": "#work", "Notes/c.md": "#idea" }; // Projects/b.md absent → its read 404s
		routes.handler = (url) => {
			if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: "h" } }), { status: 200 });
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: tree.map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (body[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(body[path]), sha: "h" }), { status: 200 });
		};
		const all = parse(await tool("vault_tags").run(env, {}));
		expect(all.scanned).toBe(2); // b.md dropped from the index
		expect(all.truncated).toBe(true); // incompleteness flagged, not a confident undercount
		const folder = parse(await tool("vault_tags").run(env, { folder: "Projects" }));
		expect(folder.truncated).toBe(true); // propagates under folder scoping too
	});

	it("vault_query JsonLogic filter + vault_patch on the git backend (§obsidian)", async () => {
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
		const q = parse(await tool("vault_query").run(ENV, { filter: { and: [{ "==": ["type", "project"] }, { "==": ["status", "active"] }] } }));
		expect(q.notes.map((x: any) => x.path)).toEqual(["P/a.md"]); // only a.md is a project AND active

		const p = parse(await tool("vault_patch").run(ENV, { path: "P/a.md", heading: "Log", mode: "replace", content: "new entry" }));
		expect(p.changed).toBe(true);
		expect(putBody).toContain("# Log\nnew entry"); // section body replaced, heading kept
	});

	it("vault_patch retries a 409 (bounded) and succeeds once the concurrent write clears", async () => {
		// A concurrent writer landed between our first read (sha s1) and our write —
		// re-read + reapply the patch instead of hard-failing (same self-heal as
		// obsidian.ts's append/edit).
		let reads = 0;
		let puts = 0;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				puts++;
				const sha = JSON.parse(init.body).sha;
				if (sha === "s1") return new Response(JSON.stringify({ message: "does not match" }), { status: 409 });
				return new Response(JSON.stringify({ commit: { sha: "c2" } }), { status: 200 });
			}
			reads++;
			return new Response(JSON.stringify({ content: b64("---\ntype: project\n---\n# Log\nold"), sha: reads === 1 ? "s1" : "s2" }), { status: 200 });
		};
		const out = parse(await tool("vault_patch").run(ENV, { path: "P/a.md", heading: "Log", content: "new" }));
		expect(out).toMatchObject({ ok: true, changed: true });
		expect(puts).toBe(2); // 1st PUT 409s (sha s1), retry re-reads (sha s2) and lands
	});

	it("vault_patch surfaces a clear conflict after exhausting retries on a persistent 409", async () => {
		let puts = 0;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				puts++;
				return new Response(JSON.stringify({ message: "does not match" }), { status: 409 });
			}
			return new Response(JSON.stringify({ content: b64("---\ntype: project\n---\n# Log\nold"), sha: "s1" }), { status: 200 });
		};
		const out = await tool("vault_patch").run(ENV, { path: "P/a.md", heading: "Log", content: "new" });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/lost the race/);
		expect(puts).toBe(3); // RETRY_ATTEMPTS
	});

	it("codes the obvious error buckets via failWith ([bad_input]/[not_found])", async () => {
		routes.handler = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		const bad = await tool("vault_query").run(ENV, {});
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/^\[bad_input\]/); // missing field/filter
		const gone = await tool("vault_patch").run(ENV, { path: "missing.md", heading: "H", content: "x" });
		expect(gone.isError).toBe(true);
		expect(gone.content[0].text).toMatch(/^\[not_found\]/); // patch a note that isn't there
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
		const out = await tool("vault_daily_append").run(ENV, { content: "- [ ] task" });
		expect(out.isError).toBeFalsy();
		expect(putPath).toBe(`Daily/${date}.md`);
	});

	it("vault_delete refuses without confirm:true", async () => {
		const out = await tool("vault_delete").run(ENV, { path: "old.md" });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/confirm:true/);
	});

	it("vault_edit rides the surgical find/replace (unique-match contract)", async () => {
		routes.handler = () => new Response(JSON.stringify({ content: b64("x y x"), sha: "s" }), { status: 200 });
		const out = await tool("vault_edit").run(ENV, { path: "d.md", find: "x", replace: "z" });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/matches 2 times/);
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
		const out = await tool("vault_capture").run(ENV, { text: "quick thought", title: "Thought" });
		expect(out.isError).toBeFalsy();
		const note = parse(out);
		expect(note.note).toBe(`Inbox/${date} thought.md`);
		expect(puts[note.note]).toContain("type: capture");
	});

	it("path guards still bite through the MCP surface", async () => {
		const out = await tool("vault_write").run(ENV, { path: ".github/workflows/pwn.yml", content: "x" });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/Refusing vault path/);
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
		await tool("vault_daily_append").run(ENV, { content: "x" });
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
		await tool("vault_capture").run(ENV, { text: "jot", title: "Jot", path: "Home.md" });
		expect(putPath).toMatch(/^Inbox\//);
		expect(putPath).not.toBe("Home.md");
	});

	it("vault_semantic chunks+embeds every note (KV-cached, HEAD-keyed) and ranks by cosine similarity", async () => {
		const store = new Map<string, string>();
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
		// A keyword embedding — deterministic so kNN ranking is testable (mirrors advise.test.ts's embedVec).
		const embedVec = (t: string): number[] => {
			const s = t.toLowerCase();
			return [s.includes("sodium") ? 1 : 0, s.includes("exercise") ? 1 : 0, 0.1];
		};
		const run = vi.fn(async (_model: string, inputs: any) => ({ data: inputs.text.map(embedVec) }));
		const env = { OBSIDIAN_VAULT_REPO: "me/vault", OAUTH_KV: kv, AI: { run } } as any;
		const notes: Record<string, string> = {
			"Diet/plan.md": "Avoid sodium above 1500mg daily.",
			"Fitness/walk.md": "Walk for exercise thirty minutes.",
		};
		const head = "head-1";
		routes.handler = (url) => {
			if (url.includes("/git/ref/heads/")) return new Response(JSON.stringify({ object: { sha: head } }), { status: 200 });
			if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: Object.keys(notes).map((p) => ({ type: "blob", path: p })) }), { status: 200 });
			const m = /\/contents\/(.+?)(\?|$)/.exec(url);
			const path = m ? decodeURIComponent(m[1]) : "";
			if (notes[path] === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response(JSON.stringify({ content: b64(notes[path]), sha: head }), { status: 200 });
		};

		const r = parse(await tool("vault_semantic").run(env, { q: "how much sodium can I have" }));
		expect(r.hits[0].path).toBe("Diet/plan.md");
		expect(r.scanned).toBe(2);

		// A second call at the same HEAD serves the cached embedded index — only the new
		// query gets embedded, the corpus is NOT re-embedded (would be an unbounded AI cost).
		const callsAfterFirst = run.mock.calls.length;
		await tool("vault_semantic").run(env, { q: "exercise" });
		expect(run.mock.calls.length).toBe(callsAfterFirst + 1);
	});

	it("vault_semantic requires a `q` and the Workers-AI binding", async () => {
		const missingQ = await tool("vault_semantic").run(ENV, {});
		expect(missingQ.isError).toBe(true);

		const noAiEnv = { OBSIDIAN_VAULT_REPO: "me/vault", OAUTH_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as any;
		const noAi = await tool("vault_semantic").run(noAiEnv, { q: "test" });
		expect(noAi.isError).toBe(true);
		expect(noAi.content[0].text).toMatch(/Workers AI/);
	});
});
