import { checkArgs, FN_DEADLINE_MS, withDeadline } from "./index";
import { type JsonRpc, sseResponse } from "./mcp-util";
import { fail, type RtEnv, type ToolResult } from "./registry";
import { jmap } from "./fns/jmap";
import { jstr } from "./fns/_jmap";

// The mail MCP server — the ergonomic Fastmail surface, served at /mail/mcp behind
// the same workers-oauth-provider flow, so it appears as its own "mail" connector in
// claude.ai / mobile / desktop (zero new public surface, zero new infra). Mirrors
// vault-mcp.ts: a handful of tight, handle-disciplined tools that compile down to the
// raw `jmap` conduit (fns/jmap.ts) — which stays exposed here as the escape hatch, so
// the whole JMAP protocol (MaskedEmail, Calendars, Contacts, custom methods) is one
// tool away. Design: docs/proposals/mail.md + jmap.md.
//
// The rule (mail.md): list-verbs return references (ids + light metadata), never
// bodies; exactly one deliberate read (mail_read) returns the body. Send/destroy are
// the sensitive acts — mail_send sets allow_send; nothing here permanently destroys.

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Call the raw jmap conduit and parse its JSON envelope, throwing its error text on failure. */
async function jmapCall(env: RtEnv, args: Record<string, unknown>): Promise<{ methodResponses: any[]; sessionState?: string }> {
	const r = await jmap.run(env, args);
	const body = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(body);
	return JSON.parse(body);
}

/** The result args of the first methodResponse for `method` (null if it errored / absent). */
function resultFor(resp: { methodResponses: any[] }, method: string, callId?: string): any {
	for (const mr of resp.methodResponses ?? []) {
		if (mr[0] === method && (callId === undefined || mr[2] === callId)) return mr[1];
		if (mr[0] === "error" && (callId === undefined || mr[2] === callId)) throw new Error(`JMAP ${method} error: ${mr[1]?.type ?? "unknown"}`);
	}
	return null;
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Number(v) || dflt));

/** Reduce an Email object to a token-cheap reference (never the body). */
function shapeRef(e: any): Record<string, unknown> {
	const addr = (a: any[]): string => (Array.isArray(a) ? a.map((x) => x?.email).filter(Boolean).join(", ") : "");
	return {
		id: e?.id,
		threadId: e?.threadId,
		subject: e?.subject ?? "(no subject)",
		from: addr(e?.from),
		to: addr(e?.to),
		receivedAt: e?.receivedAt,
		preview: e?.preview,
		unread: !e?.keywords?.$seen,
		hasAttachment: !!e?.hasAttachment,
	};
}

/** Extract plain-text body from a fetched Email (textBody parts → bodyValues). */
function extractBody(e: any): string {
	const values = e?.bodyValues ?? {};
	const parts = Array.isArray(e?.textBody) && e.textBody.length ? e.textBody : e?.htmlBody;
	if (Array.isArray(parts)) {
		const chunks = parts.map((p: any) => values[p?.partId]?.value).filter(Boolean);
		if (chunks.length) return chunks.join("\n");
	}
	// Fall back to any bodyValue present.
	const anyVal = Object.values(values)
		.map((v: any) => v?.value)
		.filter(Boolean);
	return anyVal.join("\n");
}

/** Fetch the mailbox role→id map (inbox/drafts/sent/archive/trash/junk). */
async function mailboxMap(env: RtEnv): Promise<{ byRole: Record<string, string>; byName: Record<string, string>; list: any[] }> {
	const resp = await jmapCall(env, { method: "Mailbox/get", args: {} });
	const list = resultFor(resp, "Mailbox/get")?.list ?? [];
	const byRole: Record<string, string> = {};
	const byName: Record<string, string> = {};
	for (const m of list) {
		if (m?.role) byRole[String(m.role).toLowerCase()] = m.id;
		if (m?.name) byName[String(m.name).toLowerCase()] = m.id;
	}
	return { byRole, byName, list };
}

