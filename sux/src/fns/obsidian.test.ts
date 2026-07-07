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

	it("wraps the vault MCP: action=tools lists tools via /mcp/", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toBe("https://vault.tailnet.ts.net/mcp/");
			expect(init.headers.Authorization).toBe("Bearer sek");
			expect(JSON.parse(init.body).method).toBe("tools/list");
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_files", description: "List vault files" }, { name: "search", description: "Search" }] } }), { status: 200 });
		}));
		const r = await obsidian.run(REMOTE, { action: "tools", backend: "remote" });
		const out = JSON.parse(r.content[0].text);
		expect(out.via).toBe("mcp");
		expect(out.tools.map((t: any) => t.name)).toEqual(["list_files", "search"]);
	});

	it("wraps the vault MCP: action=call invokes a tool and returns its text (SSE parsed)", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const body = JSON.parse(init.body);
			expect(body.method).toBe("tools/call");
			expect(body.params).toEqual({ name: "search", arguments: { query: "todo" } });
			// Streamable-HTTP style SSE response
			return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "3 matches" }] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
		}));
		const r = await obsidian.run(REMOTE, { action: "call", tool: "search", tool_args: { query: "todo" }, backend: "remote" });
		expect(r.content[0].text).toBe("3 matches");
	});

	it("action=call requires a tool name", async () => {
		const r = await obsidian.run(REMOTE, { action: "call", backend: "remote" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires a `tool`/);
	});
});
