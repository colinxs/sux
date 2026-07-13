import { checkArgs, FN_DEADLINE_MS, withDeadline } from "./index";
import { type JsonRpc, sseResponse } from "./mcp-util";
import { fail, failWith, type RtEnv, type ToolResult } from "./registry";
import { staged } from "./stage";
import { jmap } from "./fns/jmap";
import { doUpload, jstr, scopeProbe } from "./fns/_jmap";
import { buildVEvent, buildVTodo, CALDAV_NOT_CONFIGURED, type CalendarRef, caldavFetch, calendarHome, dateProp, hasCalDav, icalDateToIso, listCalendars, parseICal, replaceProps, reportObjects, textProp } from "./fns/_caldav";
import { htmlToMd } from "./fns/_markup";
import { errMsg, storeBase } from "./fns/_util";

// The mail MCP server — the ergonomic Fastmail surface, reached through the `mail_`
// (and `cal_`/`contact_`) front verbs on the one /mcp connector, behind the same
// workers-oauth-provider flow (zero new public surface, zero new infra). The old
// /mail/mcp connector is retired — its route stays dormant for back-compat but ships
// no plugin; front verbs dispatch into these handlers now. Mirrors
// vault-mcp.ts: a handful of tight, handle-disciplined tools that compile down to the
// raw `jmap` conduit (fns/jmap.ts) — which stays exposed here as the escape hatch, so
// the whole JMAP protocol (MaskedEmail, Calendars, Contacts, custom methods) is one
// tool away. Design: docs/proposals/mail.md + jmap.md.
//
// The rule (mail.md): list-verbs return references (ids + light metadata), never
// bodies; exactly one deliberate read (mail_read) returns the body. Send/destroy are
// the sensitive acts — mail_send sets allow_send; nothing here permanently destroys.


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

// --- mail_push (JMAP PushSubscription) — one KV record, keyed by a fixed key since sux
// only ever needs one live subscription (one Fastmail account). The URL path segment
// (`token`) IS the credential: Fastmail's push POST carries no auth header of ours, so an
// unguessable token in the webhook URL is the boundary. Even a guessed/leaked token can only
// trigger an extra mail_triage cycle early — triage's own MAIL_TRIAGE_ENABLED gate still
// applies, so this can't do anything the existing bearer-gated /admin/tick couldn't already.
const PUSH_KV_KEY = "sux:mailpush:sub";
type PushState = { id: string; token: string; verified: boolean; createdAt: number; expires: string | null };

