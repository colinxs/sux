import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the proxy seam the git backend fetches GitHub through. The remote backend
// uses global fetch (a public Funnel URL), which each remote test stubs directly.
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response) }));
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { obsidian } from "./obsidian";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const ENV = { OBSIDIAN_VAULT_REPO: "me/vault" } as any;

// Minimal KV stand-in for the read-through cache tests.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
	};
};

describe("obsidian (git backend)", () => {
	it("reports when the vault repo isn't configured", async () => {
		const r = await obsidian.run({} as any, { action: "list" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/OBSIDIAN_VAULT_REPO/);
	});

	it("points the local backend at remote", async () => {
		const r = await obsidian.run(ENV, { action: "read", path: "x.md", backend: "local" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/backend:'remote'|Funnel/);
	});

	it("lists only .md notes from the git tree", async () => {
		routes.handler = (url) => {
			expect(url).toContain("/git/trees/main?recursive=1");
			return new Response(JSON.stringify({ tree: [{ type: "blob", path: "a.md" }, { type: "blob", path: "img.png" }, { type: "tree", path: "dir" }, { type: "blob", path: "dir/b.md" }] }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "list" });
		expect(JSON.parse(r.content[0].text).notes).toEqual(["a.md", "dir/b.md"]);
	});

	it("reads a note and base64-decodes its content", async () => {
		routes.handler = (url) => {
			expect(url).toContain("/contents/note.md?ref=main");
			return new Response(JSON.stringify({ content: b64("# Hello\nbody"), sha: "abc" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "read", path: "note.md" });
		expect(r.content[0].text).toBe("# Hello\nbody");
	});

	it("appends to an existing note (reads sha, PUTs merged content)", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "def" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ content: b64("old"), sha: "abc" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "append", path: "log.md", content: "new line" });
		expect(r.isError).toBeFalsy();
		expect(putBody.sha).toBe("abc");
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("old\n\nnew line\n");
	});

	it("creates the note when appending to a missing path (404 → no sha)", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "def" } }), { status: 201 });
			}
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		const r = await obsidian.run(ENV, { action: "append", path: "new.md", content: "first" });
		expect(r.isError).toBeFalsy();
		expect(putBody.sha).toBeUndefined();
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("first\n");
	});

	it("writes (overwrites) a note, passing the existing sha", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "c1" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ content: b64("old body"), sha: "s1" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "write", path: "n.md", content: "fresh body" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, created: false, commit: "c1" });
		expect(putBody.sha).toBe("s1");
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("fresh body");
	});

	it("edits by read-modify-commit, replacing exactly the unique match", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "c2" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ content: b64("- [ ] task\nrest"), sha: "s2" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "edit", path: "d.md", find: "- [ ] task", replace: "- [x] task ✅ 2026-07-08" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, replaced: 1 });
		expect(putBody.sha).toBe("s2");
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("- [x] task ✅ 2026-07-08\nrest");
	});

	it("edit refuses an ambiguous match unless all:true", async () => {
		routes.handler = () => new Response(JSON.stringify({ content: b64("x y x"), sha: "s3" }), { status: 200 });
		const r = await obsidian.run(ENV, { action: "edit", path: "d.md", find: "x", replace: "z" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/matches 2 times/);

		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "c3" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ content: b64("x y x"), sha: "s3" }), { status: 200 });
		};
		const r2 = await obsidian.run(ENV, { action: "edit", path: "d.md", find: "x", replace: "z", all: true });
		expect(JSON.parse(r2.content[0].text)).toMatchObject({ ok: true, replaced: 2 });
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("z y z");
	});

	it("edit fails cleanly when the find text is absent", async () => {
		routes.handler = () => new Response(JSON.stringify({ content: b64("body"), sha: "s4" }), { status: 200 });
		const r = await obsidian.run(ENV, { action: "edit", path: "d.md", find: "nope", replace: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not found/);
	});

	it("edit keeps $-patterns in the replacement literal", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "c8" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ content: b64("price: 40 end"), sha: "s8" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "edit", path: "d.md", find: "price: 40", replace: "price: $$45 & $' more" });
		expect(r.isError).toBeFalsy();
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("price: $$45 & $' more end");
	});

	it("refuses dot-prefixed and traversal paths on mutating actions", async () => {
		for (const path of [".github/workflows/pwn.yml", "notes/../.obsidian/x.md", ".hidden.md"]) {
			const r = await obsidian.run(ENV, { action: "write", path, content: "x" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/Refusing vault path/);
		}
	});

	it("routes tools/call to the remote backend with a clear error on git", async () => {
		const r = await obsidian.run(ENV, { action: "tools" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/backend:'remote'/);
	});

	it("routes tools/call even when the git vault is unconfigured (remote-only env)", async () => {
		const remoteOnly = { OBSIDIAN_REMOTE_URL: "https://v.ts.net", OBSIDIAN_REMOTE_KEY: "k" } as any;
		const r = await obsidian.run(remoteOnly, { action: "call" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/backend:'remote'/); // NOT "set OBSIDIAN_VAULT_REPO"
		expect(r.content[0].text).not.toMatch(/OBSIDIAN_VAULT_REPO/);
	});

	it("normalizes action case/whitespace so 'READ ' is not an unknown action", async () => {
		routes.handler = () => new Response(JSON.stringify({ content: b64("hi"), sha: "s" }), { status: 200 });
		const r = await obsidian.run(ENV, { action: " READ ", path: "n.md" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("hi");
	});

	it("appends to a >1MB note without destroying its body (raw refetch)", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "cbig" } }), { status: 200 });
			}
			const accept = String(init?.headers?.Accept ?? "");
			if (accept.includes("raw")) return new Response("HUGE EXISTING BODY", { status: 200 });
			return new Response(JSON.stringify({ content: "", size: 2_000_000, sha: "sbig", encoding: "none" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "append", path: "big.md", content: "new tail" });
		expect(r.isError).toBeFalsy();
		expect(putBody.sha).toBe("sbig");
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("HUGE EXISTING BODY\n\nnew tail\n");
	});

	it("edits a >1MB note against its real body (raw refetch), not an empty string", async () => {
		let putBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "PUT") {
				putBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "cbig" } }), { status: 200 });
			}
			const accept = String(init?.headers?.Accept ?? "");
			if (accept.includes("raw")) return new Response("- [ ] task\nmuch more text", { status: 200 });
			return new Response(JSON.stringify({ content: "", size: 2_000_000, sha: "sbig" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "edit", path: "big.md", find: "- [ ] task", replace: "- [x] task" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, replaced: 1 });
		expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("- [x] task\nmuch more text");
	});

	it("reads a >1MB note via the raw refetch when contents omits the body", async () => {
		routes.handler = (url, init) => {
			const accept = init?.headers?.Accept ?? "";
			if (String(accept).includes("raw")) return new Response("BIG BODY", { status: 200 });
			return new Response(JSON.stringify({ content: "", size: 2_000_000, sha: "s9", encoding: "none" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "read", path: "big.md" });
		expect(r.content[0].text).toBe("BIG BODY");
	});

	it("deletes a note with its sha", async () => {
		let delBody: any;
		routes.handler = (url, init) => {
			if (init?.method === "DELETE") {
				delBody = JSON.parse(init.body);
				return new Response(JSON.stringify({ commit: { sha: "c5" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ content: b64("bye"), sha: "s5" }), { status: 200 });
		};
		const r = await obsidian.run(ENV, { action: "delete", path: "old.md" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, deleted: "old.md", commit: "c5" });
		expect(delBody.sha).toBe("s5");
	});
});

describe("obsidian (KV read-through cache)", () => {
	it("serves a git read from KV when the cached sha matches a fresh HEAD", async () => {
		const kv = fakeKV({
			"cache:vault:git:me/vault@main:head": JSON.stringify({ sha: "h1", at: Date.now() }),
			"cache:vault:git:me/vault@main:note:a.md": JSON.stringify({ body: "cached body", sha: "h1", at: 1, src: "git" }),
		});
		routes.handler = () => {
			throw new Error("GitHub should not be touched on a warm hit");
		};
		const r = await obsidian.run({ ...ENV, OAUTH_KV: kv }, { action: "read", path: "a.md" });
		expect(r.content[0].text).toBe("cached body");
	});

	it("revalidates a stale head, misses on sha change, and repopulates", async () => {
		const kv = fakeKV({
			"cache:vault:git:me/vault@main:head": JSON.stringify({ sha: "h1", at: 1 }), // stale → recheck
			"cache:vault:git:me/vault@main:note:a.md": JSON.stringify({ body: "old", sha: "h1", at: 1, src: "git" }),
		});
		routes.handler = (url) => {
			if (url.includes("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "h2" } }), { status: 200 });
			return new Response(JSON.stringify({ content: b64("fresh"), sha: "f1" }), { status: 200 });
		};
		const r = await obsidian.run({ ...ENV, OAUTH_KV: kv }, { action: "read", path: "a.md" });
		expect(r.content[0].text).toBe("fresh");
		expect(JSON.parse(kv.store.get("cache:vault:git:me/vault@main:note:a.md")!)).toMatchObject({ body: "fresh", sha: "h2" });
	});

	it("git writes warm the note cache and advance the cached HEAD", async () => {
		const kv = fakeKV();
		routes.handler = (url, init) => {
			if (init?.method === "PUT") return new Response(JSON.stringify({ commit: { sha: "c9" } }), { status: 201 });
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		};
		const r = await obsidian.run({ ...ENV, OAUTH_KV: kv }, { action: "write", path: "n.md", content: "body" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, created: true, commit: "c9" });
		expect(JSON.parse(kv.store.get("cache:vault:git:me/vault@main:note:n.md")!)).toMatchObject({ body: "body", sha: "c9" });
		expect(JSON.parse(kv.store.get("cache:vault:git:me/vault@main:head")!).sha).toBe("c9");
	});

	it("a leading-slash list path behaves like the root listing (no poisoned empty cache)", async () => {
		const kv = fakeKV({ "cache:vault:git:me/vault@main:head": JSON.stringify({ sha: "h1", at: Date.now() }) });
		routes.handler = () => new Response(JSON.stringify({ tree: [{ type: "blob", path: "a.md" }] }), { status: 200 });
		const r = await obsidian.run({ ...ENV, OAUTH_KV: kv }, { action: "list", path: "/" });
		expect(JSON.parse(r.content[0].text).notes).toEqual(["a.md"]);
	});

	it("bypasses the cache when the head ref is stale beyond the trust window and GitHub fails", async () => {
		const kv = fakeKV({
			"cache:vault:git:me/vault@main:head": JSON.stringify({ sha: "h1", at: Date.now() - 700_000 }),
			"cache:vault:git:me/vault@main:note:a.md": JSON.stringify({ body: "ancient", sha: "h1", at: 1, src: "git" }),
		});
		routes.handler = (url) => {
			if (url.includes("/git/ref/")) return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
			return new Response(JSON.stringify({ content: b64("fresh"), sha: "f1" }), { status: 200 });
		};
		const r = await obsidian.run({ ...ENV, OAUTH_KV: kv }, { action: "read", path: "a.md" });
		expect(r.content[0].text).toBe("fresh"); // ancient cached copy is NOT trusted
	});

	it("trusts a recently-cached head within the window when GitHub fails (bounded stale)", async () => {
		const kv = fakeKV({
			"cache:vault:git:me/vault@main:head": JSON.stringify({ sha: "h1", at: Date.now() - 120_000 }), // 2 min old: stale-recheck but < 10 min
			"cache:vault:git:me/vault@main:note:a.md": JSON.stringify({ body: "recent cached", sha: "h1", at: 1, src: "git" }),
		});
		let contentsCalls = 0;
		routes.handler = (url) => {
			if (url.includes("/git/ref/")) return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
			contentsCalls++;
			return new Response(JSON.stringify({ content: b64("fresh"), sha: "f1" }), { status: 200 });
		};
		const r = await obsidian.run({ ...ENV, OAUTH_KV: kv }, { action: "read", path: "a.md" });
		expect(r.content[0].text).toBe("recent cached"); // served from cache — HEAD still trusted
		expect(contentsCalls).toBe(0); // no GitHub contents round-trip
	});

	it("caches git lists per filter, keyed to HEAD", async () => {
		const kv = fakeKV({ "cache:vault:git:me/vault@main:head": JSON.stringify({ sha: "h1", at: Date.now() }) });
		let treeCalls = 0;
		routes.handler = (url) => {
			expect(url).toContain("/git/trees/");
			treeCalls++;
			return new Response(JSON.stringify({ tree: [{ type: "blob", path: "a.md" }] }), { status: 200 });
		};
		const env = { ...ENV, OAUTH_KV: kv };
		const r1 = await obsidian.run(env, { action: "list" });
		const r2 = await obsidian.run(env, { action: "list" });
		expect(treeCalls).toBe(1); // second list is a warm hit
		expect(r2.content[0].text).toBe(r1.content[0].text);
	});
});

describe("obsidian (remote backend — Funnel'd Local REST API)", () => {
	const REMOTE = { OBSIDIAN_REMOTE_URL: "https://vault.tailnet.ts.net/", OBSIDIAN_REMOTE_KEY: "sek" } as any;
	afterEach(() => vi.unstubAllGlobals());

	it("reports when the remote URL/key aren't configured", async () => {
		const r = await obsidian.run({} as any, { action: "list", backend: "remote" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/OBSIDIAN_REMOTE_URL/);
	});

	it("lists a directory via GET /vault/ with the bearer key", async () => {
		const fetchMock = vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toBe("https://vault.tailnet.ts.net/vault/");
			expect(init.headers.Authorization).toBe("Bearer sek");
			return new Response(JSON.stringify({ files: ["a.md", "sub/"] }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await obsidian.run(REMOTE, { action: "list", backend: "remote" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ dir: "/", count: 2, files: ["a.md", "sub/"] });
	});

	it("reads a note as text", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			expect(String(u)).toBe("https://vault.tailnet.ts.net/vault/notes/x.md");
			return new Response("# Hello", { status: 200 });
		}));
		const r = await obsidian.run(REMOTE, { action: "read", path: "notes/x.md", backend: "remote" });
		expect(r.content[0].text).toBe("# Hello");
	});

	it("searches via POST /search/simple/", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/search/simple/?query=todo");
			expect(init.method).toBe("POST");
			return new Response(JSON.stringify([{ filename: "a.md", score: 3 }]), { status: 200 });
		}));
		const r = await obsidian.run(REMOTE, { action: "search", query: "todo", backend: "remote" });
		expect(JSON.parse(r.content[0].text).hits[0]).toEqual({ path: "a.md", score: 3 });
	});

	it("appends by POSTing markdown to the note path", async () => {
		const fetchMock = vi.fn(async (u: string | URL, init?: any) => {
			expect(init.method).toBe("POST");
			expect(init.body).toBe("new line");
			expect(init.headers["Content-Type"]).toBe("text/markdown");
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await obsidian.run(REMOTE, { action: "append", path: "log.md", content: "new line", backend: "remote" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, path: "log.md" });
	});

	// A stateful Streamable-HTTP MCP mock: initialize hands out a session id, then
	// notifications/initialized (202), then the real call must carry the session.
	const mcpMock = (onCall: (body: any, init: any) => Response) =>
		vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toBe("https://vault.tailnet.ts.net/mcp/");
			expect(init.headers.Authorization).toBe("Bearer sek");
			const body = JSON.parse(init.body);
			if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "mcp-session-id": "sess-1" } });
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			expect(init.headers["Mcp-Session-Id"]).toBe("sess-1"); // real call carries the session
			return onCall(body, init);
		});

	it("wraps the vault MCP: action=tools handshakes then lists tools via /mcp/", async () => {
		vi.stubGlobal("fetch", mcpMock((body) => {
			expect(body.method).toBe("tools/list");
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "list_files", description: "List vault files" }, { name: "search", description: "Search" }] } }), { status: 200 });
		}));
		const r = await obsidian.run(REMOTE, { action: "tools", backend: "remote" });
		const out = JSON.parse(r.content[0].text);
		expect(out.via).toBe("mcp");
		expect(out.tools.map((t: any) => t.name)).toEqual(["list_files", "search"]);
	});

	it("wraps the vault MCP: action=call handshakes then invokes a tool (SSE parsed)", async () => {
		vi.stubGlobal("fetch", mcpMock((body) => {
			expect(body.method).toBe("tools/call");
			expect(body.params).toEqual({ name: "search", arguments: { query: "todo" } });
			return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "3 matches" }] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
		}));
		const r = await obsidian.run(REMOTE, { action: "call", tool: "search", tool_args: { query: "todo" }, backend: "remote" });
		expect(r.content[0].text).toBe("3 matches");
	});

	it("action=call requires a tool name", async () => {
		const r = await obsidian.run(REMOTE, { action: "call", backend: "remote" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires a `tool`/);
	});

	it("writes a note via PUT with markdown content-type", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toBe("https://vault.tailnet.ts.net/vault/n.md");
			expect(init.method).toBe("PUT");
			expect(init.headers["Content-Type"]).toBe("text/markdown");
			expect(init.body).toBe("whole body");
			return new Response(null, { status: 204 });
		}));
		const r = await obsidian.run(REMOTE, { action: "write", path: "n.md", content: "whole body", backend: "remote" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, path: "n.md" });
	});

	it("edits by GET then PUT of the surgically replaced body", async () => {
		let putBody: string | undefined;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (!init?.method || init.method === "GET") return new Response("- [ ] task\nrest", { status: 200 });
			expect(init.method).toBe("PUT");
			putBody = init.body;
			return new Response(null, { status: 204 });
		}));
		const r = await obsidian.run(REMOTE, { action: "edit", path: "d.md", find: "- [ ] task", replace: "- [x] task", backend: "remote" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, replaced: 1 });
		expect(putBody).toBe("- [x] task\nrest");
	});

	it("deletes a note via DELETE", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(init.method).toBe("DELETE");
			return new Response(null, { status: 204 });
		}));
		const r = await obsidian.run(REMOTE, { action: "delete", path: "old.md", backend: "remote" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, deleted: "old.md" });
	});

	it("read falls back to the KV copy when the Funnel is unreachable", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("connect timeout");
		}));
		const kv = fakeKV({ "cache:vault:remote:note:a.md": JSON.stringify({ body: "cached copy", sha: null, at: 1, src: "remote" }) });
		const r = await obsidian.run({ ...REMOTE, OAUTH_KV: kv }, { action: "read", path: "a.md", backend: "remote" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("cached copy");
	});

	it("read falls back to the KV copy on a Funnel 502 (Mac up, Obsidian down)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
		const kv = fakeKV({ "cache:vault:remote:note:a.md": JSON.stringify({ body: "cached 502 copy", sha: null, at: 1, src: "remote" }) });
		const r = await obsidian.run({ ...REMOTE, OAUTH_KV: kv }, { action: "read", path: "a.md", backend: "remote" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("cached 502 copy");
	});

	it("read fails with a git hint when unreachable and nothing is cached", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("connect timeout");
		}));
		const r = await obsidian.run({ ...REMOTE, OAUTH_KV: fakeKV() }, { action: "read", path: "a.md", backend: "remote" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/backend:'git'/);
	});

	it("successful remote reads write through to KV", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("# Live", { status: 200 })));
		const kv = fakeKV();
		const r = await obsidian.run({ ...REMOTE, OAUTH_KV: kv }, { action: "read", path: "notes/x.md", backend: "remote" });
		expect(r.content[0].text).toBe("# Live");
		expect(JSON.parse(kv.store.get("cache:vault:remote:note:notes/x.md")!)).toMatchObject({ body: "# Live", src: "remote" });
	});
});
