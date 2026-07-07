import { describe, expect, it, vi } from "vitest";

// Mock the proxy seam obsidian fetches GitHub through.
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

	it("stubs the local backend with guidance", async () => {
		const r = await obsidian.run(ENV, { action: "read", path: "x.md", backend: "local" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/tailnet/);
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
		expect(putBody.sha).toBe("abc"); // updates the existing blob
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