async function pushState(env: RtEnv): Promise<PushState | null> {
	const raw = await env.OAUTH_KV?.get(PUSH_KV_KEY);
	return raw ? JSON.parse(raw) : null;
}
async function savePushState(env: RtEnv, s: PushState | null): Promise<void> {
	if (!s) await env.OAUTH_KV?.delete(PUSH_KV_KEY);
	else await env.OAUTH_KV?.put(PUSH_KV_KEY, JSON.stringify(s));
}
function randomPushToken(): string {
	return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The public webhook target Fastmail POSTs to. Two cases:
 *   1. The FIRST push after subscribing carries a `verificationCode` — confirm it via
 *      PushSubscription/set update, per RFC 8620 §7.2.2. No confirm, no future pushes.
 *   2. Any later push is a StateChange notification — trigger `trigger()` (the caller wires
 *      this to mailTriageTick) iff the subscription is verified, so a spoofed/pre-verification
 *      POST to a guessed token can't fire anything.
 * Returns true iff the token matched a live subscription (index.ts uses this to 404 otherwise,
 * so a wrong/expired token is indistinguishable from the route not existing).
 */
export async function handleMailPushWebhook(env: RtEnv, token: string, rawBody: string, trigger: () => Promise<unknown>): Promise<boolean> {
	const existing = await pushState(env);
	if (!existing || existing.token !== token) return false;
	let body: any = null;
	try {
		body = rawBody ? JSON.parse(rawBody) : null;
	} catch {
		/* a malformed body still 200s (Fastmail just wants the ack) but does nothing */
	}
	const isVerification = body?.["@type"] === "PushVerification";
	const verificationCode = isVerification ? body?.verificationCode : undefined;
	if (verificationCode && !existing.verified) {
		try {
			const resp = await jmapCall(env, { calls: [["PushSubscription/set", { update: { [existing.id]: { verificationCode: String(verificationCode) } } }, "s"]] });
			const setR = resultFor(resp, "PushSubscription/set");
			if (Object.prototype.hasOwnProperty.call(setR?.updated ?? {}, existing.id)) await savePushState(env, { ...existing, verified: true });
		} catch {
			/* verification confirm failed — leave unverified; a later legit push will retry */
		}
		return true;
	}
	if (existing.verified) await trigger();
	return true;
}

/** The stage-guard arg triplet, threaded uniformly at every staged() call site. `force` finally
 *  rides through (was dropped everywhere), so the one-shot `!`-override is live for every mail verb. */
const gateArgs = (a: any) => ({ stage: a?.stage === true, commit_token: a?.commit_token ? String(a.commit_token) : undefined, force: a?.force === true });

/** Reduce an Email object to a token-cheap reference (never the body). */
// RFC 8620 §5.1: Foo/get MAY return records in any order, so it doesn't preserve the
// Email/query sort. Re-sort the hydrated list by receivedAt (ISO-8601 → lexicographic works).
const byReceived = (asc: boolean) => (a: any, b: any) => (asc ? 1 : -1) * String(a?.receivedAt ?? "").localeCompare(String(b?.receivedAt ?? ""));

/** From→identity: exact match, else a stored `*@domain` wildcard identity by domain suffix.
 *  A concrete address never string-equals a wildcard identity, which threw "From is not verified"
 *  before any API call — this lets send-as-any work at owned domains (workflow §1a). */
function resolveIdentity(identities: any[], from: string): any {
	const f = from.toLowerCase();
	return identities.find((i: any) => String(i?.email).toLowerCase() === f) || identities.find((i: any) => String(i?.email).startsWith("*@") && f.endsWith(String(i.email).slice(1).toLowerCase()));
}

type AttachmentSpec = { blobId?: string; ref?: string; data?: string; type?: string; name?: string; disposition?: string; cid?: string };
type ResolvedPart = { blobId: string; type: string; name?: string; disposition?: string; cid?: string; size?: number };

/** Resolve one attachment spec to a Fastmail blob: a {blobId} passes through; a {ref} (sux /s/<uuid> CAS
 *  handle) or {data} (base64) is STREAMED to the JMAP uploadUrl via doUpload — bytes never round-trip
 *  through the model context. Returns the blobId + metadata for the multipart part (workflow §1e). */
async function resolveAttachment(env: RtEnv, x: AttachmentSpec): Promise<ResolvedPart> {
	if (x?.blobId) return { blobId: String(x.blobId), type: String(x?.type ?? "application/octet-stream"), name: x?.name, disposition: x?.disposition, cid: x?.cid };
	const src = x?.ref ?? x?.data;
	if (!src) throw new Error("each attachment needs blobId, ref (a sux /s/<uuid> CAS handle), or data (base64).");
	const up = (await doUpload(env, String(src), String(x?.type ?? "application/octet-stream"))) as any;
	return { blobId: String(up.blobId), type: String(up.type ?? x?.type ?? "application/octet-stream"), size: up.size, name: x?.name, disposition: x?.disposition, cid: x?.cid };
}

/** A text body + resolved attachment parts → a multipart/mixed bodyStructure (RFC 8621 §4.1.4: a part
 *  with a blobId references an uploaded blob; the text part keeps its partId + bodyValue). */
function multipartBody(text: string, parts: ResolvedPart[]): Record<string, unknown> {
	return {
		bodyStructure: { type: "multipart/mixed", subParts: [{ type: "text/plain", partId: "b" }, ...parts.map((p) => ({ blobId: p.blobId, type: p.type, ...(p.name ? { name: p.name } : {}), disposition: p.disposition ?? "attachment", ...(p.cid ? { cid: p.cid } : {}) }))] },
		bodyValues: { b: { value: text } },
	};
}

/** A stage-safe descriptor of an attachment set — names/types + source kind, no bytes, no upload. Binds
 *  the stage→commit token to the exact attachment set without writing anything at preview time. */
function attachDescriptors(atts: AttachmentSpec[]): Array<Record<string, unknown>> {
	return atts.map((x) => ({ name: x?.name ?? null, type: x?.type ?? null, source: x?.blobId ? "blob" : x?.ref ? "ref" : x?.data ? "data" : "?" }));
}

/** Gate a scope-dependent verb: probe the token's reachable capabilities; return a not_configured
 *  message if `cap` isn't granted (contacts/vacation/quota live on a re-scoped FASTMAIL_TOKEN), else null. */
async function scopeGate(env: RtEnv, cap: "contacts" | "vacationresponse" | "quota"): Promise<string | null> {
	const scope = (await scopeProbe(env)) as Record<string, boolean>;
	if (scope[cap]) return null;
	const label = cap === "vacationresponse" ? "vacation responder" : cap;
	return `The current FASTMAIL_TOKEN doesn't grant the '${cap}' JMAP capability, so ${label} isn't reachable. Re-mint the token with ${cap} scope (Fastmail → Settings → Privacy & Security → API tokens) and retry — the verb is otherwise ready.`;
}

/** Full name from JSCard name.components (RFC 9553) when there's no `full`. */
function nameFromComponents(components: any): string {
	if (!Array.isArray(components)) return "";
	const by = (kind: string) => components.find((c: any) => c?.kind === kind)?.value;
	return [by("given"), by("surname")].filter(Boolean).join(" ");
}

/** Shape a JMAP ContactCard (RFC 9610/JSCard — Fastmail's contacts object) to a token-cheap reference. */
function shapeContact(c: any): Record<string, unknown> {
	const emails = c?.emails ? Object.values(c.emails).map((e: any) => e?.address).filter(Boolean) : [];
	const phones = c?.phones ? Object.values(c.phones).map((p: any) => p?.number).filter(Boolean) : [];
	const company = c?.organizations ? (Object.values(c.organizations)[0] as any)?.name : undefined;
	const name = c?.name?.full || nameFromComponents(c?.name?.components) || company || emails[0] || "(no name)";
	return { id: c?.id, name, ...(company ? { company } : {}), emails, phones };
}

/** Pick a target calendar collection: the caller's href, else the first non-task (or task) calendar. */
async function pickCalendar(env: RtEnv, wantTasks: boolean, href?: string): Promise<CalendarRef> {
	const cals = await listCalendars(env);
	if (href) {
		const found = cals.find((c) => c.href === href);
		if (!found) throw new Error(`no calendar with href '${href}' — list them with cal_list.`);
		return found;
	}
	const pick = cals.find((c) => c.isTasks === wantTasks) ?? cals[0];
	if (!pick) throw new Error("no calendars found on this account.");
	return pick;
}

/** Shape a parsed VEVENT/VTODO component to a token-cheap reference. */
function shapeCalObject(o: { href: string; etag: string | null; ical: string }): Record<string, unknown> | null {
	const comp = parseICal(o.ical)[0];
	if (!comp) return null;
	const p = comp.props;
	const base = { uid: p.UID, summary: p.SUMMARY, href: o.href, etag: o.etag };
	if (comp.component === "VTODO") {
		const due = p.DUE ? icalDateToIso(p.DUE, comp.params.DUE) : null;
		return { ...base, due: due?.iso ?? null, ...(due?.all_day ? { all_day: true } : {}), ...(due?.tz ? { tz: due.tz } : {}), status: p.STATUS ?? null, description: p.DESCRIPTION ?? undefined };
	}
	return { ...base, start: comp.start, end: comp.end, all_day: comp.all_day, ...(comp.tz ? { tz: comp.tz } : {}), location: p.LOCATION ?? undefined, description: p.DESCRIPTION ?? undefined };
}

class NotFound extends Error {}

/** Property-set for a cal_update/task_update/task_complete rewrite. DTSTAMP (and, for a COMPLETED
 *  task, the COMPLETED stamp) are stamped fresh here — call it at write time, never at stage, so the
 *  timestamps aren't baked into the payload the commit_token is bound to. `null` deletes a property. */
function buildCalSets(a: any, comp: "VEVENT" | "VTODO"): Record<string, string | null> {
	const clear = (v: unknown) => String(v) === "";
	const sets: Record<string, string | null> = { DTSTAMP: dateProp("DTSTAMP", new Date().toISOString()) };
	if (a?.summary !== undefined) sets.SUMMARY = textProp("SUMMARY", String(a.summary));
	if (a?.description !== undefined) sets.DESCRIPTION = clear(a.description) ? null : textProp("DESCRIPTION", String(a.description));
	if (comp === "VEVENT") {
		if (a?.start !== undefined) sets.DTSTART = dateProp("DTSTART", String(a.start));
		if (a?.end !== undefined) sets.DTEND = clear(a.end) ? null : dateProp("DTEND", String(a.end));
		if (a?.location !== undefined) sets.LOCATION = clear(a.location) ? null : textProp("LOCATION", String(a.location));
	} else {
		if (a?.due !== undefined) sets.DUE = clear(a.due) ? null : dateProp("DUE", String(a.due));
		if (a?.status !== undefined) sets.STATUS = textProp("STATUS", String(a.status));
		if (String(a?.status ?? "").toUpperCase() === "COMPLETED") {
			sets.COMPLETED = dateProp("COMPLETED", new Date().toISOString());
			sets["PERCENT-COMPLETE"] = "PERCENT-COMPLETE:100";
		}
	}
	return sets;
}

/** The fields a caller meaningfully changed (excludes the always-stamped DTSTAMP + COMPLETED consequences). */
const CHANGE_KEYS = ["SUMMARY", "DESCRIPTION", "DTSTART", "DTEND", "LOCATION", "DUE", "STATUS"];

/** Shared cal_update/task_update/task_complete: GET the object, rewrite the requested properties in
 *  place (UID/alarms/timezone-encoding preserved), PUT with an If-Match guard. Stage-then-commit. */
async function calPatch(env: RtEnv, a: any, comp: "VEVENT" | "VTODO"): Promise<ToolResult> {
	const noun = comp === "VTODO" ? "task" : "event";
	if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
	if (!a?.href) return failWith("bad_input", `${noun} update requires the object \`href\`.`);
	const href = String(a.href);
	// Validate + compute the changed field set up front (a bad date surfaces as bad_input, not a 5xx).
	let changed: string[];
	try {
		changed = Object.keys(buildCalSets(a, comp)).filter((k) => CHANGE_KEYS.includes(k));
	} catch (e) {
		return failWith("bad_input", errMsg(e));
	}
	if (!changed.length) return failWith("bad_input", `nothing to update — pass at least one ${noun} field to change.`);
	const kind = comp === "VTODO" ? (a?._complete ? "task_complete" : "task_update") : "cal_update";
	// Payload is args-derived (deterministic) so the stage→commit hash is stable across the two calls.
	const fields: Record<string, unknown> = {};
	for (const k of ["summary", "start", "end", "description", "location", "due", "status"]) if (a?.[k] !== undefined) fields[k] = a[k];
	const payload = { href, comp, complete: a?._complete === true, etag: a?.etag ?? null, ...fields };
	const preview = { action: a?._complete ? "complete task" : `update ${noun}`, href, changes: changed };
	const mutate = async () => {
		const cur = await caldavFetch(env, "GET", href);
		if (cur.status === 404) throw new NotFound(`no ${noun} at '${href}' — list it with ${comp === "VTODO" ? "task_list" : "cal_events"}.`);
		if (!cur.ok) throw new Error(`fetch-for-update failed: HTTP ${cur.status}`);
		const body = replaceProps(cur.text, comp, buildCalSets(a, comp));
		const ifMatch = a?.etag ? String(a.etag) : (cur.etag ?? undefined);
		const r = await caldavFetch(env, "PUT", href, { body, contentType: "text/calendar; charset=utf-8", ...(ifMatch ? { ifMatch } : {}) });
		if (!r.ok) throw new Error(`${noun} update failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
		return { updated: true, href, etag: r.etag, changed };
	};
	try {
		const out = await staged(env, kind, gateArgs(a), payload, preview, mutate);
		return ok("stageResult" in out ? out.stageResult : out.result);
	} catch (e) {
		if (e instanceof NotFound) return failWith("not_found", errMsg(e));
		return fail(errMsg(e));
	}
}

/** Map ergonomic contact args (plain strings) to a JSCard ContactCard patch — only the provided fields.
 *  @type/version are added at create time; an update patch carries just the changed fields. */
function contactCard(a: any): Record<string, unknown> {
	const card: Record<string, unknown> = {};
	// `name` is a fallback for callers who don't split first/last (this fn's own
	// dispatcher doc examples use it: contact({action:'create', name, emails})) —
	// the schema never had it, so a plain `name` silently vanished and created a
	// nameless contact (likely why placeholder-named contacts like "Autosaved" /
	// "Imported <date>" exist). Split on the first space; a single word becomes
	// firstName only. Explicit firstName/lastName still win if both are given.
	let given = a?.firstName !== undefined ? String(a.firstName) : undefined;
	let surname = a?.lastName !== undefined ? String(a.lastName) : undefined;
	if (given === undefined && surname === undefined && typeof a?.name === "string" && a.name.trim()) {
		const parts = a.name.trim().split(/\s+/);
		given = parts[0];
		surname = parts.slice(1).join(" ") || undefined;
	}
	if (given !== undefined || surname !== undefined) {
		const components = [...(given !== undefined ? [{ kind: "given", value: given }] : []), ...(surname !== undefined ? [{ kind: "surname", value: surname }] : [])];
		const full = [given, surname].filter(Boolean).join(" ");
		card.name = { components, ...(full ? { full } : {}) };
	}
	if (a?.company !== undefined) card.organizations = { o1: { "@type": "Organization", name: String(a.company) } };
	if (Array.isArray(a?.emails)) card.emails = Object.fromEntries(a.emails.map((e: string, i: number) => [`e${i + 1}`, { "@type": "EmailAddress", address: String(e) }]));
	if (Array.isArray(a?.phones)) card.phones = Object.fromEntries(a.phones.map((p: string, i: number) => [`p${i + 1}`, { "@type": "Phone", number: String(p) }]));
	return card;
}

const ATTACHMENTS_SCHEMA = {
	type: "array",
	description:
		"Attachments. Each item: {blobId} (an already-uploaded Fastmail blob), {ref} (a sux /s/<uuid> CAS handle — the primary path; the bytes stream R2→JMAP and never pass through the model context), or {data} (base64, small files only). Optional name, type, disposition ('attachment'|'inline'), cid (for inline images).",
	items: { type: "object", additionalProperties: false, properties: { blobId: { type: "string" }, ref: { type: "string" }, data: { type: "string" }, type: { type: "string" }, name: { type: "string" }, disposition: { type: "string", enum: ["attachment", "inline"] }, cid: { type: "string" } } },
};

function shapeRef(e: any, boxNames?: Record<string, string>): Record<string, unknown> {
	const addr = (a: any[]): string => (Array.isArray(a) ? a.map((x) => x?.email).filter(Boolean).join(", ") : "");
	const kw = e?.keywords ?? {};
	const boxIds = e?.mailboxIds ? Object.keys(e.mailboxIds) : undefined;
	const labels = boxIds && boxNames ? boxIds.map((id) => boxNames[id] ?? id) : boxIds;
	return {
		id: e?.id,
		threadId: e?.threadId,
		subject: e?.subject ?? "(no subject)",
		from: addr(e?.from),
		to: addr(e?.to),
		...(addr(e?.cc) ? { cc: addr(e.cc) } : {}),
		receivedAt: e?.receivedAt,
		preview: e?.preview,
		isRead: !!kw.$seen,
		isFlagged: !!kw.$flagged,
		isDraft: !!kw.$draft,
		unread: !kw.$seen,
		hasAttachment: !!e?.hasAttachment,
		...(labels ? { labels } : {}),
	};
}

/** Extract a readable plain-text body from a fetched Email. Prefers textBody
 * parts; for an HTML-only message it falls back to htmlBody, converting the HTML
 * to Markdown-ish text (readable, link-preserving) rather than dumping raw tags.
 * The htmlBody parts only carry a `value` when the Email/get set fetchHTMLBodyValues —
 * otherwise this fallback silently returned empty (the bug this fixes). */
function extractBody(e: any): string {
	const values = e?.bodyValues ?? {};
	const chunksFor = (parts: any): string[] => (Array.isArray(parts) ? parts.map((p: any) => values[p?.partId]?.value).filter(Boolean) : []);
	const text = chunksFor(e?.textBody);
	if (text.length) return text.join("\n");
	const html = chunksFor(e?.htmlBody);
	if (html.length) return htmlToMd(html.join("\n"));
	// Last resort: any bodyValue present. Convert it if it looks like HTML.
	const anyVal = Object.values(values)
		.map((v: any) => v?.value)
		.filter(Boolean)
		.join("\n");
	return /<[a-z!][\s\S]*>/i.test(anyVal) ? htmlToMd(anyVal) : anyVal;
}

/** "Name <email>" for a JMAP address array — the human-readable form used in quote/forward blocks. */
function addrLine(arr: any): string {
	return Array.isArray(arr) ? arr.map((x: any) => (x?.name ? `${x.name} <${x?.email}>` : String(x?.email ?? ""))).filter(Boolean).join(", ") : "";
}
const emailsOf = (arr: any): string[] => (Array.isArray(arr) ? arr.map((x: any) => String(x?.email ?? "")).filter(Boolean) : []);

/** Ensure a subject carries the reply/forward tag exactly once (case-insensitive, "Re:"/"Fwd:"). */
function tagSubject(subject: string, tag: "Re:" | "Fwd:"): string {
	const s = subject.trim();
	const re = tag === "Re:" ? /^re:/i : /^(fwd?|fw):/i;
	return re.test(s) ? s : `${tag} ${s}`;
}

/** Compose the reply/forward body: the author's text, then the attribution + quoted original. */
function quoteBody(mode: string, text: string, src: any): string {
	const orig = extractBody(src);
	if (mode === "forward") {
		const header = ["---------- Forwarded message ----------", `From: ${addrLine(src?.from)}`, `Date: ${src?.receivedAt ?? ""}`, `Subject: ${src?.subject ?? ""}`, `To: ${addrLine(src?.to)}`].join("\n");
		return `${text}\n\n${header}\n\n${orig}`.trimStart();
	}
	const attribution = `On ${src?.receivedAt ?? "an earlier date"}, ${addrLine(src?.from)} wrote:`;
	const quoted = orig.split("\n").map((l) => `> ${l}`).join("\n");
	return `${text}\n\n${attribution}\n${quoted}`.trimStart();
}

type MailboxMap = { byRole: Record<string, string>; byName: Record<string, string>; list: any[] };

// Per-isolate, short-TTL memo of the mailbox role→id map, keyed on `env`. mail_triage acts one
// message at a time and each move op refetches this map — a fresh `Mailbox/get` JMAP round trip —
// so an all-archive cycle over 25 messages fired 25 identical fetches. The role→id layout is
// effectively stable within a request, so one fetch serves the whole cycle. Disabled under vitest
// (mirroring _util.ts's FETCH_CACHE) so tests keep deterministic Mailbox/get call counts.
const MAILBOX_MAP_CACHE = new WeakMap<RtEnv, { at: number; map: MailboxMap }>();
const MAILBOX_MAP_TTL_MS = 30_000;
const mailboxMapCacheActive = (): boolean => !(typeof process !== "undefined" && process.env?.VITEST);

async function fetchMailboxMap(env: RtEnv): Promise<MailboxMap> {
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

/** Fetch the mailbox role→id map (inbox/drafts/sent/archive/trash/junk), memoized per env. */
async function mailboxMap(env: RtEnv): Promise<MailboxMap> {
	if (!mailboxMapCacheActive()) return fetchMailboxMap(env);
	const hit = MAILBOX_MAP_CACHE.get(env);
	if (hit && Date.now() - hit.at <= MAILBOX_MAP_TTL_MS) return hit.map;
	const map = await fetchMailboxMap(env);
	MAILBOX_MAP_CACHE.set(env, { at: Date.now(), map });
	return map;
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
						["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "threadId", "subject", "from", "to", "cc", "receivedAt", "preview", "keywords", "mailboxIds", "hasAttachment"] }, "g"],
						["Mailbox/get", { properties: ["id", "name"] }, "m"],
					],
				});
				const boxNames: Record<string, string> = Object.fromEntries((resultFor(resp, "Mailbox/get")?.list ?? []).map((b: any) => [b?.id, b?.name]));
				const emails = (resultFor(resp, "Email/get")?.list ?? []).slice().sort(byReceived(false)); // newest first, matching the query sort
				return ok({ count: emails.length, emails: emails.map((e: any) => shapeRef(e, boxNames)) });
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
			if (!a?.id) return failWith("bad_input", "mail_read requires an `id`.");
			try {
				const resp = await jmapCall(env, {
					calls: [
						["Email/get", { ids: [String(a.id)], properties: ["id", "threadId", "subject", "from", "to", "cc", "receivedAt", "keywords", "mailboxIds", "textBody", "htmlBody", "bodyValues", "hasAttachment", "attachments"], fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 200_000 }, "g"],
						["Mailbox/get", { properties: ["id", "name"] }, "m"],
					],
				});
				const boxNames: Record<string, string> = Object.fromEntries((resultFor(resp, "Mailbox/get")?.list ?? []).map((b: any) => [b?.id, b?.name]));
				const e = resultFor(resp, "Email/get")?.list?.[0];
				if (!e) return failWith("not_found", `No message '${a.id}'.`);
				const attachments = Array.isArray(e.attachments) ? e.attachments.map((x: any) => ({ blobId: x?.blobId, name: x?.name, type: x?.type, size: x?.size })) : [];
				return ok({ ...shapeRef(e, boxNames), body: extractBody(e), attachments });
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
				if (!threadId) return failWith("bad_input", "mail_thread needs a `threadId` or an email `id`.");
				const resp = await jmapCall(env, {
					calls: [
						["Thread/get", { ids: [threadId] }, "t"],
						["Email/get", { "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: ["id", "threadId", "subject", "from", "to", "receivedAt", "preview", "keywords"] }, "e"],
					],
				});
				const emails = (resultFor(resp, "Email/get")?.list ?? []).slice().sort(byReceived(true)); // chronological thread order
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
		name: "mail_mailbox",
		description:
			"Create, rename, or delete a mailbox (folder) — mail_mailboxes only lists them. action:'create' (name, optional parent) makes a new folder; 'rename' (mailbox, name) renames one in place; 'delete' (mailbox) removes an EMPTY folder (JMAP refuses a non-empty one — move its mail out first with mail_move). `mailbox` accepts a role/display-name/raw id, same as mail_move. create/rename apply directly (reversible — rename back, or delete the new empty folder); delete stages a preview by default — commit_token or force:true to apply — and needs allow_destroy at the JMAP layer (handled internally).",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: ["create", "rename", "delete"] },
				mailbox: { type: "string", description: "Target mailbox for rename/delete — role (inbox/archive/junk/trash), display name, or raw id." },
				name: { type: "string", description: "create: the new folder's name. rename: its new name." },
				parent: { type: "string", description: "create: parent mailbox (role/name/id) to nest under — omit for a top-level folder." },
				stage: { type: "boolean", description: "delete: preview + commit_token, no write." },
				commit_token: { type: "string" },
				force: { type: "boolean", description: "delete: apply in one shot, skipping the default stage (the ! override)." },
			},
		},
		run: async (env, a) => {
			try {
				const action = String(a?.action ?? "");
				if (action === "create") {
					if (!a?.name) return failWith("bad_input", "mail_mailbox create requires a `name`.");
					let parentId: string | undefined;
					if (a?.parent) {
						const map = await mailboxMap(env);
						parentId = resolveMailboxId(map, String(a.parent));
					}
					const resp = await jmapCall(env, { calls: [["Mailbox/set", { create: { m: { name: String(a.name), ...(parentId ? { parentId } : {}) } } }, "s"]] });
					const setR = resultFor(resp, "Mailbox/set");
					const created = setR?.created?.m;
					if (!created) return fail(`Mailbox create failed: ${JSON.stringify(setR?.notCreated ?? {})}`);
					return ok({ created: { id: created.id, name: created.name ?? a.name, parentId: created.parentId ?? parentId ?? null } });
				}
				if (action === "rename") {
					if (!a?.mailbox) return failWith("bad_input", "mail_mailbox rename requires `mailbox`.");
					if (!a?.name) return failWith("bad_input", "mail_mailbox rename requires the new `name`.");
					const map = await mailboxMap(env);
					const id = resolveMailboxId(map, String(a.mailbox));
					if (!id) return failWith("not_found", `no mailbox matching '${a.mailbox}'.`);
					const resp = await jmapCall(env, { calls: [["Mailbox/set", { update: { [id]: { name: String(a.name) } } }, "s"]] });
					const setR = resultFor(resp, "Mailbox/set");
					if (!Object.prototype.hasOwnProperty.call(setR?.updated ?? {}, id)) return fail(`Mailbox rename failed: ${JSON.stringify(setR?.notUpdated ?? {})}`);
					return ok({ renamed: id, name: String(a.name) });
				}
				if (action === "delete") {
					if (!a?.mailbox) return failWith("bad_input", "mail_mailbox delete requires `mailbox`.");
					const map = await mailboxMap(env);
					const id = resolveMailboxId(map, String(a.mailbox));
					if (!id) return failWith("not_found", `no mailbox matching '${a.mailbox}'.`);
					const mutate = async () => {
						const resp = await jmapCall(env, { allow_destroy: true, calls: [["Mailbox/set", { destroy: [id] }, "s"]] });
						const setR = resultFor(resp, "Mailbox/set");
						if (!(setR?.destroyed ?? []).includes(id)) throw new Error(`Mailbox delete failed: ${JSON.stringify(setR?.notDestroyed ?? {})} (JMAP refuses a non-empty folder — move its mail out first with mail_move).`);
						return { deleted: id };
					};
					const out = await staged(env, "mail_mailbox_delete", gateArgs(a), { id }, { action: "delete mailbox", id }, mutate);
					return ok("stageResult" in out ? out.stageResult : out.result);
				}
				return failWith("bad_input", `mail_mailbox: unknown action '${action}'.`);
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
		description: "Save a draft (does NOT send). Returns the created message id. Provide to/subject/text for a fresh message; cc/bcc/from optional. To compose INTO an existing conversation set `mode` (reply/reply-all/forward) + `reply_to` (the email id) — threading headers, the Re:/Fwd: subject, recipients, and the quoted original are filled in for you (override any by passing it explicitly).",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: {
				to: { type: "array", items: { type: "string" }, description: "Recipient email addresses. Optional for reply/reply-all (derived from the original); required for a fresh message or a forward." },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string", description: "Optional when replying/forwarding — the Re:/Fwd: subject is derived from the original." },
				text: { type: "string", description: "Plain-text body. When replying/forwarding, the quoted original is appended below it." },
				from: { type: "string", description: "Sender address (defaults to your primary identity)." },
				attachments: ATTACHMENTS_SCHEMA,
				mode: { type: "string", enum: ["reply", "reply-all", "forward"], description: "Compose into an existing thread: reply (the sender), reply-all (sender + all recipients), or forward (needs `to`). Requires `reply_to`." },
				reply_to: { type: "string", description: "The email id being replied to or forwarded (from mail_search/mail_read). Required when `mode` is set." },
			},
		},
		run: async (env, a) => draftOrSend(env, a, false),
	},
	{
		name: "mail_send",
		description: "Send an email. Composes the draft, submits it, and files it in Sent. Provide to/subject/text for a fresh message; cc/bcc/from optional. Reply or forward into an existing thread with `mode` (reply/reply-all/forward) + `reply_to` (the email id) — threading headers, the Re:/Fwd: subject, recipients, and the quoted original are filled in. Dispatches immediately UNLESS you pass `send_at` (an ISO-8601 date-time), which SCHEDULES it via SMTP FUTURERELEASE — held until then, cancelable with mail_unschedule. STAGES A PREVIEW BY DEFAULT (nothing is sent) — re-call with the commit_token to send, or pass force:true to send in one shot. There's no undo once dispatched.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: {
				to: { type: "array", items: { type: "string" }, description: "Recipient email addresses. Optional for reply/reply-all (derived from the original); required for a fresh message or a forward." },
				cc: { type: "array", items: { type: "string" } },
				bcc: { type: "array", items: { type: "string" } },
				subject: { type: "string", description: "Optional when replying/forwarding — the Re:/Fwd: subject is derived from the original." },
				text: { type: "string", description: "Plain-text body. When replying/forwarding, the quoted original is appended below it." },
				from: { type: "string", description: "Sender address — exact identity or any address at an owned *@domain (send-as-any). Defaults to your primary identity." },
				mode: { type: "string", enum: ["reply", "reply-all", "forward"], description: "Compose into an existing thread: reply (the sender), reply-all (sender + all recipients), or forward (needs `to`). Requires `reply_to`." },
				reply_to: { type: "string", description: "The email id being replied to or forwarded (from mail_search/mail_read). Required when `mode` is set." },
				send_at: { type: "string", description: "Schedule the send for this ISO-8601 date-time (e.g. '2026-07-11T09:00:00Z'). Held via FUTURERELEASE; omit to send now." },
				stage: { type: "boolean", description: "Preview only: returns {preview, commit_token} and sends NOTHING. Re-call with the token to commit." },
				commit_token: { type: "string", description: "Commit a previously staged send (the payload must match what was staged)." },
				force: { type: "boolean", description: "Send in one shot, skipping the default stage (the ! override). Without it, mail_send stages a preview first." },
				attachments: ATTACHMENTS_SCHEMA,
			},
		},
		run: async (env, a) => draftOrSend(env, a, true),
	},
	{
		name: "mail_schedule",
		description: "Schedule an email for future delivery (SMTP FUTURERELEASE). Like mail_send but `sendAt` (ISO-8601) is required — the message is held until then, cancelable with mail_unschedule. Stages a preview by default; re-call with the commit_token to schedule, or pass force:true to schedule in one shot.",
		inputSchema: { type: "object", additionalProperties: false, required: ["to", "subject", "text", "sendAt"], properties: { to: { type: "array", items: { type: "string" } }, cc: { type: "array", items: { type: "string" } }, bcc: { type: "array", items: { type: "string" } }, subject: { type: "string" }, text: { type: "string" }, from: { type: "string", description: "Exact identity or any address at an owned *@domain." }, sendAt: { type: "string", description: "ISO-8601 date-time to release the message." }, attachments: ATTACHMENTS_SCHEMA, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => draftOrSend(env, { ...a, send_at: a?.sendAt }, true),
	},
	{
		name: "mail_scheduled",
		description: "List your pending scheduled (FUTURERELEASE-held) sends — each { id (submissionId), emailId, sendAt }. Cancel one with mail_unschedule.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: async (env) => {
			try {
				const resp = await jmapCall(env, { calls: [["EmailSubmission/query", { filter: { undoStatus: "pending" } }, "q"], ["EmailSubmission/get", { "#ids": { resultOf: "q", name: "EmailSubmission/query", path: "/ids" }, properties: ["id", "emailId", "sendAt", "undoStatus"] }, "g"]] });
				const subs = resultFor(resp, "EmailSubmission/get")?.list ?? [];
				return ok({ count: subs.length, scheduled: subs.map((s: any) => ({ id: s?.id, emailId: s?.emailId, sendAt: s?.sendAt })) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_unschedule",
		description: "Cancel a pending scheduled send by its submission id (undoStatus → canceled) before it releases. Idempotent: a submission that's already canceled or released reports success rather than erroring.",
		inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", description: "The submissionId from mail_send/mail_schedule or a mail_scheduled list." } } },
		run: async (env, a) => {
			if (!a?.id) return failWith("bad_input", "mail_unschedule requires the submission `id`.");
			try {
				const id = String(a.id);
				const resp = await jmapCall(env, { calls: [["EmailSubmission/set", { update: { [id]: { undoStatus: "canceled" } } }, "u"]] });
				const setR = resultFor(resp, "EmailSubmission/set");
				if (Object.prototype.hasOwnProperty.call(setR?.updated ?? {}, id)) return ok({ unscheduled: id });
				if (setR?.notUpdated?.[id]?.type === "notFound") return ok({ unscheduled: id, note: "already canceled or released." });
				return fail(`unschedule failed: ${JSON.stringify(setR?.notUpdated ?? {})}`);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_upload",
		description:
			"Upload bytes to Fastmail once and get back a reusable {blobId} — reference it in mail_send/mail_draft attachments (blobId path), avoiding re-upload. Give a `ref` (a sux /s/<uuid> CAS handle — the primary path; streams R2→JMAP) or `data` (base64, small only). Returns {blobId, type, size}.",
		inputSchema: { type: "object", additionalProperties: false, properties: { ref: { type: "string", description: "A sux /s/<uuid> CAS handle to stream up." }, data: { type: "string", description: "Base64 bytes (small files only)." }, type: { type: "string", description: "MIME type (default application/octet-stream)." }, name: { type: "string" } } },
		run: async (env, a) => {
			const src = a?.ref ?? a?.data;
			if (!src) return failWith("bad_input", "mail_upload needs `ref` (a sux /s/<uuid> handle) or `data` (base64).");
			try {
				const up = (await doUpload(env, String(src), String(a?.type ?? "application/octet-stream"))) as any;
				return ok({ blobId: up.blobId, type: up.type ?? a?.type ?? "application/octet-stream", size: up.size, ...(a?.name ? { name: a.name } : {}) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
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
		description: "Fastmail Masked Email — list, create (forDomain + description), or transition an address: disable (stop delivery, keep it), enable (re-activate), delete (soft-delete → recoverable in Fastmail). create applies directly (reversible); delete stages a preview by default — commit_token or force:true to apply it. A privacy superpower a normal mail tool can't reach.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: { type: "string", enum: ["list", "create", "disable", "enable", "delete"], default: "list" },
				id: { type: "string", description: "The masked-email id (disable/enable/delete)." },
				forDomain: { type: "string", description: "The site the masked address is for (create)." },
				description: { type: "string", description: "A note to remember what it's for (create)." },
				stage: { type: "boolean", description: "create/delete: preview + commit_token, no write." },
				commit_token: { type: "string" },
				force: { type: "boolean", description: "delete: apply in one shot, skipping the default stage (the ! override)." },
			},
		},
		run: async (env, a) => {
			try {
				const action = String(a?.action ?? "list");
				if (action === "create") {
					const mutate = async () => {
						const resp = await jmapCall(env, { calls: [["MaskedEmail/set", { create: { m: { state: "enabled", forDomain: a?.forDomain ? String(a.forDomain) : undefined, description: a?.description ? String(a.description) : undefined } } }, "s"]] });
						const created = resultFor(resp, "MaskedEmail/set")?.created?.m;
						if (!created) throw new Error(`MaskedEmail create failed: ${JSON.stringify(resultFor(resp, "MaskedEmail/set")?.notCreated ?? {})}`);
						return { created: { id: created.id, email: created.email, forDomain: created.forDomain, description: created.description } };
					};
					const out = await staged(env, "mail_masked_create", gateArgs(a), { forDomain: a?.forDomain ?? null, description: a?.description ?? null }, { action: "create masked address", forDomain: a?.forDomain, description: a?.description }, mutate);
					return ok("stageResult" in out ? out.stageResult : out.result);
				}
				if (action === "disable" || action === "enable" || action === "delete") {
					if (!a?.id) return failWith("bad_input", `mail_masked ${action} requires an \`id\`.`);
					const id = String(a.id);
					const state = action === "delete" ? "deleted" : action === "disable" ? "disabled" : "enabled";
					const mutate = async () => {
						const resp = await jmapCall(env, { calls: [["MaskedEmail/set", { update: { [id]: { state } } }, "s"]] });
						const setR = resultFor(resp, "MaskedEmail/set");
						if (!Object.prototype.hasOwnProperty.call(setR?.updated ?? {}, id)) throw new Error(`MaskedEmail ${action} failed: ${JSON.stringify(setR?.notUpdated ?? {})}`);
						return { id, state };
					};
					if (action === "delete") {
						const out = await staged(env, "mail_masked_delete", gateArgs(a), { id, state }, { action: "soft-delete masked address", id }, mutate);
						return ok("stageResult" in out ? out.stageResult : out.result);
					}
					return ok(await mutate());
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
		name: "mail_vacation",
		description:
			"Get or set the Fastmail vacation auto-responder. action:'get' (default) returns the current responder; action:'set' updates it (enabled + subject + text; optional fromDate/toDate ISO-8601). Stages a preview by default — commit_token or force:true to apply. Needs a FASTMAIL_TOKEN scoped for vacationresponse.",
		inputSchema: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["get", "set"] }, enabled: { type: "boolean" }, subject: { type: "string" }, text: { type: "string", description: "Plain-text auto-reply body." }, fromDate: { type: "string", description: "ISO-8601 start (optional)." }, toDate: { type: "string", description: "ISO-8601 end (optional)." }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => {
			const gate = await scopeGate(env, "vacationresponse");
			if (gate) return failWith("not_configured", gate);
			try {
				if ((a?.action ?? "get") === "get") {
					const resp = await jmapCall(env, { calls: [["VacationResponse/get", { ids: ["singleton"] }, "g"]] });
					return ok({ vacation: resultFor(resp, "VacationResponse/get")?.list?.[0] ?? null });
				}
				if (typeof a?.enabled !== "boolean" || !a?.subject || a?.text === undefined) return failWith("bad_input", "mail_vacation set needs enabled (bool), subject, and text.");
				const patch: Record<string, unknown> = { isEnabled: a.enabled, subject: String(a.subject), textBody: String(a.text), fromDate: a?.fromDate ?? null, toDate: a?.toDate ?? null };
				const mutate = async () => {
					const resp = await jmapCall(env, { allow_destroy: true, calls: [["VacationResponse/set", { update: { singleton: patch } }, "s"]] });
					const setR = resultFor(resp, "VacationResponse/set");
					if (!Object.prototype.hasOwnProperty.call(setR?.updated ?? {}, "singleton")) throw new Error(`vacation set failed: ${JSON.stringify(setR?.notUpdated ?? {})}`);
					return { vacation: patch, updated: true };
				};
				const out = await staged(env, "mail_vacation", gateArgs(a), patch, { action: "set vacation responder", ...patch }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_quota",
		description: "Report mailbox storage quota — used vs total bytes per quota resource. Read-only. Needs a FASTMAIL_TOKEN scoped for quota.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: async (env) => {
			const gate = await scopeGate(env, "quota");
			if (gate) return failWith("not_configured", gate);
			try {
				const resp = await jmapCall(env, { calls: [["Quota/get", {}, "g"]] });
				const list = resultFor(resp, "Quota/get")?.list ?? [];
				return ok({ count: list.length, quotas: list.map((q: any) => ({ id: q?.id, name: q?.name, used: q?.used, limit: q?.limit, scope: q?.scope, resourceType: q?.resourceType })) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "mail_push",
		description:
			"Subscribe/unsubscribe a JMAP PushSubscription so Fastmail notifies sux the moment new mail arrives, instead of waiting for the next mail_triage cron tick (up to 5min). action:'subscribe' (default) creates one (idempotent — a no-op if already subscribed) and returns verified:false until Fastmail's confirmation push lands (usually within seconds; check with action:'status'). action:'unsubscribe' tears it down. action:'status' reports the current subscription. The webhook itself only ever triggers a normal mail_triage cycle — same fail-closed MAIL_TRIAGE_ENABLED gate as the cron path, so an unexpected push can't do anything the cron tick couldn't already do. Needs FASTMAIL_TOKEN.",
		inputSchema: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["subscribe", "unsubscribe", "status"], default: "subscribe" } } },
		run: async (env, a) => {
			try {
				const action = String(a?.action ?? "subscribe");
				if (action === "status") {
					const existing = await pushState(env);
					return ok(existing ? { subscribed: true, id: existing.id, verified: existing.verified, createdAt: existing.createdAt, expires: existing.expires } : { subscribed: false });
				}
				if (action === "unsubscribe") {
					const existing = await pushState(env);
					if (!existing) return ok({ unsubscribed: true, note: "no active subscription." });
					const resp = await jmapCall(env, { allow_destroy: true, calls: [["PushSubscription/set", { destroy: [existing.id] }, "s"]] });
					const setR = resultFor(resp, "PushSubscription/set");
					await savePushState(env, null);
					return ok({ unsubscribed: true, destroyed: (setR?.destroyed ?? []).includes(existing.id) });
				}
				// subscribe
				const existing = await pushState(env);
				if (existing) return ok({ already: true, verified: existing.verified, id: existing.id, note: existing.verified ? undefined : "still awaiting Fastmail's confirmation push — check action:'status'." });
				const token = randomPushToken();
				const url = `${storeBase(env)}/push/jmap/${token}`;
				const resp = await jmapCall(env, { calls: [["PushSubscription/set", { create: { p: { deviceClientId: "sux-worker", url, types: ["Email"] } } }, "s"]] });
				const setR = resultFor(resp, "PushSubscription/set");
				const created = setR?.created?.p;
				if (!created) return fail(`PushSubscription create failed: ${JSON.stringify(setR?.notCreated ?? {})}`);
				await savePushState(env, { id: created.id, token, verified: false, createdAt: Date.now(), expires: created.expires ?? null });
				return ok({ subscribed: true, id: created.id, verified: false, note: "Awaiting Fastmail's verification push — check action:'status' shortly." });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "contact_search",
		description: "Search your Fastmail contacts by free text (name/email). Returns references {id, name, emails, phones} — never the full card. Needs a FASTMAIL_TOKEN scoped for contacts.",
		inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", description: "Free-text query over name/email." }, text: { type: "string", description: "Alias for `query` (kept for back-compat)." }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
		run: async (env, a) => {
			const gate = await scopeGate(env, "contacts");
			if (gate) return failWith("not_configured", gate);
			try {
				const limit = clamp(a?.limit, 1, 100, 25);
				// `contact`'s own dispatcher doc (and every real caller) uses `query`; the
				// schema only ever defined `text`, so `query` was silently dropped —
				// no filter, no error, just an unfiltered listing. Accept both.
				const q = a?.query ?? a?.text;
				const filter = q ? { text: String(q) } : {};
				const resp = await jmapCall(env, { calls: [["ContactCard/query", { filter, limit }, "q"], ["ContactCard/get", { "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "g"]] });
				const list = resultFor(resp, "ContactCard/get")?.list ?? [];
				return ok({ count: list.length, contacts: list.map(shapeContact) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "contact_get",
		description: "Read one contact card in full by id. Needs a FASTMAIL_TOKEN scoped for contacts.",
		inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
		run: async (env, a) => {
			const gate = await scopeGate(env, "contacts");
			if (gate) return failWith("not_configured", gate);
			if (!a?.id) return failWith("bad_input", "contact_get requires an `id`.");
			try {
				const resp = await jmapCall(env, { calls: [["ContactCard/get", { ids: [String(a.id)] }, "g"]] });
				const c = resultFor(resp, "ContactCard/get")?.list?.[0];
				if (!c) return failWith("not_found", `No contact '${a.id}'.`);
				return ok({ ...shapeContact(c), raw: c });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "contact_create",
		description: "Create a contact. Provide name (or firstName/lastName)/company + emails[]/phones[] (plain strings). Applies directly (reversible); pass stage:true to preview first. Needs a FASTMAIL_TOKEN scoped for contacts.",
		inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string", description: "Full name, split on the first space into firstName/lastName. Ignored if firstName/lastName are also given." }, firstName: { type: "string" }, lastName: { type: "string" }, company: { type: "string" }, emails: { type: "array", items: { type: "string" } }, phones: { type: "array", items: { type: "string" } }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => {
			const gate = await scopeGate(env, "contacts");
			if (gate) return failWith("not_configured", gate);
			try {
				const card = contactCard(a);
				if (!Object.keys(card).length) return failWith("bad_input", "contact_create needs at least one of name/firstName/lastName/company/emails/phones.");
				const mutate = async () => {
					const resp = await jmapCall(env, { calls: [["ContactCard/set", { create: { c: { "@type": "Card", version: "1.0", ...card } } }, "s"]] });
					const created = resultFor(resp, "ContactCard/set")?.created?.c;
					if (!created) throw new Error(`contact create failed: ${JSON.stringify(resultFor(resp, "ContactCard/set")?.notCreated ?? {})}`);
					return { created: { id: created.id, ...shapeContact({ ...card, id: created.id }) } };
				};
				const out = await staged(env, "contact_create", gateArgs(a), card, { action: "create contact", ...card }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "contact_update",
		description: "Update a contact by id — pass only the fields to change (name (or firstName/lastName)/company/emails[]/phones[]). Applies directly (reversible); pass stage:true to preview first. Needs a FASTMAIL_TOKEN scoped for contacts.",
		inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, name: { type: "string", description: "Full name, split on the first space into firstName/lastName. Ignored if firstName/lastName are also given." }, firstName: { type: "string" }, lastName: { type: "string" }, company: { type: "string" }, emails: { type: "array", items: { type: "string" } }, phones: { type: "array", items: { type: "string" } }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => {
			const gate = await scopeGate(env, "contacts");
			if (gate) return failWith("not_configured", gate);
			if (!a?.id) return failWith("bad_input", "contact_update requires an `id`.");
			try {
				const id = String(a.id);
				const patch = contactCard(a);
				if (!Object.keys(patch).length) return failWith("bad_input", "contact_update needs at least one field to change.");
				const mutate = async () => {
					const resp = await jmapCall(env, { calls: [["ContactCard/set", { update: { [id]: patch } }, "s"]] });
					const setR = resultFor(resp, "ContactCard/set");
					if (!Object.prototype.hasOwnProperty.call(setR?.updated ?? {}, id)) throw new Error(`contact update failed: ${JSON.stringify(setR?.notUpdated ?? {})}`);
					return { updated: id, patch };
				};
				const out = await staged(env, "contact_update", gateArgs(a), { id, patch }, { action: "update contact", id, ...patch }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "contact_delete",
		description: "Delete a contact by id (permanent). Stages a preview by default — commit_token or force:true to apply — and needs allow_destroy at the JMAP layer. Needs a FASTMAIL_TOKEN scoped for contacts.",
		inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => {
			const gate = await scopeGate(env, "contacts");
			if (gate) return failWith("not_configured", gate);
			if (!a?.id) return failWith("bad_input", "contact_delete requires an `id`.");
			try {
				const id = String(a.id);
				const mutate = async () => {
					const resp = await jmapCall(env, { allow_destroy: true, calls: [["ContactCard/set", { destroy: [id] }, "s"]] });
					const setR = resultFor(resp, "ContactCard/set");
					if (!(setR?.destroyed ?? []).includes(id)) throw new Error(`contact delete failed: ${JSON.stringify(setR?.notDestroyed ?? {})}`);
					return { deleted: id };
				};
				const out = await staged(env, "contact_delete", gateArgs(a), { id }, { action: "delete contact (permanent)", id }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "cal_list",
		description: "List your Fastmail calendars (and task lists) — {href, name, isTasks}. Use the href with cal_events/cal_create. Needs FASTMAIL_CALDAV_USER + FASTMAIL_APP_PASSWORD (CalDAV).",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: async (env) => {
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			try {
				const cals = await listCalendars(env);
				return ok({ count: cals.length, calendars: cals.map((c) => ({ href: c.href, name: c.name, isTasks: c.isTasks, ...(c.description ? { description: c.description } : {}) })) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "cal_events",
		description: "List events in a calendar (references: {uid, summary, start, end, all_day, tz, href, etag}). Pass `calendar` (an href from cal_list) or omit to use your first calendar. The window defaults to now..+90 days — override with `start`/`end` (ISO-8601) to look further out or back. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, properties: { calendar: { type: "string", description: "Calendar href from cal_list (defaults to your first calendar)." }, start: { type: "string", description: "Window start (ISO-8601); default now." }, end: { type: "string", description: "Window end (ISO-8601); default +90 days." }, from: { type: "string", description: "Alias for `start` (kept for back-compat)." }, to: { type: "string", description: "Alias for `end` (kept for back-compat)." } } },
		run: async (env, a) => {
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			try {
				const cal = await pickCalendar(env, false, a?.calendar ? String(a.calendar) : undefined);
				// `calendar`'s own dispatcher doc used to say from/to (this schema only ever
				// had start/end) — from/to silently vanished and every call fell back to the
				// default 90-day window with no error. Accept both.
				const s = a?.start ?? a?.from;
				const e2 = a?.end ?? a?.to;
				const window = s || e2 ? { start: s ? String(s) : undefined, end: e2 ? String(e2) : undefined } : undefined;
				const objs = await reportObjects(env, cal.href, "VEVENT", window);
				return ok({ calendar: cal.href, count: objs.length, events: objs.map(shapeCalObject).filter(Boolean) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "cal_create",
		description: "Create a calendar event. Provide summary + start (ISO-8601; a date-only value is all-day), optional end/description/location and `calendar` (href). Applies directly (reversible); pass stage:true to preview first. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["summary", "start"], properties: { calendar: { type: "string" }, summary: { type: "string" }, title: { type: "string", description: "Alias for `summary` (kept for back-compat)." }, start: { type: "string", description: "ISO-8601 start; date-only (YYYY-MM-DD) = all-day." }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, rawA) => {
			// `calendar`'s own dispatcher doc used to say `title` (this schema only ever had
			// `summary`) — `title` would fail loud (bad_input), which is safer than the other
			// namespace-doc mismatches but still worth accepting the natural alias.
			const a = rawA?.title !== undefined && rawA?.summary === undefined ? { ...rawA, summary: rawA.title } : rawA;
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			if (!a?.summary || !a?.start) return failWith("bad_input", "cal_create needs summary and start.");
			try {
				const cal = await pickCalendar(env, false, a?.calendar ? String(a.calendar) : undefined);
				const payload = { calendar: cal.href, summary: String(a.summary), start: String(a.start), end: a?.end ?? null, description: a?.description ?? null, location: a?.location ?? null };
				const mutate = async () => {
					const uid = crypto.randomUUID();
					const ical = buildVEvent({ uid, summary: String(a.summary), start: String(a.start), end: a?.end ? String(a.end) : undefined, description: a?.description ? String(a.description) : undefined, location: a?.location ? String(a.location) : undefined, dtstamp: new Date().toISOString() });
					const href = `${cal.href}${uid}.ics`;
					const r = await caldavFetch(env, "PUT", href, { body: ical, contentType: "text/calendar; charset=utf-8", ifNoneMatch: "*" });
					if (!r.ok) throw new Error(`event create failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
					return { created: true, uid, href, etag: r.etag };
				};
				const out = await staged(env, "cal_create", gateArgs(a), payload, { action: "create event", ...payload }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "cal_update",
		description: "Update a calendar event by its href (from cal_events) — pass only the fields to change (summary/start/end/description/location). The existing VEVENT is fetched and rewritten in place, so its UID, alarms, and any timezone/all-day encoding survive. Pass etag to guard against a concurrent edit. Applies directly (reversible); pass stage:true to preview first. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["href"], properties: { href: { type: "string", description: "Event href from cal_events." }, summary: { type: "string" }, start: { type: "string", description: "ISO-8601 start; date-only (YYYY-MM-DD) = all-day." }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, etag: { type: "string", description: "If set, update only if the object still matches (If-Match)." }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => calPatch(env, a, "VEVENT"),
	},
	{
		name: "task_update",
		description: "Update a task (VTODO) by its href (from task_list) — pass only the fields to change (summary/due/description/status). The existing VTODO is fetched and rewritten in place (UID + other properties preserved). To mark a task done prefer task_complete. Applies directly (reversible); pass stage:true to preview first. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["href"], properties: { href: { type: "string", description: "Task href from task_list." }, summary: { type: "string" }, due: { type: "string", description: "ISO-8601 due; date-only = all-day." }, description: { type: "string" }, status: { type: "string", enum: ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"], description: "VTODO status." }, etag: { type: "string" }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => calPatch(env, a, "VTODO"),
	},
	{
		name: "task_complete",
		description: "Mark a task (VTODO) complete by its href (from task_list) — sets STATUS:COMPLETED, a COMPLETED timestamp, and PERCENT-COMPLETE:100, preserving the rest of the task. Pass etag to guard a concurrent edit. Applies directly (reversible); pass stage:true to preview first. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["href"], properties: { href: { type: "string", description: "Task href from task_list." }, etag: { type: "string" }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => calPatch(env, { ...a, status: "COMPLETED", _complete: true }, "VTODO"),
	},
	{
		name: "cal_delete",
		description: "Delete a calendar event or task by its href (from cal_events/task_list). Pass etag to guard against a concurrent edit. Stages a preview by default — commit_token or force:true to apply. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["href"], properties: { href: { type: "string", description: "Object href from cal_events/task_list." }, etag: { type: "string", description: "If set, delete only if the object still matches (If-Match)." }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => {
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			if (!a?.href) return failWith("bad_input", "cal_delete requires the object `href`.");
			try {
				const href = String(a.href);
				const mutate = async () => {
					const r = await caldavFetch(env, "DELETE", href, a?.etag ? { ifMatch: String(a.etag) } : {});
					if (!r.ok && r.status !== 404) throw new Error(`delete failed: HTTP ${r.status}`);
					return { deleted: href, ...(r.status === 404 ? { note: "already gone" } : {}) };
				};
				const out = await staged(env, "cal_delete", gateArgs(a), { href, etag: a?.etag ?? null }, { action: "delete calendar object", href }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "task_list",
		description: "List tasks (VTODO) in a task list — {uid, summary, due, status, href, etag}. Pass `calendar` (a task-list href from cal_list) or omit for your first task list. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, properties: { calendar: { type: "string" } } },
		run: async (env, a) => {
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			try {
				const cal = await pickCalendar(env, true, a?.calendar ? String(a.calendar) : undefined);
				const objs = await reportObjects(env, cal.href, "VTODO");
				return ok({ calendar: cal.href, count: objs.length, tasks: objs.map(shapeCalObject).filter(Boolean) });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "task_create",
		description: "Create a task (VTODO). Provide summary, optional due (ISO-8601)/description and `calendar` (task-list href). Applies directly (reversible); pass stage:true to preview first. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { calendar: { type: "string" }, summary: { type: "string" }, due: { type: "string" }, description: { type: "string" }, stage: { type: "boolean" }, commit_token: { type: "string" }, force: { type: "boolean", description: "Skip staging and apply in one shot (the ! override). By default this verb stages a preview first." } } },
		run: async (env, a) => {
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			if (!a?.summary) return failWith("bad_input", "task_create needs a summary.");
			try {
				const cal = await pickCalendar(env, true, a?.calendar ? String(a.calendar) : undefined);
				const payload = { calendar: cal.href, summary: String(a.summary), due: a?.due ?? null, description: a?.description ?? null };
				const mutate = async () => {
					const uid = crypto.randomUUID();
					const ical = buildVTodo({ uid, summary: String(a.summary), due: a?.due ? String(a.due) : undefined, description: a?.description ? String(a.description) : undefined, dtstamp: new Date().toISOString() });
					const href = `${cal.href}${uid}.ics`;
					const r = await caldavFetch(env, "PUT", href, { body: ical, contentType: "text/calendar; charset=utf-8", ifNoneMatch: "*" });
					if (!r.ok) throw new Error(`task create failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
					return { created: true, uid, href, etag: r.etag };
				};
				const out = await staged(env, "task_create", gateArgs(a), payload, { action: "create task", ...payload }, mutate);
				return ok("stageResult" in out ? out.stageResult : out.result);
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "caldav",
		description: "Raw CalDAV escape hatch — issue a PROPFIND/REPORT/GET/PUT/DELETE against Fastmail CalDAV with Basic auth injected. {method, path (from host or full URL), body, depth, contentType}. Returns {status, text, etag}. Needs CalDAV credentials.",
		inputSchema: { type: "object", additionalProperties: false, required: ["method", "path"], properties: { method: { type: "string" }, path: { type: "string", description: "Absolute-from-host path (e.g. the calendar-home) or full URL." }, body: { type: "string" }, depth: { type: "string", enum: ["0", "1", "infinity"] }, contentType: { type: "string" }, home: { type: "boolean", description: "Ignore path and target your calendar-home collection." } } },
		run: async (env, a) => {
			if (!hasCalDav(env)) return failWith("not_configured", CALDAV_NOT_CONFIGURED);
			if (!a?.method || (!a?.path && a?.home !== true)) return failWith("bad_input", "caldav needs method and path (or home:true).");
			try {
				const path = a?.home === true ? calendarHome(env) : String(a.path);
				const r = await caldavFetch(env, String(a.method).toUpperCase(), path, { body: a?.body ? String(a.body) : undefined, contentType: a?.contentType ? String(a.contentType) : "application/xml; charset=utf-8", depth: a?.depth ? String(a.depth) : undefined });
				return ok({ status: r.status, ok: r.ok, etag: r.etag, text: r.text });
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

/** Shared draft/send: resolve identity + drafts/sent mailboxes, apply reply/forward
 * threading, build the batch, dispatch. */
async function draftOrSend(env: RtEnv, a: any, send: boolean): Promise<ToolResult> {
	const mode = a?.mode ? String(a.mode) : "";
	if (mode && !["reply", "reply-all", "forward"].includes(mode)) return failWith("bad_input", "mode must be reply, reply-all, or forward.");
	let subject = a?.subject !== undefined ? String(a.subject) : undefined;
	let to: string[] = Array.isArray(a?.to) ? a.to.map(String) : a?.to ? [String(a.to)] : [];
	const cc: string[] = Array.isArray(a?.cc) ? a.cc.map(String) : [];
	const bcc: string[] = Array.isArray(a?.bcc) ? a.bcc.map(String) : [];
	let bodyText = a?.text !== undefined ? String(a.text) : "";
	const threadHeaders: Record<string, unknown> = {};
	try {
		// Reply/forward: pull the source message so subject, recipients, threading
		// headers, and the quoted original are derived rather than hand-passed.
		let src: any = null;
		if (mode) {
			const srcId = a?.reply_to ? String(a.reply_to) : "";
			if (!srcId) return failWith("bad_input", `mode=${mode} requires \`reply_to\` — the email id to ${mode === "forward" ? "forward" : "reply to"}.`);
			const r = await jmapCall(env, {
				method: "Email/get",
				args: { ids: [srcId], properties: ["messageId", "inReplyTo", "references", "subject", "from", "to", "cc", "replyTo", "receivedAt", "textBody", "htmlBody", "bodyValues"], fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 200_000 },
			});
			src = resultFor(r, "Email/get")?.list?.[0];
			if (!src) return failWith("not_found", `no message '${srcId}' to ${mode}.`);
			if (subject === undefined) subject = tagSubject(String(src.subject ?? ""), mode === "forward" ? "Fwd:" : "Re:");
			bodyText = quoteBody(mode, bodyText, src);
			if (mode !== "forward") {
				// RFC 5322 threading: In-Reply-To = the original's Message-ID; References =
				// its chain + that Message-ID (JMAP's convenience props, ids without <>).
				const srcMsgIds = Array.isArray(src.messageId) ? src.messageId.filter(Boolean) : [];
				if (srcMsgIds.length) threadHeaders.inReplyTo = srcMsgIds;
				const refs = [...(Array.isArray(src.references) ? src.references : []), ...srcMsgIds].filter(Boolean);
				if (refs.length) threadHeaders.references = refs;
				// Recipients default to the original's reply target (Reply-To, else From).
				if (!to.length) to = emailsOf(src.replyTo).length ? emailsOf(src.replyTo) : emailsOf(src.from);
			}
		}

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
			// An explicit `from` that matches no identity must FAIL — never silently send from a
			// different address than the caller asked for. Matches exact OR a *@domain wildcard (§1a).
			identity = resolveIdentity(identities, fromWanted);
			if (!identity) return failWith("bad_input", `no sending identity for from address '${fromWanted}' (no exact or *@domain-wildcard match) — check mail_identities.`);
		} else {
			identity = identities[0];
		}
		if (!identity) return fail("no sending identity found.");

		if (mode === "reply-all" && src) {
			// Everyone on the original (To + Cc) except ourself and the primary To → Cc.
			const seen = new Set([String(identity.email).toLowerCase(), ...to.map((x) => x.toLowerCase()), ...cc.map((x) => x.toLowerCase())]);
			for (const e of [...emailsOf(src.to), ...emailsOf(src.cc)]) {
				const k = e.toLowerCase();
				if (!seen.has(k)) {
					cc.push(e);
					seen.add(k);
				}
			}
		}

		if (!to.length) return failWith("bad_input", mode ? `mode=${mode} resolved no recipient — pass \`to\`.` : "provide to[] (recipients).");
		if (subject === undefined) return failWith("bad_input", "provide a subject.");
		const addrs = (xs: string[]) => xs.map((e) => ({ email: String(e) }));

		const draft: Record<string, unknown> = {
			mailboxIds: { [draftsId]: true },
			keywords: { $draft: true },
			from: [{ email: identity.email, name: identity.name }],
			to: addrs(to),
			...(cc.length ? { cc: addrs(cc) } : {}),
			...(bcc.length ? { bcc: addrs(bcc) } : {}),
			subject: String(subject),
			...threadHeaders,
			bodyStructure: { type: "text/plain", partId: "b" },
			bodyValues: { b: { value: bodyText } },
		};

		const atts: AttachmentSpec[] = Array.isArray(a?.attachments) ? a.attachments : [];

		if (!send) {
			// Drafting IS the action — resolve (stream-upload) attachments inline, no stage gate.
			if (atts.length) {
				const parts: ResolvedPart[] = [];
				for (const x of atts) parts.push(await resolveAttachment(env, x));
				Object.assign(draft, multipartBody(bodyText, parts));
			}
			const resp = await jmapCall(env, { calls: [["Email/set", { create: { draft } }, "c"]] });
			const created = resultFor(resp, "Email/set")?.created?.draft;
			if (!created) return fail(`draft failed: ${JSON.stringify(resultFor(resp, "Email/set")?.notCreated ?? {})}`);
			return ok({ drafted: true, id: created.id, ...(atts.length ? { attachments: atts.length } : {}) });
		}

		// Scheduled send: hold via the SMTP FUTURERELEASE extension (RFC 4865) — a HOLDFOR (seconds)
		// parameter on the submission envelope's mailFrom. Fastmail holds the message (undoStatus
		// 'pending') and releases it at send_at; cancel via mail_unschedule. A held submission needs
		// an explicit rcptTo envelope (it overrides the auto-derived recipients).
		let holdFor = 0;
		if (a?.send_at !== undefined && a?.send_at !== null && a?.send_at !== "") {
			const at = Date.parse(String(a.send_at));
			if (!Number.isFinite(at)) return failWith("bad_input", "send_at must be an ISO-8601 date-time, e.g. '2026-07-11T09:00:00Z'.");
			holdFor = Math.ceil((at - Date.now()) / 1000);
			if (holdFor <= 0) return failWith("bad_input", "send_at must be in the future.");
		}

		// The mutation (draft create + submit) runs behind stage-then-commit: stage:true previews
		// with NO Fastmail write; a commit_token commits the identical payload. The reads above
		// (Identity/Mailbox get) are safe during a stage — only this closure writes.
		const doSend = async () => {
			// Resolve (stream-upload) attachments HERE, at commit — never during a stage preview.
			const sendDraft: Record<string, unknown> = { ...draft };
			if (atts.length) {
				const parts: ResolvedPart[] = [];
				for (const x of atts) parts.push(await resolveAttachment(env, x));
				Object.assign(sendDraft, multipartBody(bodyText, parts));
			}
			const onSuccess: Record<string, unknown> = { "keywords/$draft": null };
			if (draftsId) onSuccess[`mailboxIds/${draftsId}`] = null;
			if (sentId) onSuccess[`mailboxIds/${sentId}`] = true;
			const subCreate: Record<string, unknown> = { emailId: "#draft", identityId: identity.id };
			if (holdFor > 0) {
				subCreate.envelope = {
					mailFrom: { email: identity.email, parameters: { HOLDFOR: String(holdFor) } },
					rcptTo: [...to, ...(Array.isArray(a?.cc) ? a.cc : []), ...(Array.isArray(a?.bcc) ? a.bcc : [])].map((e) => ({ email: String(e) })),
				};
			}
			const resp = await jmapCall(env, { allow_send: true, calls: [["Email/set", { create: { draft: sendDraft } }, "c"], ["EmailSubmission/set", { create: { sub: subCreate }, onSuccessUpdateEmail: { "#sub": onSuccess } }, "s"]] });
			const submitted = resultFor(resp, "EmailSubmission/set")?.created?.sub;
			if (!submitted) throw new Error(`send failed: ${JSON.stringify(resultFor(resp, "EmailSubmission/set")?.notCreated ?? {})}`);
			const base = { submissionId: submitted.id, to, ...(atts.length ? { attachments: atts.length } : {}) };
			return holdFor > 0 ? { scheduled: true, send_at: String(a.send_at), ...base, note: "held via FUTURERELEASE — cancel with mail_unschedule." } : { sent: true, ...base };
		};
		const attDesc = attachDescriptors(atts);
		const payload = { from: identity.email, to, cc: a?.cc ?? null, bcc: a?.bcc ?? null, subject: String(subject), text: bodyText, send_at: a?.send_at ?? null, attachments: attDesc };
		const preview = { action: holdFor > 0 ? "scheduled_send" : "send", from: identity.email, to, ...(a?.cc ? { cc: a.cc } : {}), ...(a?.bcc ? { bcc: a.bcc } : {}), subject: String(subject), body_chars: bodyText.length, ...(attDesc.length ? { attachments: attDesc } : {}), ...(holdFor > 0 ? { send_at: String(a.send_at) } : {}) };
		const out = await staged(env, "mail_send", gateArgs(a), payload, preview, doSend);
		return ok("stageResult" in out ? out.stageResult : out.result);
	} catch (e) {
		return fail(errMsg(e));
	}
}

/** Move messages into a target mailbox — REPLACES the mailbox set (a real move, not an add). */
export async function moveMessages(env: RtEnv, ids: unknown, target: string): Promise<ToolResult> {
	const list = Array.isArray(ids) ? ids.map(String) : [];
	if (!list.length || !target) return failWith("bad_input", "mail_move requires a non-empty `ids` array and a `mailbox` (role like inbox/archive/junk/trash, a display name, or a raw id) — not `mailboxId` or `to`.");
	try {
		const map = await mailboxMap(env);
		const targetId = resolveMailboxId(map, target);
		if (!targetId) return failWith("bad_input", `unknown mailbox '${target}'.`);
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

/** JMAP keyword grammar (RFC 5788 / JMAP §4.1.1): a keyword excludes control chars, space,
 *  and `( ) { ] % * " \`. Sanitize a human label to a safe custom-keyword atom (lowercased). */
function keywordFor(label: string): string {
	return String(label).toLowerCase().replace(/[\s()%*"\\{}\]]+/g, "_").replace(/^_+|_+$/g, "") || "triage";
}

/** Add or remove a keyword ("label") on messages via an ADDITIVE/subtractive keyword patch —
 *  NOT a move. The message stays exactly where it is; only the flag toggles. Fully reversible
 *  (label-remove is the inverse), non-hiding, and never destructive — the reversible-only
 *  triage bot uses this instead of a junk-MOVE. */
export async function labelMessages(env: RtEnv, ids: unknown, label: string, add: boolean): Promise<ToolResult> {
	const list = Array.isArray(ids) ? ids.map(String) : [];
	const keyword = keywordFor(label);
	if (!list.length || !label) return failWith("bad_input", "requires a non-empty `ids` array and a `label`.");
	try {
		const update: Record<string, unknown> = {};
		for (const id of list) update[id] = { [`keywords/${keyword}`]: add ? true : null };
		const resp = await jmapCall(env, { calls: [["Email/set", { update }, "u"]] });
		const setResult = resultFor(resp, "Email/set");
		const changed = Object.keys(setResult?.updated ?? {});
		const notUpdated = setResult?.notUpdated ?? {};
		const failed = Object.keys(notUpdated);
		if (!changed.length && failed.length) return fail(`${add ? "add" : "remove"} label '${keyword}' failed: ${JSON.stringify(notUpdated).slice(0, 300)}`);
		return ok({ labeled: changed.length, keyword, add, ...(failed.length ? { failed: failed.length, errors: notUpdated } : {}) });
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
