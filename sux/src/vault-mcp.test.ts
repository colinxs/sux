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
const date = new Date().toISOString().slice(0, 10);

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
			"vault_daily_read",
			"vault_daily_append",
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
});
