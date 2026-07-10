import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMailRpc, MAIL_TOOLS } from "./mail-mcp";

// Reuse the jmap.test mocking approach: a Map-backed KV + a URL-routed fetch that
// answers Session discovery and the JMAP api endpoint. The mail_* tools compile to
// the raw jmap conduit, so mocking fetch exercises the whole stack end-to-end.
function kvStub() {
	const map = new Map<string, string>();
	return {
		map,
		get: vi.fn(async (k: string) => map.get(k) ?? null),
		put: vi.fn(async (k: string, v: string) => void map.set(k, v)),
		delete: vi.fn(async (k: string) => void map.delete(k)),
	};
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const SESSION = {
	apiUrl: "https://api.fastmail.com/jmap/api/",
	uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
	downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
	accounts: { u1: { name: "me@fastmail.com", accountCapabilities: { "urn:ietf:params:jmap:mail": {}, "https://www.fastmail.com/dev/maskedemail": {} } } },
	primaryAccounts: { "urn:ietf:params:jmap:mail": "u1", "urn:ietf:params:jmap:submission": "u1" },
	capabilities: { "urn:ietf:params:jmap:core": { maxCallsInRequest: 50, maxObjectsInGet: 500, maxObjectsInSet: 500, maxSizeRequest: 1e7 }, "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {}, "https://www.fastmail.com/dev/maskedemail": {} },
	state: "s1",
};

const MAILBOXES = [
	{ id: "mb-inbox", name: "Inbox", role: "inbox", unreadEmails: 3, totalEmails: 100 },
	{ id: "mb-drafts", name: "Drafts", role: "drafts", unreadEmails: 0, totalEmails: 1 },
	{ id: "mb-sent", name: "Sent", role: "sent", unreadEmails: 0, totalEmails: 50 },
	{ id: "mb-arch", name: "Archive", role: "archive", unreadEmails: 0, totalEmails: 500 },
];
const EMAIL = { id: "e1", threadId: "t1", subject: "Hello", from: [{ email: "a@b.com", name: "A" }], to: [{ email: "me@fastmail.com" }], receivedAt: "2026-07-09T00:00:00Z", preview: "hi there", keywords: { $seen: true, $flagged: true }, mailboxIds: { "mb-inbox": true }, textBody: [{ partId: "p1", type: "text/plain" }], bodyValues: { p1: { value: "Full body text." } } };

/** Answer one JMAP method call with canned data. */
let lastEmailSet: any = null;
function answer([method, args]: any): any {
	if (method === "Mailbox/get") return [method, { list: MAILBOXES }, "x"];
	if (method === "Identity/get") return [method, { list: [{ id: "id1", name: "Me", email: "me@fastmail.com" }, { id: "id2", name: "Domain", email: "*@colinxs.com" }] }, "x"];
	if (method === "Email/query") return [method, { ids: ["e1"], queryState: "q1" }, "x"];
	if (method === "Email/get") return [method, { list: [EMAIL] }, "x"];
	if (method === "Thread/get") return [method, { list: [{ id: "t1", emailIds: ["e1"] }] }, "x"];
	if (method === "Email/set") {
		lastEmailSet = args;
		// An id containing "bad" simulates a server-rejected patch (notUpdated); everything else updates.
		const keys = args?.update ? Object.keys(args.update) : [];
		const updated = Object.fromEntries(keys.filter((k) => !k.includes("bad")).map((k) => [k, null]));
		const notUpdated = Object.fromEntries(keys.filter((k) => k.includes("bad")).map((k) => [k, { type: "invalidProperties" }]));
		return [method, { created: args?.create ? Object.fromEntries(Object.keys(args.create).map((k) => [k, { id: "new-1" }])) : undefined, updated, notUpdated }, "x"];
	}
	if (method === "EmailSubmission/set")
		return [method, { created: args?.create ? { sub: { id: "sub-1" } } : undefined, updated: args?.update ? Object.fromEntries(Object.keys(args.update).map((k) => [k, null])) : undefined }, "x"];
	if (method === "EmailSubmission/query") return [method, { ids: ["sub-1"] }, "x"];
	if (method === "EmailSubmission/get") return [method, { list: [{ id: "sub-1", emailId: "e1", sendAt: "2026-07-11T09:00:00Z", undoStatus: "pending" }] }, "x"];
	if (method === "MaskedEmail/get") return [method, { list: [{ id: "m1", email: "x@fastmail.com", state: "enabled", forDomain: "shop.com" }] }, "x"];
	if (method === "MaskedEmail/set") return [method, { created: args?.create ? { m: { id: "m2", email: "y@fastmail.com", forDomain: "new.com" } } : undefined, updated: args?.update ? Object.fromEntries(Object.keys(args.update).map((k) => [k, null])) : undefined }, "x"];
	return [method, {}, "x"];
}

function installFetch() {
	const f = vi.fn(async (input: any, init?: any) => {
		const url = String(input?.url ?? input);
		if (url.includes("/jmap/session")) return json(SESSION);
		if (url.includes("/jmap/api")) {
			const body = init?.body ? JSON.parse(init.body) : {};
			const methodResponses = (body.methodCalls ?? []).map((c: any) => {
				const [m, a, id] = answer(c);
				return [m, a, c[2] ?? id];
			});
			return json({ methodResponses, sessionState: "s1" });
		}
		return json({}, 404);
	});
	global.fetch = f as any;
	return f;
}

const env = () => ({ FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub() }) as any;
const tool = (name: string) => MAIL_TOOLS.find((t) => t.name === name)!;
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => vi.restoreAllMocks());

describe("mail_* ergonomic tools", () => {
	it("mail_mailboxes shapes the folder list with counts", async () => {
		installFetch();
		const out = parse(await tool("mail_mailboxes").run(env(), {}));
		expect(out.count).toBe(4);
		expect(out.mailboxes.find((m: any) => m.role === "inbox")).toMatchObject({ id: "mb-inbox", unread: 3 });
	});

	it("mail_search returns references (no body) via query→get", async () => {
		installFetch();
		const out = parse(await tool("mail_search").run(env(), { query: "hello", unread: true, limit: 10 }));
		expect(out.count).toBe(1);
		expect(out.emails[0]).toMatchObject({ id: "e1", subject: "Hello", from: "a@b.com" });
		expect(out.emails[0].body).toBeUndefined(); // handle discipline: no body in search
	});

	it("mail_read returns the plain-text body", async () => {
		installFetch();
		const out = parse(await tool("mail_read").run(env(), { id: "e1" }));
		expect(out.body).toBe("Full body text.");
		expect(out.subject).toBe("Hello");
	});

	it("mail_read/search return the typed shape — isRead/isFlagged/isDraft + resolved folder labels (§1c)", async () => {
		installFetch();
		const out = parse(await tool("mail_read").run(env(), { id: "e1" }));
		expect(out).toMatchObject({ isRead: true, isFlagged: true, isDraft: false, labels: ["Inbox"] }); // mailboxIds resolved to the folder name
		const s = parse(await tool("mail_search").run(env(), { text: "hi" }));
		expect(s.emails[0]).toMatchObject({ isRead: true, isFlagged: true, labels: ["Inbox"] });
	});

	it("mail_thread lists the conversation messages", async () => {
		installFetch();
		const out = parse(await tool("mail_thread").run(env(), { threadId: "t1" }));
		expect(out.threadId).toBe("t1");
		expect(out.messages).toHaveLength(1);
	});

	it("mail_draft creates a draft and returns the id", async () => {
		installFetch();
		const out = parse(await tool("mail_draft").run(env(), { to: ["x@y.com"], subject: "Hi", text: "yo" }));
		expect(out).toMatchObject({ drafted: true, id: "new-1" });
	});

	it("mail_send composes + submits with the identity/mailbox resolved", async () => {
		const f = installFetch();
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "Hi", text: "yo" }));
		expect(out).toMatchObject({ sent: true, submissionId: "sub-1" });
		// The send batch carried allow_send (an EmailSubmission/set create).
		const sendBody = f.mock.calls.map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : {})).find((b: any) => (b.methodCalls ?? []).some((mc: any) => mc[0] === "EmailSubmission/set"));
		expect(sendBody).toBeTruthy();
	});

	it("mail_send resolves a concrete From against a *@domain wildcard identity (§1a)", async () => {
		const f = installFetch();
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "s", text: "t", from: "probe@colinxs.com" }));
		expect(out).toMatchObject({ sent: true });
		const body = f.mock.calls.map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : {})).find((b: any) => (b.methodCalls ?? []).some((mc: any) => mc[0] === "EmailSubmission/set"));
		const sub = body.methodCalls.find((mc: any) => mc[0] === "EmailSubmission/set")[1].create.sub;
		expect(sub.identityId).toBe("id2"); // matched the *@colinxs.com wildcard, not a "not verified" throw
	});

	it("mail_send stage:true previews with a commit_token and sends NOTHING; commit sends", async () => {
		const e = env(); // shared KV so the token survives to the commit call
		const f = installFetch();
		const st = parse(await tool("mail_send").run(e, { to: ["x@y.com"], subject: "s", text: "t", stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "mail_send" });
		expect(st.commit_token).toBeTruthy();
		const submittedInStage = f.mock.calls.some((c: any) => c[1]?.body && JSON.parse(c[1].body).methodCalls?.some((mc: any) => mc[0] === "EmailSubmission/set"));
		expect(submittedInStage).toBe(false); // stage performed no submission
		const done = parse(await tool("mail_send").run(e, { to: ["x@y.com"], subject: "s", text: "t", commit_token: st.commit_token }));
		expect(done).toMatchObject({ sent: true });
	});

	it("mail_send with send_at SCHEDULES via FUTURERELEASE (HOLDFOR envelope + explicit rcptTo)", async () => {
		const f = installFetch();
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], cc: ["c@y.com"], subject: "Later", text: "yo", send_at: "2999-01-01T00:00:00Z" }));
		expect(out).toMatchObject({ scheduled: true, submissionId: "sub-1", send_at: "2999-01-01T00:00:00Z" });
		const body = f.mock.calls.map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : {})).find((b: any) => (b.methodCalls ?? []).some((mc: any) => mc[0] === "EmailSubmission/set"));
		const sub = body.methodCalls.find((mc: any) => mc[0] === "EmailSubmission/set")[1].create.sub;
		expect(sub.envelope.mailFrom.parameters.HOLDFOR).toMatch(/^\d+$/); // seconds of hold
		expect(sub.envelope.rcptTo).toEqual([{ email: "x@y.com" }, { email: "c@y.com" }]); // all recipients listed
	});

	it("mail_send rejects a past send_at", async () => {
		installFetch();
		const r = await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "s", text: "t", send_at: "2000-01-01T00:00:00Z" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/future/);
	});

	it("mail_schedule schedules via FUTURERELEASE (sendAt → send_at)", async () => {
		installFetch();
		const out = parse(await tool("mail_schedule").run(env(), { to: ["x@y.com"], subject: "s", text: "t", sendAt: "2999-01-01T00:00:00Z" }));
		expect(out).toMatchObject({ scheduled: true, send_at: "2999-01-01T00:00:00Z" });
	});

	it("mail_scheduled lists pending sends; mail_unschedule cancels one (idempotent)", async () => {
		installFetch();
		const list = parse(await tool("mail_scheduled").run(env(), {}));
		expect(list.count).toBe(1);
		expect(list.scheduled[0]).toMatchObject({ id: "sub-1", emailId: "e1", sendAt: "2026-07-11T09:00:00Z" });
		const cancel = parse(await tool("mail_unschedule").run(env(), { id: "sub-1" }));
		expect(cancel).toMatchObject({ unscheduled: "sub-1" });
	});

	it("mail_archive moves messages out of the inbox", async () => {
		installFetch();
		const out = parse(await tool("mail_archive").run(env(), { ids: ["e1"] }));
		expect(out).toMatchObject({ moved: 1, to: "archive" });
	});

	it("mail_move REPLACES the mailbox set (a real move, not an additive copy-into)", async () => {
		installFetch();
		lastEmailSet = null;
		await tool("mail_move").run(env(), { ids: ["e1"], mailbox: "archive" });
		// The whole mailboxIds property is set to exactly the target — NOT a `mailboxIds/<id>:true` add
		// (which would leave the message in its origin mailbox, e.g. move-to-trash staying in the Inbox).
		expect(lastEmailSet.update.e1).toEqual({ mailboxIds: { "mb-arch": true } });
		expect(Object.keys(lastEmailSet.update.e1)).not.toContain("mailboxIds/mb-arch");
	});

	it("mail_move surfaces a rejected patch instead of a silent moved:0", async () => {
		installFetch();
		const r = await tool("mail_move").run(env(), { ids: ["bad-1"], mailbox: "archive" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/move to 'archive' failed/);
	});

	it("mail_masked lists and creates masked addresses", async () => {
		installFetch();
		const list = parse(await tool("mail_masked").run(env(), { action: "list" }));
		expect(list.masked[0]).toMatchObject({ id: "m1", state: "enabled" });
		const created = parse(await tool("mail_masked").run(env(), { action: "create", forDomain: "new.com" }));
		expect(created.created).toMatchObject({ id: "m2", forDomain: "new.com" });
	});

	it("mail_masked disable/enable transition state; delete stages first (§1d)", async () => {
		installFetch();
		expect(parse(await tool("mail_masked").run(env(), { action: "disable", id: "m1" }))).toMatchObject({ id: "m1", state: "disabled" });
		expect(parse(await tool("mail_masked").run(env(), { action: "enable", id: "m1" }))).toMatchObject({ id: "m1", state: "enabled" });
		const st = parse(await tool("mail_masked").run(env(), { action: "delete", id: "m1", stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "mail_masked_delete" }); // soft-delete previews, no write
	});

	it("exposes the raw jmap escape hatch", () => {
		expect(tool("jmap")).toBeTruthy();
	});
});

describe("handleMailRpc protocol shell", () => {
	const call = (rpc: any) => handleMailRpc(env(), {} as any, rpc, 0);

	it("initialize announces the mail server", async () => {
		const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize" });
		const body = await sseJson(r);
		expect(body.result.serverInfo.name).toBe("mail");
	});

	it("tools/list returns the mail tool set including jmap", async () => {
		const r = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		const body = await sseJson(r);
		const names = body.result.tools.map((t: any) => t.name);
		expect(names).toContain("mail_search");
		expect(names).toContain("jmap");
	});

	it("tools/call rejects an unknown tool", async () => {
		const r = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
		const body = await sseJson(r);
		expect(body.error.code).toBe(-32601);
	});

	it("tools/call runs a tool", async () => {
		installFetch();
		const r = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mail_mailboxes", arguments: {} } });
		const body = await sseJson(r);
		expect(body.result.content[0].text).toContain("mailboxes");
	});
});

/** Parse the SSE-framed JSON-RPC body a handler returns. */
async function sseJson(resp: Response): Promise<any> {
	const t = await resp.text();
	const line = t.split("\n").find((l) => l.startsWith("data:")) ?? t;
	return JSON.parse(line.replace(/^data:\s*/, ""));
}