/** Resolve a mailbox arg (a role like "inbox", a display name, or a raw id) to an id. */
function resolveMailboxId(map: { byRole: Record<string, string>; byName: Record<string, string> }, mailbox: string): string | undefined {
	const key = mailbox.toLowerCase();
	return map.byRole[key] ?? map.byName[key] ?? mailbox; // fall through: treat as a raw id
}

/** Build an Email/query filter from ergonomic args. */
async function buildFilter(env: RtEnv, a: any): Promise<Record<string, unknown>> {
	const conds: Record<string, unknown> = {};
	if (a?.query) conds.text = String(a.query);
	if (a?.from) conds.from = String(a.from);
	if (a?.subject) conds.subject = String(a.subject);
	if (a?.after) conds.after = String(a.after);
	if (a?.before) conds.before = String(a.before);
	if (a?.mailbox) {
		const map = await mailboxMap(env);
		conds.inMailbox = resolveMailboxId(map, String(a.mailbox));
	}
	if (a?.unread === true) {
		// unread = NOT $seen. JMAP composes with an operator node.
		return { operator: "AND", conditions: [conds, { operator: "NOT", conditions: [{ hasKeyword: "$seen" }] }] };
	}
	return conds;
}

type MailTool = { name: string; description: string; inputSchema: unknown; run: (env: RtEnv, args: any) => Promise<ToolResult> };

const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: jstr(v) }] });

