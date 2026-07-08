import { type JsonRpc, sseResponse } from "./mcp-util";
import { fail, type RtEnv, type ToolResult } from "./registry";
import { ingest } from "./fns/ingest";
import { obsidian } from "./fns/obsidian";

// The vault MCP server — our rolled-own obsidian-web-mcp (prior art:
// github.com/jimprosser/obsidian-web-mcp), kept on OUR Workers implementation.
// Served at /vault/mcp behind the same workers-oauth-provider flow claude.ai
// already accepts for /mcp, so it appears as its own "vault" connector in
// claude.ai / mobile / desktop with zero new public surface and zero new infra.
//
// The source of truth is in the cloud: tools read and write the git store
// (GitHub colinxs/vault — every write a revertible commit, KV-cached) and work
// with NO box awake. The live vault (remote/vpc backend) is used only where git
// cannot serve: full-text search (GitHub code search is dead on private repos).
//
// Stolen from the prior art: confirm-gated delete, daily-note verbs, tight
// per-tool schemas. Deliberately NOT ours to re-implement: its OAuth server
// (the provider does PKCE + dynamic client registration already), its atomic
// temp+rename writes (git commits are atomic; live-vault writes go through
// Obsidian's own adapter), its path guards (badVaultPath in fns/obsidian.ts).
const DAILY_DIR = "Daily";
const today = () => new Date().toISOString().slice(0, 10);
const dailyPath = () => `${DAILY_DIR}/${today()}.md`;

type VaultTool = {
	name: string;
	description: string;
	inputSchema: unknown;
	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};

const git = (args: Record<string, unknown>) => ({ ...args, backend: "git" });

const TOOLS: VaultTool[] = [
	{
		name: "vault_read",
		description: "Read a note from the vault (cloud git store, KV-cached — always available).",
		inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "Note path, e.g. Inbox/idea.md" } } },
		run: (env, a) => obsidian.run(env, git({ action: "read", path: a?.path })),
	},
	{
		name: "vault_list",
		description: "List notes in the vault, optionally under a folder.",
		inputSchema: { type: "object", additionalProperties: false, properties: { folder: { type: "string", description: "Folder filter, e.g. Projects" } } },
		run: (env, a) => obsidian.run(env, git({ action: "list", ...(a?.folder ? { path: a.folder } : {}) })),
	},
	// Cloud tools only in v1 (Colin, 2026-07-08): no live-vault dependencies here.
	// Full-text search needs the live host (GitHub code search is dead on private
	// repos) — it lands with the tier-2 vpc backend. Desktop keeps live-vault MCP
	// through the local mcp-gate wrapper meanwhile.
	{
		name: "vault_write",
		description: "Create or overwrite a note. Every write is a git commit — history is the undo.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string", description: "Full markdown body." } } },
		run: (env, a) => obsidian.run(env, git({ action: "write", path: a?.path, content: a?.content })),
	},
	{
		name: "vault_append",
		description: "Append markdown to a note, creating it if absent.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
		run: (env, a) => obsidian.run(env, git({ action: "append", path: a?.path, content: a?.content })),
	},
	{
		name: "vault_edit",
		description: "Surgical find/replace in a note. `find` must match exactly once unless `all` is set — an edit never lands somewhere unintended.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "find", "replace"],
			properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean", default: false } },
		},
		run: (env, a) => obsidian.run(env, git({ action: "edit", path: a?.path, find: a?.find, replace: a?.replace, ...(a?.all === true ? { all: true } : {}) })),
	},
	{
		name: "vault_delete",
		description: "Delete a note (git history keeps it recoverable). Requires confirm:true.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "confirm"], properties: { path: { type: "string" }, confirm: { type: "boolean", description: "Must be true — a deliberate two-step, stolen from obsidian-web-mcp." } } },
		run: (env, a) => (a?.confirm === true ? obsidian.run(env, git({ action: "delete", path: a?.path })) : Promise.resolve(fail("vault_delete requires confirm:true."))),
	},
	{
		name: "vault_capture",
		description:
			"Capture into the vault Inbox with provenance frontmatter: exactly one of url (page → markdown; files become attachments), text, or query (web-search results). Optional summarize/compress passes. Never overwrites — collisions disambiguate.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: { type: "string" },
				text: { type: "string" },
				query: { type: "string" },
				title: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				summarize: { type: "boolean", default: false },
				compress: { type: "boolean", default: false },
			},
		},
		run: (env, a) => ingest.run(env, a ?? {}),
	},
	{
		name: "vault_daily_read",
		description: "Read today's daily note.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: (env) => obsidian.run(env, git({ action: "read", path: dailyPath() })),
	},
	{
		name: "vault_daily_append",
		description: "Append to today's daily note (created if absent) — the quick-capture surface for tasks and jots.",
		inputSchema: { type: "object", additionalProperties: false, required: ["content"], properties: { content: { type: "string", description: "Markdown to add, e.g. '- [ ] call the plumber'." } } },
		run: (env, a) => obsidian.run(env, git({ action: "append", path: dailyPath(), content: a?.content })),
	},
];

export const VAULT_TOOLS = TOOLS;

// Mirrors handleRpc's protocol shell (initialize / notifications / tools) with
// the vault registry instead of FUNCTIONS. Stateless per request, like the main
// server: the MCP session is a per-call formality, all state lives in the store.
export async function handleVaultRpc(env: RtEnv, _ctx: ExecutionContext, rpc: JsonRpc | undefined): Promise<Response> {
	const method = rpc?.method;
	const id = rpc?.id ?? null;

	if (!method) return new Response(null, { status: 202 });
	if (method === "initialize") {
		return sseResponse({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "vault", version: "0.1.0" },
			},
		});
	}
	if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
	if (method === "tools/list") {
		return sseResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
	}
	if (method === "tools/call") {
		const name = String(rpc?.params?.name ?? "");
		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
		try {
			const result = await tool.run(env, rpc?.params?.arguments ?? {});
			return sseResponse({ jsonrpc: "2.0", id, result });
		} catch (e) {
			return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${name} failed: ${String((e as Error).message ?? e)}` }], isError: true } });
		}
	}
	return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}
