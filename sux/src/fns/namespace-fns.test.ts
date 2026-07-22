import { afterEach, describe, expect, it, vi } from "vitest";

// Vault tools dispatch into obsidian's git backend through the proxy seam — mock it
// exactly like vault-mcp.test.ts. Mail tools compile to the jmap conduit over
// global.fetch (mocked per-test below), so the two seams don't collide.
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response) }));
vi.mock("../proxy", async (importOriginal) => ({
	...(await importOriginal<typeof import("../proxy")>()),
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import type { RtEnv, ToolResult } from "../registry";
import { FRONT_VERBS, frontToolList, ok } from "../registry";
import { FILES_TOOLS } from "../files-mcp";
import { MAIL_TOOLS } from "../mail-mcp";
import { VAULT_TOOLS } from "../vault-mcp";
import { handleRpc } from "../index";
import { extractRpcFromText, type JsonRpc } from "../mcp-util";
import { FUNCTIONS } from "./index";
import { type Dispatch, namespaceFn, reachedTools } from "./_namespace";
import { vault, VAULT_ACTIONS } from "./vault";
import { files, FILES_ACTIONS } from "./files";
import { mail, MAIL_ACTIONS } from "./mail";
import { calendar, CALENDAR_ACTIONS } from "./calendar";
import { contact, CONTACT_ACTIONS } from "./contact";

afterEach(() => vi.restoreAllMocks());

// ── Factory logic (synthetic tools — deterministic, no env/network) ──────────────
// A stub tool that echoes back the exact args object it received, so we can assert
// what the dispatcher passed through. `properties` mirrors a real tool's declared
// inputSchema.properties — the dispatcher validates caller args against it (#1312).
const echoTool = (name: string, properties: Record<string, unknown> = {}) => ({
	name,
	description: name,
	inputSchema: { type: "object", additionalProperties: false, properties },
	run: async (_e: RtEnv, a: any): Promise<ToolResult> => ok(JSON.stringify(a)),
});
const seen = (r: ToolResult) => JSON.parse(r.content[0].text);
const env = {} as RtEnv;

describe("namespaceFn dispatcher", () => {
	const fn = namespaceFn({
		name: "demo",
		description: "demo",
		tools: () => [echoTool("t_read", { path: {}, n: {} }), echoTool("t_op", { dest: {} })],
		actions: { read: "t_read", op_move: { tool: "t_op", inject: { action: "move" } } },
	});

	it("strips the verb-level `action` before reaching the target tool", async () => {
		const got = seen(await fn.run(env, { action: "read", path: "/x", n: 3 }));
		expect(got).toEqual({ path: "/x", n: 3 });
		expect("action" in got).toBe(false);
	});

	it("re-injects the inner action for a flattened verb", async () => {
		const got = seen(await fn.run(env, { action: "op_move", dest: "/y" }));
		expect(got).toEqual({ dest: "/y", action: "move" });
	});

	it("rejects a missing/unknown action with the valid list", async () => {
		const bad = await fn.run(env, { action: "nope" });
		expect(bad.isError).toBe(true);
		expect(bad.errorCode).toBe("bad_input");
		expect(bad.content[0].text).toContain("read, op_move");
		const missing = await fn.run(env, {});
		expect(missing.errorCode).toBe("bad_input");
	});

	it("rejects an unknown per-action arg instead of silently dropping it (#1312)", async () => {
		const bad = await fn.run(env, { action: "read", path: "/x", bogus: 1 });
		expect(bad.isError).toBe(true);
		expect(bad.errorCode).toBe("bad_input");
		expect(bad.content[0].text).toContain("bogus");
		expect(bad.content[0].text).toContain("path");
	});

	it("reports a not_configured error when an action targets an unregistered tool", async () => {
		const broken = namespaceFn({ name: "x", description: "x", tools: () => [], actions: { read: "ghost" } });
		const r = await broken.run(env, { action: "read" });
		expect(r.errorCode).toBe("not_configured");
	});

	it("marks each verb as a raw front-surface tool that requires `action`", () => {
		for (const v of [vault, mail, files, calendar, contact]) {
			expect(v.surface).toBe("front");
			expect(v.raw).toBe(true);
			expect((v.inputSchema as any).required).toContain("action");
		}
	});

	it("explicitly types array-shaped params in the outer schema so clients don't drop them (#225)", () => {
		// A bare additionalProperties:true left mail_move/archive `ids[]` untyped at the front
		// door and some MCP clients dropped it. `ids` is now a declared string-array.
		const ids = (mail.inputSchema as any).properties?.ids;
		expect(ids).toMatchObject({ type: "array", items: { type: "string" } });
		expect((mail.inputSchema as any).additionalProperties).toBe(true); // other per-action fields still ride through
	});
});

// ── Completeness: every namespace tool is reachable through exactly one verb ──────
describe("namespace verbs cover their tool arrays", () => {
	it("vault reaches every VAULT_TOOLS tool", () => {
		expect(reachedTools(VAULT_ACTIONS)).toEqual(new Set(VAULT_TOOLS.map((t) => t.name)));
	});

	it("files reaches every FILES_TOOLS tool except the `dropbox` escape", () => {
		expect(reachedTools(FILES_ACTIONS)).toEqual(new Set(FILES_TOOLS.map((t) => t.name).filter((n) => n !== "dropbox")));
	});

	it("mail+calendar+contact together reach every MAIL_TOOLS tool except the raw `jmap` conduit", () => {
		const union = new Set<string>([...reachedTools(MAIL_ACTIONS), ...reachedTools(CALENDAR_ACTIONS), ...reachedTools(CONTACT_ACTIONS)]);
		expect(union).toEqual(new Set(MAIL_TOOLS.map((t) => t.name).filter((n) => n !== "jmap")));
	});

	it("no tool is reachable through two verbs (mail/calendar/contact partition MAIL_TOOLS)", () => {
		const lists = [reachedTools(MAIL_ACTIONS), reachedTools(CALENDAR_ACTIONS), reachedTools(CONTACT_ACTIONS)].flatMap((s) => [...s]);
		expect(lists.length).toBe(new Set(lists).size);
	});
});

// ── Real dispatch parity: the verb reaches the SAME handler as /<ns>/mcp ──────────
describe("vault verb dispatches into VAULT_TOOLS byte-identically", () => {
	const vaultEnv = { OBSIDIAN_VAULT_REPO: "me/vault" } as unknown as RtEnv;
	// A fixed response for every git call → both dispatch paths produce identical output.
	const wire = () => (routes.handler = () => new Response(JSON.stringify({ sha: "abc", content: Buffer.from("hi", "utf8").toString("base64"), encoding: "base64" }), { status: 200, headers: { "content-type": "application/json" } }));

	it("vault({action:'read'}) === VAULT_TOOLS.vault_read", async () => {
		wire();
		const viaVerb = await vault.run(vaultEnv, { action: "read", path: "Inbox/x.md" });
		wire();
		const viaTool = await VAULT_TOOLS.find((t) => t.name === "vault_read")!.run(vaultEnv, { path: "Inbox/x.md" });
		expect(viaVerb).toEqual(viaTool);
	});

	it("vault({action:'delete'}) auto-stages (the stage/commit_token kernel, not a bare confirm gate)", async () => {
		wire();
		const r = await vault.run(vaultEnv, { action: "delete", path: "Inbox/x.md" });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed).toMatchObject({ staged: true, kind: "vault_delete" });
	});
});

describe("front verbs reject an unknown per-action arg instead of degrading to match-all (#1312)", () => {
	it("mail({action:'search', q}) errors naming `query` instead of returning the unfiltered mailbox", async () => {
		const r = await mail.run(mailEnv(), { action: "search", q: "ecare" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(r.content[0].text).toContain("q");
		expect(r.content[0].text).toContain("query");
	});

	it("vault({action:'search_body', query}) errors naming `q` (vault_search_body's real key)", async () => {
		const r = await vault.run({} as RtEnv, { action: "search_body", query: "ecare" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(r.content[0].text).toContain("q");
	});

	it("files({action:'search', q}) errors naming `query` (files_search's real key)", async () => {
		const r = await files.run({} as RtEnv, { action: "search", q: "ecare" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(r.content[0].text).toContain("query");
	});
});

describe("files verb preserves the delete stage guard", () => {
	it("files({action:'delete'}) without stage/commit_token/force → stages a preview, deletes nothing", async () => {
		const r = await files.run({} as RtEnv, { action: "delete", path: "/x.txt" });
		const out = JSON.parse(r.content[0].text);
		expect(out).toMatchObject({ staged: true, kind: "dropbox_delete" });
		expect(out.commit_token).toBeTruthy();
	});
});

// ── Mail send/masked over the mocked jmap conduit ─────────────────────────────────
function kvStub() {
	const map = new Map<string, string>();
	return { get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const SESSION = {
	apiUrl: "https://api.fastmail.com/jmap/api/",
	uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
	downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
	accounts: { u1: { name: "me@fastmail.com", accountCapabilities: { "urn:ietf:params:jmap:mail": {}, "https://www.fastmail.com/dev/maskedemail": {} } } },
	primaryAccounts: { "urn:ietf:params:jmap:mail": "u1", "urn:ietf:params:jmap:submission": "u1" },
	capabilities: { "urn:ietf:params:jmap:core": { maxCallsInRequest: 50, maxObjectsInGet: 500, maxObjectsInSet: 500, maxSizeRequest: 1e7 }, "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {}, "https://www.fastmail.com/dev/maskedemail": {} },
	state: "s1",
};
const jsonRes = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
let submitted = false;
let lastMaskedSet: any = null;
function answerJmap([method, args]: any): any {
	if (method === "Mailbox/get") return [method, { list: [{ id: "mb-sent", name: "Sent", role: "sent" }, { id: "mb-drafts", name: "Drafts", role: "drafts" }] }, "x"];
	if (method === "Identity/get") return [method, { list: [{ id: "id1", name: "Me", email: "me@fastmail.com" }] }, "x"];
	if (method === "Email/set") return [method, { created: args?.create ? Object.fromEntries(Object.keys(args.create).map((k) => [k, { id: "new-1" }])) : undefined }, "x"];
	if (method === "EmailSubmission/set") {
		submitted = true;
		return [method, { created: { sub: { id: "sub-1" } } }, "x"];
	}
	if (method === "MaskedEmail/set") {
		lastMaskedSet = args;
		return [method, { created: args?.create ? { m: { id: "m2", email: "y@fastmail.com", forDomain: "new.com" } } : undefined }, "x"];
	}
	return [method, {}, "x"];
}
function installFetch() {
	submitted = false;
	lastMaskedSet = null;
	global.fetch = vi.fn(async (input: any, init?: any) => {
		const url = String(input?.url ?? input);
		if (url.includes("/jmap/session")) return jsonRes(SESSION);
		if (url.includes("/jmap/api")) {
			const body = init?.body ? JSON.parse(init.body) : {};
			return jsonRes({ methodResponses: (body.methodCalls ?? []).map((c: any) => answerJmap(c)), sessionState: "s1" });
		}
		return jsonRes({}, 404);
	}) as any;
}
const mailEnv = () => ({ FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub() }) as unknown as RtEnv;
const parse = (r: ToolResult) => JSON.parse(r.content[0].text);

describe("mail verb preserves reversibility + inject", () => {
	it("mail({action:'send'}) stages a preview by default — nothing is submitted", async () => {
		installFetch();
		const out = parse(await mail.run(mailEnv(), { action: "send", to: ["x@y.com"], subject: "Hi", text: "yo" }));
		expect(out).toMatchObject({ staged: true, kind: "mail_send" });
		expect(out.commit_token).toBeTruthy();
		expect(submitted).toBe(false);
	});

	it("mail({action:'send', force:true}) passes force through and submits", async () => {
		installFetch();
		parse(await mail.run(mailEnv(), { action: "send", to: ["x@y.com"], subject: "Hi", text: "yo", force: true }));
		expect(submitted).toBe(true);
	});

	it("mail({action:'masked_create'}) reaches mail_masked with the inner action:'create'", async () => {
		installFetch();
		parse(await mail.run(mailEnv(), { action: "masked_create", forDomain: "new.com" }));
		// The MaskedEmail/set carried a `create` (not an update/destroy) ⇒ the inner
		// action:"create" was injected AND the caller's forDomain flowed through.
		expect(lastMaskedSet?.create).toBeTruthy();
		expect(JSON.stringify(lastMaskedSet.create)).toContain("new.com");
	});
});

// ── Front-door integration: reachable on the single /mcp connector ────────────────
describe("front-door integration (/mcp)", () => {
	it("all five verbs are advertised as front verbs and registered", () => {
		const front = new Set(frontToolList(FUNCTIONS).map((t) => t.name));
		for (const v of ["vault", "mail", "files", "calendar", "contact"]) {
			expect(front.has(v), `${v} advertised`).toBe(true);
			expect(FRONT_VERBS.has(v)).toBe(true);
			expect(FUNCTIONS.some((f) => f.name === v)).toBe(true);
		}
	});

	function makeKv() {
		const store = new Map<string, string>();
		return {
			get: async (k: string) => store.get(k) ?? null,
			getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
		};
	}
	const rpcEnv = () => ({ OAUTH_KV: makeKv(), ALLOWED_GITHUB_LOGIN: "octocat", MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } }) as unknown as RtEnv;
	const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
	const call = async (params: any): Promise<JsonRpc> => {
		const res = await handleRpc(rpcEnv(), ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params });
		return extractRpcFromText(await res.text(), res.headers.get("content-type"))!;
	};

	it("tools/call name:'vault' dispatches into VAULT_TOOLS (not an unknown-tool error)", async () => {
		routes.handler = () => new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { "content-type": "application/json" } });
		const out = await call({ name: "vault", arguments: { action: "delete", path: "Inbox/x.md" } });
		expect(out.error).toBeUndefined(); // resolved to a real fn, not -32601
		expect(out.result.isError).toBeFalsy();
		const parsed = JSON.parse(out.result.content[0].text);
		expect(parsed).toMatchObject({ staged: true, kind: "vault_delete" }); // reached vault_delete's stage guard
	});

	it("tools/list advertises the namespace verbs", async () => {
		const res = await handleRpc(rpcEnv(), ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		const out = extractRpcFromText(await res.text(), res.headers.get("content-type"))!;
		const names = out.result.tools.map((t: { name: string }) => t.name);
		for (const v of ["vault", "mail", "files", "calendar", "contact"]) expect(names).toContain(v);
	});
});
