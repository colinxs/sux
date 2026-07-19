import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the underlying dropbox fn — it has its own suite; here we test the namespace
// wiring + reshaping + the confirm gate. The mock echoes the op/args it received.
vi.mock("./fns/dropbox", () => ({
	dropbox: {
		inputSchema: { type: "object", additionalProperties: false, properties: { op: { type: "string" } } },
		run: vi.fn(async (_env: any, args: any) => ({ content: [{ type: "text", text: JSON.stringify({ op: args?.op, path: args?.path, data: args?.data, base64: args?.base64, cursor: args?.cursor }) }] })),
	},
}));

import { FILES_TOOLS } from "./files-mcp";
import { dropbox } from "./fns/dropbox";
import { toB64 } from "./fns/_util";

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

	it("files_read returns a textual body as {path,text} — never JSON.parses the file's own content", async () => {
		// The raw dropbox fn returns BARE TEXT for a textual (.json/.md/…) get. A .json file whose
		// contents are valid JSON must come back as {path,text} (mirroring Mode B's readFull shape),
		// not the parsed value — otherwise the caller gets a reshaped object instead of the file.
		runMock.mockImplementationOnce(async () => ({ content: [{ type: "text", text: '{"k":1}' }] }));
		const out = parse(await tool("files_read").run(env(), { path: "config.json" }));
		expect(out).toEqual({ path: "config.json", text: '{"k":1}' });
	});

	it("files_read still passes an oversize textual file's link-metadata through (JSON, not wrapped as text)", async () => {
		// The oversize branch of op:get returns JSON metadata (too_large_to_inline + link), even for a
		// .md path. The text-wrap must not swallow it — it stays a structured object.
		runMock.mockImplementationOnce(async () => ({ content: [{ type: "text", text: JSON.stringify({ path: "/big.md", size: 9e9, too_large_to_inline: true, url: "https://x" }) }] }));
		const out = parse(await tool("files_read").run(env(), { path: "big.md" }));
		expect(out).toMatchObject({ too_large_to_inline: true, url: "https://x" });
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

	it("app-folder write/upload reject the Mode-B stage-guard flags (stage/commit_token/force) — no silent immediate write", async () => {
		// rejectModeBFlags must also fence the stage guard: without full:true these flags do nothing,
		// so files_write({path,text,stage:true}) would overwrite immediately instead of previewing.
		for (const f of [{ stage: true }, { commit_token: "t" }, { force: true }] as const) {
			for (const name of ["files_write", "files_upload"] as const) {
				const base = name === "files_write" ? { path: "a.txt", text: "x" } : { path: "a.bin", base64: "AAAA" };
				const r = await tool(name).run(env(), { ...base, ...f });
				expect(r.isError, `${name} ${JSON.stringify(f)}`).toBe(true);
				expect(r.errorCode, `${name} ${JSON.stringify(f)}`).toBe("bad_input");
			}
		}
		expect(runMock).not.toHaveBeenCalled();
	});

	it("files_upload forwards op:put with base64", async () => {
		const out = parse(await tool("files_upload").run(env(), { path: "img.png", base64: "AAAA" }));
		expect(out).toMatchObject({ op: "put", path: "img.png", base64: "AAAA" });
	});

	// A `ref` (a sux /s/<uuid> CAS handle) resolves to bytes server-side so a session-
	// local binary lands in Dropbox WITHOUT the caller inlining base64 through context —
	// the write side of the same /s/ handle mail_send already accepts as an attachment.
	describe("files_upload ref → bytes (R2 CAS handle, no inline base64)", () => {
		const seeded = (uuid: string, key: string, bytes: Uint8Array, contentType = "application/pdf") =>
			({
				OAUTH_KV: { get: async (k: string) => (k === `store:${uuid}` ? JSON.stringify({ key, content_type: contentType }) : null), put: async () => {}, delete: async () => {} },
				R2: { get: async (k: string) => (k === key ? { arrayBuffer: async () => bytes.slice().buffer, httpMetadata: { contentType }, size: bytes.length, customMetadata: {} } : null), put: async () => {} },
			}) as any;

		it("resolves a /s/<uuid> ref to bytes and forwards op:put with the decoded base64", async () => {
			const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 5, 6, 7]);
			const e = seeded("11111111-1111-1111-1111-111111111111", "cas/abc", bytes);
			const out = parse(await tool("files_upload").run(e, { path: "doc.pdf", ref: "https://sux.example.dev/s/11111111-1111-1111-1111-111111111111" }));
			expect(out).toMatchObject({ op: "put", path: "doc.pdf", base64: toB64(bytes) });
		});

		it("accepts a bare uuid as the ref", async () => {
			const bytes = new Uint8Array([1, 2, 3, 4]);
			const e = seeded("22222222-2222-2222-2222-222222222222", "cas/def", bytes);
			const out = parse(await tool("files_upload").run(e, { path: "x.bin", ref: "22222222-2222-2222-2222-222222222222" }));
			expect(out).toMatchObject({ op: "put", base64: toB64(bytes) });
		});

		it("a missing/expired ref → not_found, no dropbox write", async () => {
			const e = { OAUTH_KV: { get: async () => null }, R2: { get: async () => null } } as any;
			const r = await tool("files_upload").run(e, { path: "x.bin", ref: "33333333-3333-3333-3333-333333333333" });
			expect(r.isError).toBe(true);
			expect(r.errorCode).toBe("not_found");
			expect(runMock).not.toHaveBeenCalled();
		});

		it("requires base64 or ref — neither is a bad_input", async () => {
			const r = await tool("files_upload").run(kvEnv(), { path: "x.bin" });
			expect(r.isError).toBe(true);
			expect(r.errorCode).toBe("bad_input");
			expect(runMock).not.toHaveBeenCalled();
		});
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

	it("files_delete STAGES by default and force:true applies it", async () => {
		const staged = parse(await tool("files_delete").run(kvEnv(), { path: "x" }));
		expect(staged).toMatchObject({ staged: true, kind: "dropbox_delete" });
		expect(staged.commit_token).toBeTruthy();
		expect(runMock).not.toHaveBeenCalled();
		const okd = parse(await tool("files_delete").run(kvEnv(), { path: "x", force: true }));
		expect(okd).toMatchObject({ op: "delete", path: "x" });
		expect(runMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: "delete", path: "x", force: true }));
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

	it("credential-only (read-armed) leaves whole-account WRITE dormant — write verbs fail closed until DROPBOX_FULL_WRITE_ENABLED", async () => {
		// The security boundary: DROPBOX_FULL_* alone lights up READ but NOT the injection-reachable
		// write/delete surface. Every write verb must fail closed with the arm-flag hint, mutating nothing.
		const readArmed = { DROPBOX_FULL_TOKEN: "ft" } as any; // credential set, WRITE flag UNSET
		const writeCases: Array<[string, any]> = [
			["files_write", { path: "/x.txt", text: "hi", full: true }],
			["files_upload", { path: "/x.bin", base64: "AAAA", full: true }],
			["files_delete", { path: "/x.txt", full: true }],
			["files_move", { from: "/a", to: "/b", full: true }],
			["files_operate", { action: "delete", handles: ["/a"] }],
			["files_transform", { op: "merge", sources: ["/a", "/b"], dest: "/out" }],
		];
		for (const [name, args] of writeCases) {
			const r = await tool(name).run(readArmed, args);
			expect(r.isError, name).toBe(true);
			expect(r.content[0].text, name).toMatch(/WRITE is not armed|DROPBOX_FULL_WRITE_ENABLED/);
		}
		expect(runMock).not.toHaveBeenCalled(); // Mode A untouched

		// Read verbs, by contrast, are live on the credential alone (they reach the network, not the gate).
		const origFetch = global.fetch;
		global.fetch = vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })) as any;
		try {
			const list = parse(await tool("files_list").run(readArmed, { path: "/Docs", full: true }));
			expect(list).toMatchObject({ scope: "full-dropbox" });
		} finally {
			global.fetch = origFetch;
		}
	});

	it("files_operate fails closed without DROPBOX_FULL_* and validates the action", async () => {
		const gated = await tool("files_operate").run(env(), { action: "move", handles: ["/a"], dest: "/b" });
		expect(gated.isError).toBe(true);
		expect(gated.content[0].text).toMatch(/DROPBOX_FULL_|not configured/);
		const badAction = await tool("files_operate").run({ DROPBOX_FULL_TOKEN: "ft", DROPBOX_FULL_WRITE_ENABLED: "1" } as any, { action: "frobnicate" });
		expect(badAction.isError).toBe(true);
		expect(badAction.content[0].text).toMatch(/must be 'move' or 'delete'/);
	});

	it("full delete STAGES by default — the destructive apply is gated behind the smart guard", async () => {
		const envFull = { DROPBOX_FULL_TOKEN: "ft", DROPBOX_FULL_WRITE_ENABLED: "1", OAUTH_KV: fakeKV() } as any;
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

		const envFull = { DROPBOX_FULL_TOKEN: "ft", DROPBOX_FULL_WRITE_ENABLED: "1" } as any; // configured + write-armed, but bad op never reaches the network
		const badOp = await tool("files_transform").run(envFull, { op: "frobnicate", dest: "/out" });
		expect(badOp.isError).toBe(true);
		expect(badOp.content[0].text).toMatch(/must be 'merge' or 'extract'/);

		const noDest = await tool("files_transform").run(envFull, { op: "merge", sources: ["/a", "/b"] });
		expect(noDest.isError).toBe(true);
		expect(noDest.content[0].text).toMatch(/requires a `dest`/);
	});

	it("files_transform surfaces a transformFull validation error as fail(...), not a throw", async () => {
		const envFull = { DROPBOX_FULL_TOKEN: "ft", DROPBOX_FULL_WRITE_ENABLED: "1" } as any; // reaches transformFull; merge<2 sources rejects before any network
		const r = await tool("files_transform").run(envFull, { op: "merge", sources: ["/only"], dest: "/out" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/at least 2/);
	});
});

