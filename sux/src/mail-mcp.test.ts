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
		const out = parse(await tool("mail_send").run(env(), { mode: "reply", reply_to: "e1", text: "my answer" }));
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
		await tool("mail_send").run(env(), { mode: "reply-all", reply_to: "e1", text: "hi all" });
		const d = draftOf();
		expect(d.to).toEqual([{ email: "boss@corp.com" }]);
		expect(d.cc).toEqual([{ email: "team@corp.com" }]); // original Cc kept; me@fastmail.com (self) dropped
	});

	it("mail_send mode=forward prefixes Fwd:, needs explicit to, includes the forwarded block, no threading", async () => {
		const draftOf = installReplyFetch(SRC);
		const out = parse(await tool("mail_send").run(env(), { mode: "forward", reply_to: "e1", to: ["fwd@x.com"], text: "fyi" }));
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
		await tool("mail_send").run(env(), { mode: "reply", reply_to: "e1", text: "ok" });
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

	it("mail_upload streams bytes to a reusable blobId (§1e)", async () => {
		installFetch();
		const up = parse(await tool("mail_upload").run(env(), { data: btoa("abc"), type: "text/plain", name: "n.txt" }));
		expect(up).toMatchObject({ blobId: "blob-99", type: "text/plain", size: 3, name: "n.txt" });
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
		const st = parse(await tool("contact_create").run(e, { firstName: "Grace", emails: ["grace@x.com"], stage: true }));
		expect(st).toMatchObject({ staged: true, kind: "contact_create" });
		expect(parse(await tool("contact_create").run(e, { firstName: "Grace", emails: ["grace@x.com"], commit_token: st.commit_token })).created).toMatchObject({ id: "c2" });
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
