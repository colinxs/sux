import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the underlying dropbox fn — it has its own suite; here we test the namespace
// wiring + reshaping + the confirm gate. The mock echoes the op/args it received.
vi.mock("./fns/dropbox", () => ({
	dropbox: {
		inputSchema: { type: "object", additionalProperties: false, properties: { op: { type: "string" } } },
		run: vi.fn(async (_env: any, args: any) => ({ content: [{ type: "text", text: JSON.stringify({ op: args?.op, path: args?.path, data: args?.data, base64: args?.base64, cursor: args?.cursor }) }] })),
	},
}));

import { FILES_TOOLS, handleFilesRpc } from "./files-mcp";
import { dropbox } from "./fns/dropbox";

const env = () => ({}) as any;
const fakeKV = () => {
	const s = new Map<string, string>();
	return { get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) };
};
const kvEnv = () => ({ OAUTH_KV: fakeKV() }) as any;
const tool = (n: string) => FILES_TOOLS.find((t) => t.name === n)!;
const parse = (r: any) => JSON.parse(r.content[0].text);
const runMock = dropbox.run as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

describe("files_* tools", () => {
	it("files_list forwards op:list (+ optional path/cursor)", async () => {
		const out = parse(await tool("files_list").run(env(), { path: "Docs" }));
		expect(out).toMatchObject({ op: "list", path: "Docs" });
	});

	it("files_read forwards op:get", async () => {
		const out = parse(await tool("files_read").run(env(), { path: "a.pdf" }));
		expect(out).toMatchObject({ op: "get", path: "a.pdf" });
	});

	it("files_write forwards op:put with text data", async () => {
		const out = parse(await tool("files_write").run(env(), { path: "note.txt", text: "hi" }));
		expect(out).toMatchObject({ op: "put", path: "note.txt", data: "hi" });
	});

	it("app-folder write rejects Mode-B-only flags instead of silently dropping the guardrail", async () => {
		const r = await tool("files_write").run(env(), { path: "a.txt", text: "x", overwrite: false });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/apply only to whole-Dropbox|full:true/);
		expect(runMock).not.toHaveBeenCalled();
		const okd = parse(await tool("files_write").run(env(), { path: "a.txt", text: "x" })); // plain write still works
		expect(okd).toMatchObject({ op: "put", path: "a.txt", data: "x" });
	});

	it("files_upload forwards op:put with base64", async () => {
		const out = parse(await tool("files_upload").run(env(), { path: "img.png", base64: "AAAA" }));
		expect(out).toMatchObject({ op: "put", path: "img.png", base64: "AAAA" });
	});

	it("files_share forwards op:share", async () => {
		const out = parse(await tool("files_share").run(env(), { path: "x" }));
		expect(out).toMatchObject({ op: "share", path: "x" });
	});

	it("files_move forwards op:move (from→to)", async () => {
		const out = parse(await tool("files_move").run(env(), { from: "a.pdf", to: "archive/a.pdf" }));
		expect(out).toMatchObject({ op: "move", path: "a.pdf" });
		const bad = await tool("files_move").run(env(), { from: "a.pdf" });
		expect(bad.isError).toBe(true);
	});

	it("files_delete requires confirm:true", async () => {
		const blocked = await tool("files_delete").run(env(), { path: "x" });
		expect(blocked.isError).toBe(true);
		expect(runMock).not.toHaveBeenCalled();
		const okd = parse(await tool("files_delete").run(env(), { path: "x", confirm: true }));
		expect(okd).toMatchObject({ op: "delete", path: "x" });
	});

	it("missing required args fail without calling dropbox", async () => {
		expect((await tool("files_read").run(env(), {})).isError).toBe(true);
		expect((await tool("files_write").run(env(), { path: "x" })).isError).toBe(true);
		expect(runMock).not.toHaveBeenCalled();
	});

	it("exposes the raw dropbox escape hatch", () => {
		expect(tool("dropbox")).toBeTruthy();
	});

	it("codes error buckets via failWith: [bad_input] for missing required, [not_configured] for the Mode-B gate", async () => {
		const missing = await tool("files_read").run(env(), {}); // missing required `path`
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toMatch(/^\[bad_input\]/);
		expect(missing.errorCode).toBe("bad_input");

		const gate = await tool("files_search").run(env(), { query: "x" }); // Mode-B credential absent
		expect(gate.isError).toBe(true);
		expect(gate.content[0].text).toMatch(/^\[not_configured\]/);
		expect(gate.errorCode).toBe("not_configured");

		const flag = await tool("files_write").run(env(), { path: "a.txt", text: "x", overwrite: true }); // Mode-B-only flag on an app-folder write
		expect(flag.isError).toBe(true);
		expect(flag.errorCode).toBe("bad_input");
	});
});

