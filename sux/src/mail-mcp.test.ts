import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMailPushWebhook, handleMailRpc, MAIL_TOOLS } from "./mail-mcp";

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
	if (method === "Email/query") return [method, { ids: ["e1"], queryState: "q1", total: args?.calculateTotal ? 137 : undefined, position: args?.position ?? 0 }, "x"];
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
	if (method === "Mailbox/set") {
		const created = args?.create ? Object.fromEntries(Object.keys(args.create).map((k) => [k, { id: "mb-new", name: args.create[k]?.name, parentId: args.create[k]?.parentId ?? null }])) : undefined;
		const notCreated = undefined;
		const updateKeys = args?.update ? Object.keys(args.update) : [];
		const updated = Object.fromEntries(updateKeys.filter((k) => !k.includes("bad")).map((k) => [k, null]));
		const notUpdated = Object.fromEntries(updateKeys.filter((k) => k.includes("bad")).map((k) => [k, { type: "notFound" }]));
		const destroyIds: string[] = args?.destroy ?? [];
		const destroyed = destroyIds.filter((id: string) => !id.includes("nonempty"));
		const notDestroyed = Object.fromEntries(destroyIds.filter((id: string) => id.includes("nonempty")).map((id: string) => [id, { type: "mailboxHasEmail" }]));
		return [method, { created, notCreated, updated, notUpdated, destroyed, notDestroyed }, "x"];
	}
	if (method === "PushSubscription/set") {
		const created = args?.create ? Object.fromEntries(Object.keys(args.create).map((k) => [k, { id: "push-1", expires: null }])) : undefined;
		const updateKeys = args?.update ? Object.keys(args.update) : [];
		const updated = Object.fromEntries(updateKeys.filter((k) => !k.includes("bad")).map((k) => [k, null]));
		const notUpdated = Object.fromEntries(updateKeys.filter((k) => k.includes("bad")).map((k) => [k, { type: "invalidProperties" }]));
		const destroyed = args?.destroy ?? undefined;
		return [method, { created, updated, notUpdated, destroyed }, "x"];
	}
	if (method === "MaskedEmail/get") return [method, { list: [{ id: "m1", email: "x@fastmail.com", state: "enabled", forDomain: "shop.com" }] }, "x"];
	if (method === "MaskedEmail/set") return [method, { created: args?.create ? { m: { id: "m2", email: "y@fastmail.com", forDomain: "new.com" } } : undefined, updated: args?.update ? Object.fromEntries(Object.keys(args.update).map((k) => [k, null])) : undefined }, "x"];
	if (method === "VacationResponse/get") return [method, { list: [{ id: "singleton", isEnabled: false, subject: "Away", textBody: "OOO" }] }, "x"];
	if (method === "VacationResponse/set") return [method, { updated: args?.update ? Object.fromEntries(Object.keys(args.update).map((k) => [k, null])) : undefined }, "x"];
	if (method === "Quota/get") return [method, { list: [{ id: "q1", name: "Mail", used: 100, limit: 1000, scope: "account", resourceType: "octets" }] }, "x"];
	if (method === "ContactCard/query") return [method, { ids: ["c1"] }, "x"];
	if (method === "ContactCard/get") return [method, { list: [{ id: "c1", name: { full: "Ada Lovelace" }, emails: { e1: { address: "ada@x.com" } }, phones: {} }] }, "x"];
	if (method === "ContactCard/set") return [method, { created: args?.create ? { c: { id: "c2" } } : undefined, updated: args?.update ? Object.fromEntries(Object.keys(args.update).map((k) => [k, null])) : undefined, destroyed: args?.destroy ?? undefined }, "x"];
	return [method, {}, "x"];
}

// A token re-scoped for contacts/vacation/quota (P2) — same account, extra capabilities.
const SESSION_SCOPED = {
	...SESSION,
	accounts: { u1: { name: "me@fastmail.com", accountCapabilities: { "urn:ietf:params:jmap:mail": {}, "https://www.fastmail.com/dev/maskedemail": {}, "urn:ietf:params:jmap:contacts": {}, "urn:ietf:params:jmap:vacationresponse": {}, "urn:ietf:params:jmap:quota": {} } } },
	capabilities: { ...SESSION.capabilities, "urn:ietf:params:jmap:contacts": {}, "urn:ietf:params:jmap:vacationresponse": {}, "urn:ietf:params:jmap:quota": {} },
	primaryAccounts: { ...SESSION.primaryAccounts, "urn:ietf:params:jmap:contacts": "u1", "urn:ietf:params:jmap:vacationresponse": "u1", "urn:ietf:params:jmap:quota": "u1" },
};

