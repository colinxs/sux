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

	it("files_upload forwards op:put with base64", async () => {
		const out = parse(await tool("files_upload").run(env(), { path: "img.png", base64: "AAAA" }));
		expect(out).toMatchObject({ op: "put", path: "img.png", base64: "AAAA" });
	});

	it("files_share forwards op:share", async () => {
		const out = parse(await tool("files_share").run(env(), { path: "x" }));
		expect(out).toMatchObject({ op: "share", path: "x" });
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
		expect(names).toContain("dropbox");
	});

	it("rejects an unknown tool", async () => {
		const body = await sseJson(await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }));
		expect(body.error.code).toBe(-32601);
	});
});