describe("files_batch_put (app-folder batch write, idempotent)", () => {
	it("fans out puts and reports per item", async () => {
		const out = parse(await tool("files_batch_put").run(kvEnv(), { items: [{ path: "a.txt", text: "x" }, { path: "b.png", base64: "AAAA" }] }));
		expect(out.count).toBe(2);
		expect(runMock).toHaveBeenCalledTimes(2);
		expect(out.results[0]).toMatchObject({ path: "a.txt" });
	});

	it("is idempotent — a re-run with the same path+content skips, no re-put", async () => {
		const e = kvEnv();
		await tool("files_batch_put").run(e, { items: [{ path: "a.txt", text: "x" }] });
		runMock.mockClear();
		const out = parse(await tool("files_batch_put").run(e, { items: [{ path: "a.txt", text: "x" }] }));
		expect(out.results[0].skipped).toMatch(/idempotent/);
		expect(runMock).not.toHaveBeenCalled();
	});

	it("dry_run previews without writing", async () => {
		const out = parse(await tool("files_batch_put").run(kvEnv(), { items: [{ path: "a.txt", text: "x" }], dry_run: true }));
		expect(out.dry_run).toBe(true);
		expect(out.results[0]).toMatchObject({ path: "a.txt", would_write: "text" });
		expect(runMock).not.toHaveBeenCalled();
	});

	it("rejects an empty items list", async () => {
		expect((await tool("files_batch_put").run(kvEnv(), { items: [] })).isError).toBe(true);
	});
});