function installFetch(session: any = SESSION) {
	const f = vi.fn(async (input: any, init?: any) => {
		const url = String(input?.url ?? input);
		if (url.includes("/jmap/session")) return json(session);
		if (url.includes("/jmap/upload/")) return json({ blobId: "blob-99", type: init?.headers?.["Content-Type"] ?? "application/octet-stream", size: 3 });
		if (url.includes("/jmap/download/")) return new Response(new Uint8Array([104, 105, 33]).buffer, { status: 200, headers: { "content-type": "application/octet-stream" } });
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

// CalDAV (P3) — Basic-auth app-password, separate from the JMAP token.
const calEnv = () => ({ FASTMAIL_CALDAV_USER: "me@fastmail.com", FASTMAIL_APP_PASSWORD: "app-pw", OAUTH_KV: kvStub() }) as any;
const CALS_XML = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/personal/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/tasks/</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
</d:multistatus>`;
function installCalDav() {
	const f = vi.fn(async (input: any, init?: any) => {
		const method = init?.method ?? "GET";
		if (method === "PROPFIND") return new Response(CALS_XML, { status: 207 });
		if (method === "REPORT") return new Response(`<d:multistatus xmlns:d="DAV:"></d:multistatus>`, { status: 207 });
		if (method === "PUT") return new Response("", { status: 201, headers: { etag: '"new"' } });
		if (method === "DELETE") return new Response("", { status: 204 });
		return new Response("", { status: 200 });
	});
	global.fetch = f as any;
	return f;
}

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

	it("mail_search pages with position + surfaces total, and sorts oldest-first on ascending (#257)", async () => {
		const f = installFetch();
		const out = parse(await tool("mail_search").run(env(), { query: "x", position: 50, ascending: true, limit: 10 }));
		expect(out).toMatchObject({ position: 50, ascending: true, total: 137 });
		// The Email/query call carried the position + ascending sort + calculateTotal.
		const body = JSON.parse(f.mock.calls.find((c: any) => String(c[0]).includes("/jmap/api"))![1].body);
		const q = body.methodCalls.find((c: any) => c[0] === "Email/query")[1];
		expect(q).toMatchObject({ position: 50, calculateTotal: true, sort: [{ property: "receivedAt", isAscending: true }] });
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

	it("mail_read renders an HTML-only body (fetchHTMLBodyValues on, HTML→text)", async () => {
		// An HTML-only email: no textBody parts, body lives in htmlBody. Without
		// fetchHTMLBodyValues the value never populates and the body came back empty.
		const HTML_EMAIL = { id: "e2", threadId: "t2", subject: "Newsletter", from: [{ email: "n@site.com" }], to: [{ email: "me@fastmail.com" }], receivedAt: "2026-07-10T00:00:00Z", keywords: {}, textBody: [], htmlBody: [{ partId: "h1", type: "text/html" }], bodyValues: { h1: { value: "<h1>Hi</h1><p>Read <a href=\"https://x.com\">this</a>.</p>" } } };
		let getArgs: any = null;
		global.fetch = vi.fn(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/jmap/session")) return json(SESSION);
			if (url.includes("/jmap/api")) {
				const body = init?.body ? JSON.parse(init.body) : {};
				const methodResponses = (body.methodCalls ?? []).map((c: any) => {
					if (c[0] === "Email/get") getArgs = c[1];
					return c[0] === "Email/get" ? [c[0], { list: [HTML_EMAIL] }, c[2]] : [c[0], {}, c[2]];
				});
				return json({ methodResponses, sessionState: "s1" });
			}
			return json({}, 404);
		}) as any;
		const out = parse(await tool("mail_read").run(env(), { id: "e2" }));
		expect(getArgs.fetchHTMLBodyValues).toBe(true);
		expect(out.body).toContain("# Hi");
		expect(out.body).toContain("[this](https://x.com)");
		expect(out.body).not.toContain("<p>");
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
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "Hi", text: "yo", force: true }));
		expect(out).toMatchObject({ sent: true, submissionId: "sub-1" });
		// The send batch carried allow_send (an EmailSubmission/set create).
		const sendBody = f.mock.calls.map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : {})).find((b: any) => (b.methodCalls ?? []).some((mc: any) => mc[0] === "EmailSubmission/set"));
		expect(sendBody).toBeTruthy();
	});

	it("mail_send resolves a concrete From against a *@domain wildcard identity (§1a)", async () => {
		const f = installFetch();
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "s", text: "t", from: "probe@colinxs.com", force: true }));
		expect(out).toMatchObject({ sent: true });
		const body = f.mock.calls.map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : {})).find((b: any) => (b.methodCalls ?? []).some((mc: any) => mc[0] === "EmailSubmission/set"));
		const sub = body.methodCalls.find((mc: any) => mc[0] === "EmailSubmission/set")[1].create.sub;
		expect(sub.identityId).toBe("id2"); // matched the *@colinxs.com wildcard, not a "not verified" throw
	});

	it("mail_send now STAGES BY DEFAULT (no stage/force) — returns a preview, sends nothing (smart-guard default-on)", async () => {
		const f = installFetch();
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "Hi", text: "yo" }));
		expect(out).toMatchObject({ staged: true, kind: "mail_send" });
		expect(out.commit_token).toBeTruthy();
		const submitted = f.mock.calls.some((c: any) => c[1]?.body && JSON.parse(c[1].body).methodCalls?.some((mc: any) => mc[0] === "EmailSubmission/set"));
		expect(submitted).toBe(false); // default stage performed no submission
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
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], cc: ["c@y.com"], subject: "Later", text: "yo", send_at: "2999-01-01T00:00:00Z", force: true }));
		expect(out).toMatchObject({ scheduled: true, submissionId: "sub-1", send_at: "2999-01-01T00:00:00Z" });
		const body = f.mock.calls.map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : {})).find((b: any) => (b.methodCalls ?? []).some((mc: any) => mc[0] === "EmailSubmission/set"));
		const sub = body.methodCalls.find((mc: any) => mc[0] === "EmailSubmission/set")[1].create.sub;
		expect(sub.envelope.mailFrom.parameters.HOLDFOR).toMatch(/^\d+$/); // seconds of hold
		expect(sub.envelope.rcptTo).toEqual([{ email: "x@y.com" }, { email: "c@y.com" }]); // all recipients listed
	});

	// Reply/forward threading: install a fetch whose Email/get returns a rich source
	// message and whose Email/set records the created draft, so we can assert the
	// derived headers/recipients/subject/quote.
	function installReplyFetch(src: any) {
		let createdDraft: any = null;
		const f = vi.fn(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/jmap/session")) return json(SESSION);
			if (url.includes("/jmap/api")) {
				const body = init?.body ? JSON.parse(init.body) : {};
				const methodResponses = (body.methodCalls ?? []).map((c: any) => {
					const [m, args] = c;
					if (m === "Email/get") return [m, { list: [src] }, c[2]];
					if (m === "Mailbox/get") return [m, { list: MAILBOXES }, c[2]];
					if (m === "Identity/get") return [m, { list: [{ id: "id1", name: "Me", email: "me@fastmail.com" }] }, c[2]];
					if (m === "Email/set") {
						createdDraft = args?.create?.draft ?? null;
						return [m, { created: { draft: { id: "new-1" } } }, c[2]];
					}
					if (m === "EmailSubmission/set") return [m, { created: { sub: { id: "sub-1" } } }, c[2]];
					return [m, {}, c[2]];
				});
				return json({ methodResponses, sessionState: "s1" });
			}
			return json({}, 404);
		});
		global.fetch = f as any;
		return () => createdDraft;
	}
	const SRC = { id: "e1", threadId: "t1", messageId: ["<orig@site>"], references: ["<root@site>"], subject: "Question", from: [{ email: "boss@corp.com", name: "Boss" }], to: [{ email: "me@fastmail.com" }], cc: [{ email: "team@corp.com" }], receivedAt: "2026-07-09T00:00:00Z", textBody: [{ partId: "p1", type: "text/plain" }], bodyValues: { p1: { value: "original question" } } };

	it("mail_send mode=reply threads (In-Reply-To/References), derives Re: subject + recipient, quotes", async () => {
		const draftOf = installReplyFetch(SRC);
		const out = parse(await tool("mail_send").run(env(), { mode: "reply", reply_to: "e1", text: "my answer", force: true }));
		expect(out).toMatchObject({ sent: true });
		const d = draftOf();
		expect(d.inReplyTo).toEqual(["<orig@site>"]);
		expect(d.references).toEqual(["<root@site>", "<orig@site>"]);
		expect(d.subject).toBe("Re: Question");
		expect(d.to).toEqual([{ email: "boss@corp.com" }]); // reply → the sender, not the whole list
		expect(d.cc).toBeUndefined();
		expect(d.bodyValues.b.value).toContain("my answer");
		expect(d.bodyValues.b.value).toContain("> original question");
	});

	it("mail_send mode=reply-all adds the other recipients to Cc, excluding self", async () => {
		const draftOf = installReplyFetch(SRC);
		await tool("mail_send").run(env(), { mode: "reply-all", reply_to: "e1", text: "hi all", force: true });
		const d = draftOf();
		expect(d.to).toEqual([{ email: "boss@corp.com" }]);
		expect(d.cc).toEqual([{ email: "team@corp.com" }]); // original Cc kept; me@fastmail.com (self) dropped
	});

	it("mail_send mode=forward prefixes Fwd:, needs explicit to, includes the forwarded block, no threading", async () => {
		const draftOf = installReplyFetch(SRC);
		const out = parse(await tool("mail_send").run(env(), { mode: "forward", reply_to: "e1", to: ["fwd@x.com"], text: "fyi", force: true }));
		expect(out).toMatchObject({ sent: true });
		const d = draftOf();
		expect(d.subject).toBe("Fwd: Question");
		expect(d.to).toEqual([{ email: "fwd@x.com" }]);
		expect(d.inReplyTo).toBeUndefined();
		expect(d.bodyValues.b.value).toContain("Forwarded message");
		expect(d.bodyValues.b.value).toContain("original question");
	});

	it("mail_send reply already tagged Re: doesn't double-prefix", async () => {
		const draftOf = installReplyFetch({ ...SRC, subject: "Re: Question" });
		await tool("mail_send").run(env(), { mode: "reply", reply_to: "e1", text: "ok", force: true });
		expect(draftOf().subject).toBe("Re: Question");
	});

	it("mail_send mode=reply requires reply_to", async () => {
		installReplyFetch(SRC);
		const r = await tool("mail_send").run(env(), { mode: "reply", text: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("reply_to");
	});

	it("mail_send rejects a past send_at", async () => {
		installFetch();
		const r = await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "s", text: "t", send_at: "2000-01-01T00:00:00Z" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/future/);
	});

	it("scheduled reply-all keeps the derived Cc in the FUTURERELEASE envelope (rcptTo matches the header set)", async () => {
		// Regression: the explicit rcptTo must be built from the resolved cc/bcc (which reply-all
		// augments in place), not the raw request args — else every derived Cc silently never delivers.
		let sub: any = null;
		global.fetch = vi.fn(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/jmap/session")) return json(SESSION);
			if (url.includes("/jmap/api")) {
				const body = init?.body ? JSON.parse(init.body) : {};
				const methodResponses = (body.methodCalls ?? []).map((c: any) => {
					const [m, args] = c;
					if (m === "Email/get") return [m, { list: [SRC] }, c[2]];
					if (m === "Mailbox/get") return [m, { list: MAILBOXES }, c[2]];
					if (m === "Identity/get") return [m, { list: [{ id: "id1", name: "Me", email: "me@fastmail.com" }] }, c[2]];
					if (m === "Email/set") return [m, { created: { draft: { id: "new-1" } } }, c[2]];
					if (m === "EmailSubmission/set") {
						sub = args?.create?.sub ?? null;
						return [m, { created: { sub: { id: "sub-1" } } }, c[2]];
					}
					return [m, {}, c[2]];
				});
				return json({ methodResponses, sessionState: "s1" });
			}
			return json({}, 404);
		}) as any;
		const out = parse(await tool("mail_send").run(env(), { mode: "reply-all", reply_to: "e1", text: "hi all", send_at: "2999-01-01T00:00:00Z", force: true }));
		expect(out).toMatchObject({ scheduled: true, send_at: "2999-01-01T00:00:00Z" });
		expect(sub.envelope.rcptTo).toEqual([{ email: "boss@corp.com" }, { email: "team@corp.com" }]);
	});

	it("mail_send rejects a send_at beyond submission.maxDelayedSend, naming the window (#245)", async () => {
		const s = { ...SESSION, capabilities: { ...SESSION.capabilities, "urn:ietf:params:jmap:submission": { maxDelayedSend: 7 * 86400 } } };
		installFetch(s);
		const r = await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "s", text: "t", send_at: "2999-01-01T00:00:00Z", force: true });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(r.content[0].text).toMatch(/7 days|maxDelayedSend/);
	});

	it("mail_send still schedules when maxDelayedSend is unadvertised (no clamp) (#245)", async () => {
		installFetch(); // base SESSION has no maxDelayedSend → 0 → don't clamp
		const out = parse(await tool("mail_send").run(env(), { to: ["x@y.com"], subject: "s", text: "t", send_at: "2999-01-01T00:00:00Z", force: true }));
		expect(out).toMatchObject({ scheduled: true });
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

	it("mail_move's bad_input error names the real `mailbox` param, not a guessed one (live bug report 2026-07-13)", async () => {
		const wrongParams = [{ ids: ["e1"], mailboxId: "P5-" }, { ids: ["e1"], to: "P5-" }, { ids: [] }];
		for (const args of wrongParams) {
			const r = await tool("mail_move").run(env(), args);
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/`mailbox`/);
			expect(r.content[0].text).not.toMatch(/target mailbox\.$/);
		}
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

	it("mail_mailbox creates a folder, optionally nested under a parent (resolved role/name/id)", async () => {
		installFetch();
		const created = parse(await tool("mail_mailbox").run(env(), { action: "create", name: "Follow-up" }));
		expect(created.created).toMatchObject({ id: "mb-new", name: "Follow-up", parentId: null });
		const nested = parse(await tool("mail_mailbox").run(env(), { action: "create", name: "Sub", parent: "archive" }));
		expect(nested.created).toMatchObject({ id: "mb-new", name: "Sub", parentId: "mb-arch" });
	});

	it("mail_mailbox create requires a name", async () => {
		const r = await tool("mail_mailbox").run(env(), { action: "create" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires a `name`/);
	});

	it("mail_mailbox renames a mailbox resolved by role/name/id", async () => {
		installFetch();
		const r = parse(await tool("mail_mailbox").run(env(), { action: "rename", mailbox: "archive", name: "Old Mail" }));
		expect(r).toMatchObject({ renamed: "mb-arch", name: "Old Mail" });
	});

	it("mail_mailbox rename surfaces a notUpdated failure", async () => {
		installFetch();
		const r = await tool("mail_mailbox").run(env(), { action: "rename", mailbox: "bad-id", name: "X" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/rename failed/);
	});

	it("mail_mailbox delete stages a preview by default, applies on force:true", async () => {
		installFetch();
		const staged = parse(await tool("mail_mailbox").run(env(), { action: "delete", mailbox: "archive" }));
		expect(staged).toMatchObject({ staged: true, kind: "mail_mailbox_delete" });
		const applied = parse(await tool("mail_mailbox").run(env(), { action: "delete", mailbox: "archive", force: true }));
		expect(applied).toMatchObject({ deleted: "mb-arch" });
	});

	it("mail_mailbox delete surfaces a non-empty-folder rejection", async () => {
		installFetch();
		const r = await tool("mail_mailbox").run(env(), { action: "delete", mailbox: "mb-nonempty", force: true });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/move its mail out first with mail_move/);
	});

	it("mail_push status reports no subscription until one exists", async () => {
		expect(parse(await tool("mail_push").run(env(), { action: "status" }))).toEqual({ subscribed: false });
	});

	it("mail_push subscribe creates a PushSubscription and is idempotent on re-call", async () => {
		installFetch();
		const e = env();
		const first = parse(await tool("mail_push").run(e, { action: "subscribe" }));
		expect(first).toMatchObject({ subscribed: true, id: "push-1", verified: false });
		const status = parse(await tool("mail_push").run(e, { action: "status" }));
		expect(status).toMatchObject({ subscribed: true, id: "push-1", verified: false });
		const second = parse(await tool("mail_push").run(e, { action: "subscribe" }));
		expect(second).toMatchObject({ already: true, id: "push-1", verified: false });
	});

	it("mail_push unsubscribe destroys the subscription and clears state", async () => {
		installFetch();
		const e = env();
		await tool("mail_push").run(e, { action: "subscribe" });
		const out = parse(await tool("mail_push").run(e, { action: "unsubscribe" }));
		expect(out).toMatchObject({ unsubscribed: true, destroyed: true });
		expect(parse(await tool("mail_push").run(e, { action: "status" }))).toEqual({ subscribed: false });
	});

	it("mail_push unsubscribe with nothing subscribed is a clean no-op", async () => {
		const out = parse(await tool("mail_push").run(env(), { action: "unsubscribe" }));
		expect(out).toMatchObject({ unsubscribed: true });
	});

	it("handleMailPushWebhook: wrong/unknown token doesn't match (index.ts 404s on false)", async () => {
		installFetch();
		const e = env();
		await tool("mail_push").run(e, { action: "subscribe" });
		const trigger = vi.fn();
		const matched = await handleMailPushWebhook(e, "wrong-token", "{}", trigger);
		expect(matched).toBe(false);
		expect(trigger).not.toHaveBeenCalled();
	});

	it("handleMailPushWebhook: verification push confirms the subscription without triggering triage", async () => {
		installFetch();
		const e = env();
		await tool("mail_push").run(e, { action: "subscribe" });
		const subState = JSON.parse(e.OAUTH_KV.map.get("sux:mailpush:sub"));
		const trigger = vi.fn();
		const matched = await handleMailPushWebhook(e, subState.token, JSON.stringify({ "@type": "PushVerification", pushSubscriptionId: "push-1", verificationCode: "abc123" }), trigger);
		expect(matched).toBe(true);
		expect(trigger).not.toHaveBeenCalled();
		const status = parse(await tool("mail_push").run(e, { action: "status" }));
		expect(status).toMatchObject({ verified: true });
	});

	it("handleMailPushWebhook: a StateChange push triggers triage only once verified", async () => {
		installFetch();
		const e = env();
		await tool("mail_push").run(e, { action: "subscribe" });
		const subState = JSON.parse(e.OAUTH_KV.map.get("sux:mailpush:sub"));
		const trigger = vi.fn();

		// Before verification: a StateChange push matches (200s) but does NOT trigger.
		const early = await handleMailPushWebhook(e, subState.token, JSON.stringify({ "@type": "StateChange", changed: {} }), trigger);
		expect(early).toBe(true);
		expect(trigger).not.toHaveBeenCalled();

		// Verify, then a StateChange push DOES trigger.
		await handleMailPushWebhook(e, subState.token, JSON.stringify({ "@type": "PushVerification", pushSubscriptionId: "push-1", verificationCode: "abc123" }), trigger);
		const after = await handleMailPushWebhook(e, subState.token, JSON.stringify({ "@type": "StateChange", changed: {} }), trigger);
		expect(after).toBe(true);
		expect(trigger).toHaveBeenCalledTimes(1);
	});

	it("handleMailPushWebhook: a malformed body still acks (matches) but never throws or triggers", async () => {
		installFetch();
		const e = env();
		await tool("mail_push").run(e, { action: "subscribe" });
		const subState = JSON.parse(e.OAUTH_KV.map.get("sux:mailpush:sub"));
		const trigger = vi.fn();
		const matched = await handleMailPushWebhook(e, subState.token, "not json{{{", trigger);
		expect(matched).toBe(true);
		expect(trigger).not.toHaveBeenCalled();
	});

	it("mail_upload streams bytes to a reusable blobId (§1e)", async () => {
		installFetch();
		const up = parse(await tool("mail_upload").run(env(), { data: btoa("abc"), type: "text/plain", name: "n.txt" }));
		expect(up).toMatchObject({ blobId: "blob-99", type: "text/plain", size: 3, name: "n.txt" });
	});

	it("mail_attachments exports blobs to R2 (dest:store) and is idempotent per blobId (#265)", async () => {
		installFetch();
		const r2 = { put: vi.fn(async () => {}) };
		const e = { FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub(), R2: r2 } as any;
		const items = [{ blobId: "B1", messageId: "e1", type: "text/plain", name: "a.txt" }, { blobId: "B2" }];
		const out = parse(await tool("mail_attachments").run(e, { items, dest: "store" }));
		expect(out).toMatchObject({ dest: "store", count: 2 });
		expect(out.exported[0]).toMatchObject({ blobId: "B1", messageId: "e1", dest: "store", size: 3 });
		expect(out.exported[0].ref).toMatch(/\/s\//);
		expect(r2.put).toHaveBeenCalledTimes(2);
		// Re-run over the same ledger (shared KV) → both blobs are skipped, no new R2 writes.
		const again = parse(await tool("mail_attachments").run(e, { items, dest: "store" }));
		expect(again.exported.every((x: any) => String(x.skipped).includes("already exported"))).toBe(true);
		expect(r2.put).toHaveBeenCalledTimes(2);
	});

	it("mail_attachments dest:dropbox is not_configured without a Dropbox credential (#265)", async () => {
		installFetch();
		const r = await tool("mail_attachments").run(env(), { items: [{ blobId: "B1" }], dest: "dropbox" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
	});

	it("mail_send attachments: stage previews names WITHOUT uploading; commit builds multipart/mixed (§1e)", async () => {
		const e = env();
		const f = installFetch();
		const att = [{ data: btoa("abc"), type: "text/plain", name: "hi.txt" }];
		lastEmailSet = null;
		const st = parse(await tool("mail_send").run(e, { to: ["x@y.com"], subject: "s", text: "b", attachments: att, stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "mail_send" });
		expect(st.preview.attachments[0]).toMatchObject({ name: "hi.txt", source: "data" });
		expect(lastEmailSet).toBeNull(); // stage sent nothing
		expect(f.mock.calls.some((c: any) => String(c[0]?.url ?? c[0]).includes("/jmap/upload/"))).toBe(false); // and uploaded nothing
		const done = parse(await tool("mail_send").run(e, { to: ["x@y.com"], subject: "s", text: "b", attachments: att, commit_token: st.commit_token }));
		expect(done).toMatchObject({ sent: true, attachments: 1 });
		const bs = lastEmailSet.create.draft.bodyStructure;
		expect(bs.type).toBe("multipart/mixed");
		expect(bs.subParts[1]).toMatchObject({ blobId: "blob-99", disposition: "attachment", name: "hi.txt" }); // uploaded blob referenced
	});

	it("P2 verbs are gated not_configured when the token lacks the scope (§2)", async () => {
		installFetch(); // default token grants no contacts/vacation/quota
		for (const [name, args] of [["mail_vacation", {}], ["mail_quota", {}], ["contact_search", { text: "x" }]] as const) {
			const r = await tool(name).run(env(), args);
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/capability|re-mint|scope/i); // clear, flip-on-ready message
		}
	});

	it("mail_vacation get/set + mail_quota on a re-scoped token (§2)", async () => {
		const e = env();
		installFetch(SESSION_SCOPED);
		expect(parse(await tool("mail_vacation").run(e, { action: "get" })).vacation).toMatchObject({ id: "singleton", subject: "Away" });
		expect(parse(await tool("mail_quota").run(e, {})).quotas[0]).toMatchObject({ id: "q1", used: 100, limit: 1000 });
		const st = parse(await tool("mail_vacation").run(e, { action: "set", enabled: true, subject: "OOO", text: "back Monday", stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "mail_vacation" });
		const done = parse(await tool("mail_vacation").run(e, { action: "set", enabled: true, subject: "OOO", text: "back Monday", commit_token: st.commit_token }));
		expect(done).toMatchObject({ updated: true });
	});

	it("contact_search/create/delete on a re-scoped token (§2)", async () => {
		const e = env();
		installFetch(SESSION_SCOPED);
		expect(parse(await tool("contact_search").run(e, { text: "ada" })).contacts[0]).toMatchObject({ id: "c1", name: "Ada Lovelace", emails: ["ada@x.com"] });
		// `query` is the documented param name (contact.ts's dispatcher description,
		// every real caller) — the schema only ever defined `text`, so `query` was
		// silently dropped and the search returned everything unfiltered. Regression
		// guard: `query` must filter identically to `text`.
		expect(parse(await tool("contact_search").run(e, { query: "ada" })).contacts[0]).toMatchObject({ id: "c1", name: "Ada Lovelace", emails: ["ada@x.com"] });
		const st = parse(await tool("contact_create").run(e, { firstName: "Grace", emails: ["grace@x.com"], stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "contact_create" });
		expect(parse(await tool("contact_create").run(e, { firstName: "Grace", emails: ["grace@x.com"], commit_token: st.commit_token })).created).toMatchObject({ id: "c2" });
		// `name` is the documented param (contact.ts's dispatcher: contact({action:'create',
		// name, emails})) — the schema only ever had firstName/lastName, so `name` was
		// silently dropped and created a nameless contact. Regression guard: `name` splits
		// into given/surname the same way firstName/lastName would.
		const stName = parse(await tool("contact_create").run(e, { name: "Ada Lovelace", emails: ["ada2@x.com"], stage: true }));
		expect(stName.preview).toMatchObject({ name: { full: "Ada Lovelace" } });
		expect(parse(await tool("contact_delete").run(e, { id: "c1", stage: true }))).toMatchObject({ staged: true, kind: "contact_delete" });
	});

	it("cal_/task_ verbs gate on CalDAV credentials (§3)", async () => {
		installFetch();
		for (const name of ["cal_list", "cal_events", "task_list", "caldav"] as const) {
			const r = await tool(name).run(env(), { method: "PROPFIND", path: "/x" });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/CalDAV|APP_PASSWORD/i); // flip-on-ready message
		}
	});

	it("cal_list parses calendars; cal_create stages then PUTs an event (§3)", async () => {
		const e = calEnv();
		installCalDav();
		const list = parse(await tool("cal_list").run(e, {}));
		expect(list.calendars.find((c: any) => c.name === "Personal")).toMatchObject({ isTasks: false });
		expect(list.calendars.find((c: any) => c.name === "Tasks")).toMatchObject({ isTasks: true });
		const st = parse(await tool("cal_create").run(e, { summary: "Standup", start: "2026-07-11T09:00:00Z", stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "cal_create" }); // previews, no PUT
		const done = parse(await tool("cal_create").run(e, { summary: "Standup", start: "2026-07-11T09:00:00Z", commit_token: st.commit_token }));
		expect(done).toMatchObject({ created: true, etag: '"new"' });
		// `title` was the doc'd param (calendar.ts's dispatcher example) before this
		// schema ever had `summary` — regression guard for the alias.
		const stTitle = parse(await tool("cal_create").run(e, { title: "Retro", start: "2026-07-12T09:00:00Z", stage: true }));
		expect(stTitle).toMatchObject({ staged: true, kind: "cal_create" });
	});

	it("cal_events bounds the REPORT with a default time-range window (§2)", async () => {
		const e = calEnv();
		let reportBody = "";
		global.fetch = vi.fn(async (_input: any, init: any) => {
			const method = init?.method ?? "GET";
			if (method === "PROPFIND") return new Response(CALS_XML, { status: 207 });
			if (method === "REPORT") {
				reportBody = String(init?.body ?? "");
				return new Response(`<d:multistatus xmlns:d="DAV:"></d:multistatus>`, { status: 207 });
			}
			return new Response("", { status: 200 });
		}) as any;
		await tool("cal_events").run(e, {});
		expect(reportBody).toMatch(/<c:time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
	});

	it("cal_events accepts `from`/`to`, the doc'd param name (regression: silently ignored before)", async () => {
		const e = calEnv();
		let reportBody = "";
		global.fetch = vi.fn(async (_input: any, init: any) => {
			const method = init?.method ?? "GET";
			if (method === "PROPFIND") return new Response(CALS_XML, { status: 207 });
			if (method === "REPORT") {
				reportBody = String(init?.body ?? "");
				return new Response(`<d:multistatus xmlns:d="DAV:"></d:multistatus>`, { status: 207 });
			}
			return new Response("", { status: 200 });
		}) as any;
		await tool("cal_events").run(e, { from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z" });
		expect(reportBody).toContain("20260801T000000Z");
		expect(reportBody).toContain("20260802T000000Z");
	});

	// A stored VEVENT with a TZID + an alarm, so cal_update's GET→rewrite→PUT can be asserted to
	// preserve the zone/alarm while changing only the requested property.
	const STORED_EVENT = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:evt-keep", "DTSTART;TZID=America/New_York:20260711T090000", "SUMMARY:Old", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
	const STORED_TASK = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:task-keep", "SUMMARY:Do it", "STATUS:NEEDS-ACTION", "END:VTODO", "END:VCALENDAR"].join("\r\n");
	function installCalPatch(stored: string) {
		let putBody = "";
		const f = vi.fn(async (_input: any, init: any) => {
			const method = init?.method ?? "GET";
			if (method === "GET") return new Response(stored, { status: 200, headers: { etag: '"cur"' } });
			if (method === "PUT") {
				putBody = String(init?.body ?? "");
				return new Response("", { status: 200, headers: { etag: '"next"' } });
			}
			return new Response("", { status: 200 });
		});
		global.fetch = f as any;
		return { f, put: () => putBody };
	}

	it("cal_update rewrites one field in place, preserving UID/TZID/alarm, guarded by If-Match (§3)", async () => {
		const e = calEnv();
		const { f, put } = installCalPatch(STORED_EVENT);
		const st = parse(await tool("cal_update").run(e, { href: "/dav/cal/evt-keep.ics", summary: "New Title", stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "cal_update" });
		expect(f.mock.calls.some((c: any) => (c[1]?.method ?? "GET") === "PUT")).toBe(false); // stage did not write
		const done = parse(await tool("cal_update").run(e, { href: "/dav/cal/evt-keep.ics", summary: "New Title", commit_token: st.commit_token }));
		expect(done).toMatchObject({ updated: true, etag: '"next"' });
		const body = put();
		expect(body).toContain("SUMMARY:New Title");
		expect(body).toContain("UID:evt-keep");
		expect(body).toContain("DTSTART;TZID=America/New_York:20260711T090000"); // zone preserved
		expect(body).toContain("BEGIN:VALARM"); // alarm preserved
		const putCall = f.mock.calls.find((c: any) => c[1]?.method === "PUT");
		expect(putCall![1].headers["If-Match"]).toBe('"cur"'); // concurrency guard from the GET etag
	});

	it("cal_update rewriting `start` on a TZID event re-anchors the zone instead of collapsing to UTC (§3)", async () => {
		const e = calEnv();
		const { put } = installCalPatch(STORED_EVENT);
		// Original DTSTART is 09:00 America/New_York; move it an hour later (10:00 NY = 14:00Z).
		const st = parse(await tool("cal_update").run(e, { href: "/dav/cal/evt-keep.ics", start: "2026-07-11T14:00:00Z", stage: true }));
		const done = parse(await tool("cal_update").run(e, { href: "/dav/cal/evt-keep.ics", start: "2026-07-11T14:00:00Z", commit_token: st.commit_token }));
		expect(done).toMatchObject({ updated: true });
		const body = put();
		expect(body).toContain("DTSTART;TZID=America/New_York:20260711T100000"); // zone preserved, NOT a bare UTC Z stamp
		expect(body).not.toMatch(/DTSTART:\d{8}T\d{6}Z/); // never silently collapsed to Z
		expect(body).toContain("BEGIN:VALARM"); // untouched sibling data still intact
	});

	it("task_complete sets STATUS:COMPLETED + COMPLETED stamp + PERCENT-COMPLETE (§3)", async () => {
		const e = calEnv();
		const { put } = installCalPatch(STORED_TASK);
		const st = parse(await tool("task_complete").run(e, { href: "/dav/cal/task-keep.ics", stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "task_complete" });
		parse(await tool("task_complete").run(e, { href: "/dav/cal/task-keep.ics", commit_token: st.commit_token }));
		const body = put();
		expect(body).toContain("STATUS:COMPLETED");
		expect(body).toMatch(/COMPLETED:\d{8}T\d{6}Z/);
		expect(body).toContain("PERCENT-COMPLETE:100");
		expect(body).toContain("UID:task-keep"); // task identity preserved
	});

	it("task_update changes the due date, keeping the rest of the task (§3)", async () => {
		const e = calEnv();
		const { put } = installCalPatch(STORED_TASK);
		const st = parse(await tool("task_update").run(e, { href: "/dav/cal/task-keep.ics", due: "2026-08-01", stage: true }));
		parse(await tool("task_update").run(e, { href: "/dav/cal/task-keep.ics", due: "2026-08-01", commit_token: st.commit_token }));
		const body = put();
		expect(body).toContain("DUE;VALUE=DATE:20260801");
		expect(body).toContain("SUMMARY:Do it");
	});

	it("calPatch verbs surface typed error codes: not_configured, bad_input, not_found (§5)", async () => {
		// not_configured: no CalDAV creds.
		const g = await tool("cal_update").run(env(), { href: "/x", summary: "y" });
		expect(g.isError).toBe(true);
		expect((g as any).errorCode).toBe("not_configured");
		// bad_input: nothing to change.
		installCalPatch(STORED_EVENT);
		const b = await tool("cal_update").run(calEnv(), { href: "/x" });
		expect((b as any).errorCode).toBe("bad_input");
		// not_found: the object 404s on GET at commit.
		global.fetch = vi.fn(async (_i: any, init: any) => new Response("", { status: (init?.method ?? "GET") === "GET" ? 404 : 200 })) as any;
		const nf = await tool("cal_update").run(calEnv(), { href: "/gone", summary: "z" });
		expect((nf as any).errorCode).toBe("not_found");
	});

	it("routes gate/missing-id/missing-required errors through typed failWith codes (§5)", async () => {
		installFetch();
		expect((await tool("mail_read").run(env(), {}) as any).errorCode).toBe("bad_input"); // missing required id
		expect((await tool("cal_list").run(env(), {}) as any).errorCode).toBe("not_configured"); // no CalDAV creds
		// The default mock's Email/get returns EMAIL for any id, so force an empty list to hit not_found.
		global.fetch = vi.fn(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/jmap/session")) return json(SESSION);
			if (url.includes("/jmap/api")) return json({ methodResponses: (JSON.parse(init.body).methodCalls ?? []).map((c: any) => [c[0], c[0] === "Email/get" ? { list: [] } : {}, c[2]]), sessionState: "s1" });
			return json({}, 404);
		}) as any;
		expect((await tool("mail_read").run(env(), { id: "missing" }) as any).errorCode).toBe("not_found");
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