const TOOLS: MailTool[] = [
	{
		name: "mail_search",
		description: "Search mail — returns message references (id, subject, from, preview), never bodies. Filter by query text, mailbox (role like inbox/archive or a name), from, subject, unread, after/before (ISO dates). Read one with mail_read.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string", description: "Free-text search across the message." },
				mailbox: { type: "string", description: "Mailbox role (inbox, archive, sent, drafts, trash, junk) or display name." },
				from: { type: "string", description: "Filter by sender." },
				subject: { type: "string", description: "Filter by subject." },
				unread: { type: "boolean", description: "Only unread messages." },
				after: { type: "string", description: "Only messages after this ISO date/time." },
				before: { type: "string", description: "Only messages before this ISO date/time." },
				limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
			},
		},
		run: async (env, a) => {
			try {
				const filter = await buildFilter(env, a);
				const limit = clamp(a?.limit, 1, 50, 20);
				const resp = await jmapCall(env, {
					calls: [
						["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: false }], limit }, "q"],
						["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "threadId", "subject", "from", "to", "receivedAt", "preview", "keywords", "hasAttachment"] }, "g"],
					],
				});
				const emails = resultFor(resp, "Email/get")?.list ?? [];
				return ok({ count: emails.length, emails: emails.map(shapeRef) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_read",
		description: "Read one message in full — headers plus the plain-text body. The one deliberate 'return the bytes' verb; use mail_search first to find the id.",
		inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", description: "Email id from mail_search." } } },
		run: async (env, a) => {
			if (!a?.id) return fail("mail_read requires an `id`.");
			try {
				const resp = await jmapCall(env, {
					method: "Email/get",
					args: { ids: [String(a.id)], properties: ["id", "threadId", "subject", "from", "to", "cc", "receivedAt", "keywords", "textBody", "htmlBody", "bodyValues", "hasAttachment", "attachments"], fetchTextBodyValues: true, fetchHTMLBodyValues: false, maxBodyValueBytes: 200_000 },
				});
				const e = resultFor(resp, "Email/get")?.list?.[0];
				if (!e) return fail(`No message '${a.id}'.`);
				const attachments = Array.isArray(e.attachments) ? e.attachments.map((x: any) => ({ blobId: x?.blobId, name: x?.name, type: x?.type, size: x?.size })) : [];
				return ok({ ...shapeRef(e), body: extractBody(e), attachments });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_thread",
		description: "Read a whole conversation — every message in the thread as references (headers + preview). Pass a threadId, or an email `id` and its thread is resolved.",
		inputSchema: { type: "object", additionalProperties: false, properties: { threadId: { type: "string" }, id: { type: "string", description: "An email id — its threadId is resolved first." } } },
		run: async (env, a) => {
			try {
				let threadId = a?.threadId ? String(a.threadId) : "";
				if (!threadId && a?.id) {
					const r0 = await jmapCall(env, { method: "Email/get", args: { ids: [String(a.id)], properties: ["threadId"] } });
					threadId = resultFor(r0, "Email/get")?.list?.[0]?.threadId ?? "";
				}
				if (!threadId) return fail("mail_thread needs a `threadId` or an email `id`.");
				const resp = await jmapCall(env, {
					calls: [
						["Thread/get", { ids: [threadId] }, "t"],
						["Email/get", { "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: ["id", "threadId", "subject", "from", "to", "receivedAt", "preview", "keywords"] }, "e"],
					],
				});
				const emails = resultFor(resp, "Email/get")?.list ?? [];
				return ok({ threadId, count: emails.length, messages: emails.map(shapeRef) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_mailboxes",
		description: "List mailboxes (folders) with their role, unread and total counts.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: async (env) => {
			try {
				const resp = await jmapCall(env, { method: "Mailbox/get", args: {} });
				const list = resultFor(resp, "Mailbox/get")?.list ?? [];
				return ok({ count: list.length, mailboxes: list.map((m: any) => ({ id: m?.id, name: m?.name, role: m?.role, unread: m?.unreadEmails, total: m?.totalEmails })) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_identities",
		description: "List the addresses you can send from (id, name, email) — pick one for mail_send's `from`.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: async (env) => {
			try {
				const resp = await jmapCall(env, { method: "Identity/get", args: {} });
				const list = resultFor(resp, "Identity/get")?.list ?? [];
				return ok({ count: list.length, identities: list.map((i: any) => ({ id: i?.id, name: i?.name, email: i?.email })) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_draft",
		description: "Save a draft (does NOT send). Returns the created message id. Provide to/subject/text; cc/bcc/from optional.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["to", "subject", "text"],
			properties: {
				to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string" },
				text: { type: "string", description: "Plain-text body." },
				from: { type: "string", description: "Sender address (defaults to your primary identity)." },
			},
		},
		run: async (env, a) => draftOrSend(env, a, false),
	},
	{
		name: "mail_send",
		description: "Send an email. Composes the draft, submits it, and files it in Sent. Provide to/subject/text; cc/bcc/from optional. Dispatches immediately — there is no scheduled send and no undo, so review before sending.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["to", "subject", "text"],
			properties: {
				to: { type: "array", items: { type: "string" } },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string" },
				text: { type: "string", description: "Plain-text body." },
				from: { type: "string", description: "Sender address (defaults to your primary identity)." },
			},
		},
		run: async (env, a) => draftOrSend(env, a, true),
	},
	{
		name: "mail_archive",
		description: "Archive one or more messages (remove from Inbox, add to Archive). Reversible — nothing is deleted.",
		inputSchema: { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", items: { type: "string" }, description: "Email ids." } } },
		run: async (env, a) => moveMessages(env, a?.ids, "archive"),
	},
	{
		name: "mail_move",
		description: "Move messages to a mailbox (by role like inbox/archive/junk/trash, a display name, or a raw id). Reversible.",
		inputSchema: { type: "object", additionalProperties: false, required: ["ids", "mailbox"], properties: { ids: { type: "array", items: { type: "string" } }, mailbox: { type: "string" } } },
		run: async (env, a) => moveMessages(env, a?.ids, String(a?.mailbox ?? "")),
	},
	{
		name: "mail_masked",
		description: "Fastmail Masked Email — list your masked addresses, or create a new one for a site (forDomain + description). A privacy superpower a normal mail tool can't reach.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: { type: "string", enum: ["list", "create"], default: "list" },
				forDomain: { type: "string", description: "The site the masked address is for (action=create)." },
				description: { type: "string", description: "A note to remember what it's for (action=create)." },
			},
		},
		run: async (env, a) => {
			try {
				const action = String(a?.action ?? "list");
				if (action === "create") {
					const resp = await jmapCall(env, { calls: [["MaskedEmail/set", { create: { m: { state: "enabled", forDomain: a?.forDomain ? String(a.forDomain) : undefined, description: a?.description ? String(a.description) : undefined } } }, "s"]] });
					const created = resultFor(resp, "MaskedEmail/set")?.created?.m;
					if (!created) return fail(`MaskedEmail create failed: ${JSON.stringify(resultFor(resp, "MaskedEmail/set")?.notCreated ?? {})}`);
					return ok({ created: { id: created.id, email: created.email, forDomain: created.forDomain, description: created.description } });
				}
				const resp = await jmapCall(env, { method: "MaskedEmail/get", args: {} });
				const list = resultFor(resp, "MaskedEmail/get")?.list ?? [];
				return ok({ count: list.length, masked: list.map((m: any) => ({ id: m?.id, email: m?.email, state: m?.state, forDomain: m?.forDomain, description: m?.description })) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "jmap",
		description:
			"Raw JMAP escape hatch — the full protocol when the ergonomic mail_* tools don't cover it (Calendars, Contacts, custom methods, complex batches). Same contract as the universal `jmap` fn: calls:[[method,args,callId]] or method+args; allow_send/allow_destroy gates; paginate; upload/download. Byte-exact methodResponses.",
		inputSchema: jmap.inputSchema,
		run: (env, a) => jmap.run(env, a),
	},
];

/** Shared draft/send: resolve identity + drafts/sent mailboxes, build the batch, dispatch. */
async function draftOrSend(env: RtEnv, a: any, send: boolean): Promise<ToolResult> {
	const to = Array.isArray(a?.to) ? a.to : a?.to ? [a.to] : [];
	if (!to.length || !a?.subject || a?.text === undefined) return fail("provide to[], subject, and text.");
	try {
		// One round-trip to resolve identity + mailbox roles.
		const meta = await jmapCall(env, { calls: [["Identity/get", {}, "i"], ["Mailbox/get", {}, "m"]] });
		const identities = resultFor(meta, "Identity/get")?.list ?? [];
		const mailboxes = resultFor(meta, "Mailbox/get")?.list ?? [];
		const roleId = (role: string) => mailboxes.find((m: any) => m?.role === role)?.id;
		const draftsId = roleId("drafts");
		const sentId = roleId("sent");
		if (!draftsId) return fail("no Drafts mailbox found on this account.");
		const fromWanted = a?.from ? String(a.from).toLowerCase() : "";
		let identity: any;
		if (fromWanted) {
			// An explicit `from` that matches no identity must FAIL — never silently
			// send from a different (primary) address than the caller asked for.
			identity = identities.find((i: any) => String(i?.email).toLowerCase() === fromWanted);
			if (!identity) return fail(`no sending identity for from address '${fromWanted}' — check mail_identities.`);
		} else {
			identity = identities[0];
		}
		if (!identity) return fail("no sending identity found.");
		const addrs = (xs: string[]) => xs.map((e) => ({ email: String(e) }));

		const draft: Record<string, unknown> = {
			mailboxIds: { [draftsId]: true },
			keywords: { $draft: true },
			from: [{ email: identity.email, name: identity.name }],
			to: addrs(to),
			...(Array.isArray(a?.cc) && a.cc.length ? { cc: addrs(a.cc) } : {}),
			...(Array.isArray(a?.bcc) && a.bcc.length ? { bcc: addrs(a.bcc) } : {}),
			subject: String(a.subject),
			bodyStructure: { type: "text/plain", partId: "b" },
			bodyValues: { b: { value: String(a.text) } },
		};

		if (!send) {
			const resp = await jmapCall(env, { calls: [["Email/set", { create: { draft } }, "c"]] });
			const created = resultFor(resp, "Email/set")?.created?.draft;
			if (!created) return fail(`draft failed: ${JSON.stringify(resultFor(resp, "Email/set")?.notCreated ?? {})}`);
			return ok({ drafted: true, id: created.id });
		}

		// Send: create draft, submit, and on success strip $draft + move Drafts→Sent.
		const onSuccess: Record<string, unknown> = { "keywords/$draft": null };
		if (draftsId) onSuccess[`mailboxIds/${draftsId}`] = null;
		if (sentId) onSuccess[`mailboxIds/${sentId}`] = true;
		const resp = await jmapCall(env, {
			allow_send: true,
			calls: [
				["Email/set", { create: { draft } }, "c"],
				["EmailSubmission/set", { create: { sub: { emailId: "#draft", identityId: identity.id } }, onSuccessUpdateEmail: { "#sub": onSuccess } }, "s"],
			],
		});
		const submitted = resultFor(resp, "EmailSubmission/set")?.created?.sub;
		if (!submitted) return fail(`send failed: ${JSON.stringify(resultFor(resp, "EmailSubmission/set")?.notCreated ?? {})}`);
		return ok({ sent: true, submissionId: submitted.id, to });
	} catch (e) {
		return fail(errMsg(e));
	}
}

/** Move messages into a target mailbox — REPLACES the mailbox set (a real move, not an add). */
async function moveMessages(env: RtEnv, ids: unknown, target: string): Promise<ToolResult> {
	const list = Array.isArray(ids) ? ids.map(String) : [];
	if (!list.length || !target) return fail("provide ids[] and a target mailbox.");
	try {
		const map = await mailboxMap(env);
		const targetId = resolveMailboxId(map, target);
		if (!targetId) return fail(`unknown mailbox '${target}'.`);
		// A MOVE sets mailboxIds to EXACTLY the target — the additive `mailboxIds/<id>:true`
		// patch left the message in its origin mailbox too (move-to-trash stayed in the Inbox).
		const update: Record<string, unknown> = {};
		for (const id of list) update[id] = { mailboxIds: { [targetId]: true } };
		const resp = await jmapCall(env, { calls: [["Email/set", { update }, "u"]] });
		const setResult = resultFor(resp, "Email/set");
		const moved = Object.keys(setResult?.updated ?? {});
		const notUpdated = setResult?.notUpdated ?? {};
		const failed = Object.keys(notUpdated);
		// Don't report a silent moved:0 — an invalid target / rejected patch surfaces as an error.
		if (!moved.length && failed.length) return fail(`move to '${target}' failed: ${JSON.stringify(notUpdated).slice(0, 300)}`);
		return ok({ moved: moved.length, to: target, ...(failed.length ? { failed: failed.length, errors: notUpdated } : {}) });
	} catch (e) {
		return fail(errMsg(e));
	}
}

export const MAIL_TOOLS = TOOLS;

// Mirrors handleVaultRpc: the per-request MCP protocol shell with the mail registry.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function handleMailRpc(env: RtEnv, _ctx: ExecutionContext, rpc: JsonRpc | undefined, bodyBytes = 0): Promise<Response> {
	const method = rpc?.method;
	const id = rpc?.id ?? null;

	if (!method) return new Response(null, { status: 202 });
	if (method === "tools/call" && bodyBytes > MAX_BODY_BYTES) {
		return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Request too large (${bodyBytes} bytes > ${MAX_BODY_BYTES}).` }], isError: true } });
	}
	if (method === "initialize") {
		return sseResponse({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mail", version: "0.1.0" } } });
	}
	if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
	if (method === "tools/list") {
		return sseResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
	}
	if (method === "tools/call") {
		const name = String(rpc?.params?.name ?? "");
		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
		const args = rpc?.params?.arguments ?? {};
		const argErr = checkArgs(args, MAX_BODY_BYTES, 64);
		if (argErr) return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${name} rejected: ${argErr}` }], isError: true } });
		try {
			const result = await withDeadline(name, FN_DEADLINE_MS, tool.run(env, args));
			return sseResponse({ jsonrpc: "2.0", id, result });
		} catch (e) {
			return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${name} failed: ${errMsg(e)}` }], isError: true } });
		}
	}
	return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}