describe("full-Dropbox (Mode B) gating — dormant without DROPBOX_FULL_*", () => {
	it("files_search fails closed with a config hint and never touches dropbox", async () => {
		const r = await tool("files_search").run(env(), { query: "invoice" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		expect(runMock).not.toHaveBeenCalled();
	});

	it("files_search still validates query before the config gate", async () => {
		const r = await tool("files_search").run(env(), {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires a `query`/);
	});

	it("files_read full:true fails closed but plain reads still route to Mode A", async () => {
		const gated = await tool("files_read").run(env(), { path: "/x.pdf", full: true });
		expect(gated.isError).toBe(true);
		expect(gated.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		expect(runMock).not.toHaveBeenCalled();
		const modeA = parse(await tool("files_read").run(env(), { path: "a.pdf" }));
		expect(modeA).toMatchObject({ op: "get", path: "a.pdf" }); // Mode A untouched
	});

	it("files_list full:true fails closed while plain listing routes to Mode A", async () => {
		const gated = await tool("files_list").run(env(), { path: "/Documents", full: true });
		expect(gated.isError).toBe(true);
		expect(gated.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		const modeA = parse(await tool("files_list").run(env(), {}));
		expect(modeA).toMatchObject({ op: "list" });
	});

	it("full-mode write/upload/delete/move fail closed without DROPBOX_FULL_* and never fall through to Mode A", async () => {
		const cases: Array<[string, any]> = [
			["files_write", { path: "/x.txt", text: "hi", full: true }],
			["files_upload", { path: "/x.bin", base64: "AAAA", full: true }],
			["files_delete", { path: "/x.txt", full: true }],
			["files_move", { from: "/a", to: "/b", full: true }],
		];
		for (const [name, args] of cases) {
			const r = await tool(name).run(env(), args);
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		}
		expect(runMock).not.toHaveBeenCalled(); // Mode A (the mocked dropbox fn) is never touched
	});

	it("files_operate fails closed without DROPBOX_FULL_* and validates the action", async () => {
		const gated = await tool("files_operate").run(env(), { action: "move", handles: ["/a"], dest: "/b" });
		expect(gated.isError).toBe(true);
		expect(gated.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		const badAction = await tool("files_operate").run({ DROPBOX_FULL_TOKEN: "ft" } as any, { action: "frobnicate" });
		expect(badAction.isError).toBe(true);
		expect(badAction.content[0].text).toMatch(/must be 'move' or 'delete'/);
	});

	it("full delete STAGES by default — the destructive apply is gated behind the smart guard", async () => {
		const envFull = { DROPBOX_FULL_TOKEN: "ft", OAUTH_KV: fakeKV() } as any;
		const origFetch = global.fetch;
		const calls: string[] = [];
		global.fetch = vi.fn(async (url: any) => {
			const u = String(url);
			calls.push(u);
			if (u.includes("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", name: "x.txt", path_display: "/x.txt", size: 3, rev: "r1" }), { status: 200 });
			return new Response(JSON.stringify({ metadata: { path_display: "/x.txt" } }), { status: 200 });
		}) as any;
		try {
			// No stage/force/commit_token → the guard STAGES it (files_delete_full is annotated irreversible),
			// so the destructive delete_v2 never fires — you must come back with the commit_token or force:true.
			const staged = parse(await tool("files_delete").run(envFull, { path: "/x.txt", full: true }));
			expect(staged).toMatchObject({ staged: true, kind: "files_delete_full" });
			expect(staged.commit_token).toBeTruthy();
			expect(calls.some((u) => u.includes("/files/delete_v2"))).toBe(false); // nothing deleted at the stage step
			expect(runMock).not.toHaveBeenCalled(); // Mode A untouched
		} finally {
			global.fetch = origFetch;
		}
	});

	it("files_transform fails closed without DROPBOX_FULL_* and validates op + dest", async () => {
		const gated = await tool("files_transform").run(env(), { op: "merge", sources: ["/a", "/b"], dest: "/out" });
		expect(gated.isError).toBe(true);
		expect(gated.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		expect(runMock).not.toHaveBeenCalled(); // Mode A untouched

		const envFull = { DROPBOX_FULL_TOKEN: "ft" } as any; // configured, but bad op never reaches the network
		const badOp = await tool("files_transform").run(envFull, { op: "frobnicate", dest: "/out" });
		expect(badOp.isError).toBe(true);
		expect(badOp.content[0].text).toMatch(/must be 'merge' or 'extract'/);

		const noDest = await tool("files_transform").run(envFull, { op: "merge", sources: ["/a", "/b"] });
		expect(noDest.isError).toBe(true);
		expect(noDest.content[0].text).toMatch(/requires a `dest`/);
	});

	it("files_transform surfaces a transformFull validation error as fail(...), not a throw", async () => {
		const envFull = { DROPBOX_FULL_TOKEN: "ft" } as any; // reaches transformFull; merge<2 sources rejects before any network
		const r = await tool("files_transform").run(envFull, { op: "merge", sources: ["/only"], dest: "/out" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/at least 2/);
	});
});

describe("handleFilesRpc protocol shell", () => {
	const call = (rpc: any) => handleFilesRpc(env(), {} as any, rpc, 0);
	const sseJson = async (r: Response) => {
		const t = await r.text();
		const line = t.split("\n").find((l) => l.startsWith("data:")) ?? t;
		return JSON.parse(line.replace(/^data:\s*/, ""));
	};

	it("initialize announces the files server", async () => {
		const body = await sseJson(await call({ jsonrpc: "2.0", id: 1, method: "initialize" }));
		expect(body.result.serverInfo.name).toBe("files");
	});

	it("tools/list includes files_* and the raw dropbox hatch", async () => {
		const body = await sseJson(await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
		const names = body.result.tools.map((t: any) => t.name);
		expect(names).toContain("files_list");
		expect(names).toContain("files_search");
		expect(names).toContain("dropbox");
	});

	it("tools/list carries behavior hints on reads and the destructive verbs", async () => {
		const body = await sseJson(await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
		const byName = new Map<string, any>(body.result.tools.map((t: any) => [t.name, t]));
		expect(byName.get("files_read")?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
		expect(byName.get("files_delete")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(byName.get("dropbox")?.annotations).toMatchObject({ destructiveHint: true }); // raw escape hatch
		expect("annotations" in (byName.get("files_write") as object)).toBe(false); // gated/recoverable → unlisted
	});

	it("rejects an unknown tool", async () => {
		const body = await sseJson(await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }));
		expect(body.error.code).toBe(-32601);
	});
});
