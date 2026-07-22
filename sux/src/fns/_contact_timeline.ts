import { hasAI } from "../ai";
import { failWith, ok, type RtEnv, type ToolResult } from "../registry";
import { hasCalDav, listCalendars, parseICal, reportObjects } from "./_caldav";
import { hasDropboxFull, searchFull } from "./_dropbox-full";
import { embedOne } from "./_embed";
import { jmap } from "./jmap";
import { vaultCfg } from "./obsidian";
import { topKByCosine, vaultSemanticIndex } from "./_vault_semantic";
import { errMsg, oj } from "./_util";

// contact `timeline` — v5 W8 (sux#1288): assemble a person's cross-source history AT QUERY
// TIME by fanning out over the stores that already exist (mail by sender, calendar events,
// vault mentions, files), merging and sorting chronologically, every item cited. This is
// Design 1's zero-store verb: a pure read → assemble → return, the same posture recall.ts
// takes — it NEVER writes a materialized People/<name>.md note or persists the timeline (that
// is Design 2's proposals-kernel path, deferred to Colin per the arc doc's OPEN #4). No new
// store, no graph engine, no KV write of its own. Each source degrades independently: an
// unconfigured or failing one is skipped and reported in `sources`, never fatal — a person
// with no reachable interactions returns an empty timeline, not an error.
//
// Safety mirrors recall: only ephemeral, read-only queries are issued (JMAP query/get, CalDAV
// REPORT, the vault_semantic cosine index, Dropbox search) — never a */set mutation.

const MAIL_LIMIT = 25; // recent messages to/from the person to pull
const CAL_LIMIT = 25; // matched events to keep across all calendars
const VAULT_TOPK = 8; // semantic candidates before the mention-precision gate
const FILES_LIMIT = 15; // Dropbox search matches to keep
const CAL_PAST_DAYS = 365; // calendar window: how far back to look
const CAL_FUTURE_DAYS = 180; // …and forward (upcoming shared events)
const MAX_ITEMS = 100; // total assembled items cap (keeps the newest when exceeded)
const SOURCE_TIMEOUT_MS = 8_000; // per-leg deadline so one slow store never sinks the whole assembly

export type TimelineSource = "mail" | "calendar" | "vault" | "files";
export type TimelineItem = {
	/** ISO date/date-time when the interaction happened, or null when a source can't date it (e.g. an undated note). */
	date: string | null;
	source: TimelineSource;
	title: string;
	snippet?: string;
	/** mail only: whether the person was the sender ("received") or a recipient ("sent"). */
	direction?: "sent" | "received";
	/** A pointer back to the underlying item — JMAP id, calendar ref, vault path, or file path. */
	citation: string;
};
export type ResolvedPerson = { query: string; name: string; emails: string[]; resolved: boolean; contact_id?: string };

const pj = (s: string): any => {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
};

/** Find the `list` of a JMAP method response by name (per-call errors → null, never throws). */
function methodList(r: ToolResult, method: string): any[] | null {
	if (r.isError) return null;
	const mr = ((pj(r.content?.[0]?.text ?? "")?.methodResponses ?? []) as any[]).find((m) => m[0] === method);
	return (mr?.[1]?.list as any[]) ?? null;
}

function cardEmails(c: any): string[] {
	return c?.emails ? Object.values(c.emails).map((e: any) => e?.address).filter(Boolean).map(String) : [];
}
function cardName(c: any, emails: string[]): string {
	const company = c?.organizations ? (Object.values(c.organizations)[0] as any)?.name : undefined;
	return c?.name?.full || company || emails[0] || "";
}

/** Resolve {name|id|email} to a person: best-effort ContactCard lookup to enrich the display
 *  name and gather every known email, so the mail leg can query by ALL of the person's
 *  addresses. Contacts being unconfigured/unreachable is not fatal — we fall back to whatever
 *  the caller supplied (a bare name still drives the vault/calendar/files legs; a bare email
 *  still drives the mail leg). */
async function resolvePerson(env: RtEnv, name: string, id: string, email: string): Promise<ResolvedPerson> {
	const query = name || email || id;
	const emails = new Set<string>();
	let displayName = name;
	let contact_id: string | undefined;
	let resolved = false;

	try {
		let card: any = null;
		if (id) {
			card = methodList(await jmap.run(env, { calls: [["ContactCard/get", { ids: [id] }, "g"]] }), "ContactCard/get")?.[0] ?? null;
		} else {
			const r = await jmap.run(env, {
				calls: [
					["ContactCard/query", { filter: { text: name || email }, limit: 1 }, "q"],
					["ContactCard/get", { "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "g"],
				],
			});
			card = methodList(r, "ContactCard/get")?.[0] ?? null;
		}
		if (card) {
			resolved = true;
			if (card?.id) contact_id = String(card.id);
			for (const e of cardEmails(card)) emails.add(e.toLowerCase());
			const nm = cardName(card, [...emails]);
			if (nm) displayName = nm;
		}
	} catch {
		/* contacts unconfigured/unreachable — proceed with the caller-supplied name/email */
	}

	if (email) emails.add(email.toLowerCase());
	if (!displayName) displayName = email || query;
	return { query, name: displayName, emails: [...emails], resolved, ...(contact_id ? { contact_id } : {}) };
}

/** The lowercase needles (emails + the full name, if ≥3 chars) used to match a person against
 *  free-text stores (calendar ical). Emails are precise; the name is a best-effort fallback. */
function personNeedles(p: ResolvedPerson): string[] {
	const out = new Set<string>();
	for (const e of p.emails) if (e) out.add(e.toLowerCase());
	const n = p.name.trim().toLowerCase();
	if (n.length >= 3) out.add(n);
	return [...out];
}

/** Mail: the person's messages, by sender/recipient. When we know their address(es) we query
 *  JMAP by from/to (both directions of the conversation); with only an unresolved name we fall
 *  back to a text match so the person still surfaces. Newest-first from JMAP; the merge re-sorts. */
async function fromMail(env: RtEnv, p: ResolvedPerson): Promise<TimelineItem[]> {
	let filter: any;
	if (p.emails.length) {
		const conditions = p.emails.flatMap((e) => [{ from: e }, { to: e }]);
		filter = conditions.length === 1 ? conditions[0] : { operator: "OR", conditions };
	} else if (p.name) {
		filter = { text: p.name };
	} else {
		return [];
	}
	const r = await jmap.run(env, {
		calls: [
			["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: false }], limit: MAIL_LIMIT }, "q"],
			["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "subject", "from", "to", "receivedAt", "preview"] }, "g"],
		],
	});
	if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail query failed");
	const list = methodList(r, "Email/get") ?? [];
	const personEmails = new Set(p.emails.map((e) => e.toLowerCase()));
	const items: TimelineItem[] = [];
	for (const e of list) {
		const subject = e?.subject || "(no subject)";
		const fromAddrs = (e?.from ?? []).map((a: any) => String(a?.email ?? "").toLowerCase()).filter(Boolean);
		const direction: TimelineItem["direction"] | undefined = personEmails.size ? (fromAddrs.some((a: string) => personEmails.has(a)) ? "received" : "sent") : undefined;
		items.push({
			date: e?.receivedAt ? String(e.receivedAt) : null,
			source: "mail",
			title: subject,
			...(e?.preview ? { snippet: String(e.preview).slice(0, 200) } : {}),
			...(direction ? { direction } : {}),
			citation: `mail:${e?.id ?? subject}`,
		});
	}
	return items;
}

/** Calendar (CalDAV): events in a recent-past..near-future window whose ical mentions the person
 *  (an ATTENDEE/ORGANIZER address, or their name in the summary/description). No server-side
 *  full-text search exists, so we pull per-calendar and match client-side. Cited by event href. */
async function fromCalendar(env: RtEnv, p: ResolvedPerson): Promise<TimelineItem[]> {
	if (!hasCalDav(env)) return [];
	const needles = personNeedles(p);
	if (!needles.length) return [];
	const now = Date.now();
	const window = { start: new Date(now - CAL_PAST_DAYS * 864e5).toISOString(), end: new Date(now + CAL_FUTURE_DAYS * 864e5).toISOString() };
	const cals = (await listCalendars(env)).filter((c) => !c.isTasks);
	const items: TimelineItem[] = [];
	for (const cal of cals) {
		if (items.length >= CAL_LIMIT) break;
		let objs: Array<{ href: string; etag: string | null; ical: string }>;
		try {
			objs = await reportObjects(env, cal.href, "VEVENT", window);
		} catch {
			continue; // one unreadable calendar shouldn't sink the whole source
		}
		for (const o of objs) {
			if (items.length >= CAL_LIMIT) break;
			const hay = o.ical.toLowerCase();
			if (!needles.some((n) => hay.includes(n))) continue;
			const comp = parseICal(o.ical)[0];
			if (!comp) continue;
			const summary = comp.props.SUMMARY ?? "(no title)";
			const location = comp.props.LOCATION;
			const description = comp.props.DESCRIPTION;
			items.push({
				date: comp.start ?? null,
				source: "calendar",
				title: summary,
				...(location ? { snippet: `@ ${location}` } : description ? { snippet: String(description).slice(0, 200) } : {}),
				citation: `calendar:${o.href || summary}`,
			});
		}
	}
	return items;
}

/** Extract a YYYY-MM-DD from a vault path (Daily/2026-05-15.md and other dated notes); null otherwise. */
function dateFromVaultPath(path: string): string | null {
	const m = path.match(/(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Vault: notes that mention the person, via the vault_semantic cosine index (same read path
 *  recall uses — the git backend can't full-text a private repo). A short name makes a bare
 *  cosine ranking noisy, so semantic candidates are kept only when the note text actually
 *  contains the name or an email. Dated by the note's path when it carries one, else undated. */
async function fromVault(env: RtEnv, p: ResolvedPerson): Promise<TimelineItem[]> {
	if (!hasAI(env)) return [];
	const cfg = vaultCfg(env);
	if ("error" in cfg) return [];
	const idx = await vaultSemanticIndex(env, cfg);
	if (!idx) return [];
	const q = [p.name, ...p.emails].filter(Boolean).join(" ").trim();
	if (!q) return [];
	const vec = await embedOne(env, q);
	const hits = topKByCosine(vec, idx.chunks, VAULT_TOPK);
	const nameLc = p.name.trim().toLowerCase();
	const emailsLc = p.emails.map((e) => e.toLowerCase());
	const items: TimelineItem[] = [];
	const seen = new Set<string>();
	for (const h of hits) {
		const body = h.text.toLowerCase();
		const mentions = (nameLc.length >= 3 && body.includes(nameLc)) || emailsLc.some((e) => e && body.includes(e));
		if (!mentions || seen.has(h.path)) continue;
		seen.add(h.path);
		items.push({
			date: dateFromVaultPath(h.path),
			source: "vault",
			title: h.title || h.path,
			snippet: h.text.slice(0, 200),
			citation: `vault:${h.path}`,
		});
	}
	return items;
}

/** Files: Dropbox (Mode B) content search for the person, dated by each file's server-modified
 *  time. Keyword search only — the token-cheap file reference, never the bytes. Cited by path. */
async function fromFiles(env: RtEnv, p: ResolvedPerson): Promise<TimelineItem[]> {
	if (!hasDropboxFull(env)) return [];
	const q = p.name || p.emails[0] || "";
	if (!q) return [];
	const res = await searchFull(env, { query: q, max_results: FILES_LIMIT });
	const items: TimelineItem[] = [];
	const seen = new Set<string>();
	for (const m of res.matches ?? []) {
		const path = m?.path as string | undefined;
		if (!path || seen.has(path)) continue;
		seen.add(path);
		items.push({
			date: m?.modified ? String(m.modified) : null,
			source: "files",
			title: path.split("/").pop() || path,
			...(typeof m?.size === "number" ? { snippet: `${m.size} bytes` } : {}),
			citation: `files:${path}`,
		});
	}
	return items;
}

function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
	let t: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		t = setTimeout(() => reject(new Error(`source timed out after ${ms}ms`)), ms);
	});
	return Promise.race([pr, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}

const hasTime = (it: TimelineItem): boolean => !!it.date && !Number.isNaN(Date.parse(it.date));

/**
 * Assemble a person's timeline at query time. Resolves the person, fans out over mail /
 * calendar / vault / files in parallel (each on its own deadline, degrading independently),
 * then merges and sorts chronologically. Pure read → assemble → return: ZERO-STORE, nothing
 * is materialized or persisted. An empty result is a valid empty timeline, never an error.
 */
export async function assembleTimeline(env: RtEnv, args: any): Promise<ToolResult> {
	const name = String(args?.name ?? "").trim();
	const id = String(args?.id ?? "").trim();
	const email = String(args?.email ?? "").trim();
	if (!name && !id && !email) return failWith("bad_input", "contact timeline needs a person: pass `name`, `id` (contact id), or `email`.");

	const person = await resolvePerson(env, name, id, email);

	const legs: Array<[TimelineSource, (env: RtEnv, p: ResolvedPerson) => Promise<TimelineItem[]>]> = [
		["mail", fromMail],
		["calendar", fromCalendar],
		["vault", fromVault],
		["files", fromFiles],
	];
	const settled = await Promise.allSettled(legs.map(([, fn]) => withTimeout(fn(env, person), SOURCE_TIMEOUT_MS)));
	const sources: Record<string, string> = {};
	const all: TimelineItem[] = [];
	settled.forEach((r, i) => {
		const source = legs[i][0];
		if (r.status === "fulfilled") {
			all.push(...r.value);
			sources[source] = r.value.length ? `${r.value.length} hit(s)` : "no matches";
		} else {
			sources[source] = `unavailable (${errMsg(r.reason).replace(/^\[[a-z_]+\]\s*/, "").slice(0, 90)})`;
		}
	});

	// Merge + chronological sort. Dated items go oldest → newest; undated ones trail the end.
	// When the total exceeds the cap we keep the MOST RECENT dated items (slice the tail), so a
	// long history is truncated to its recent window rather than its ancient one.
	const dated = all.filter(hasTime).sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!));
	const undated = all.filter((it) => !hasTime(it));
	const keptDated = dated.length > MAX_ITEMS ? dated.slice(dated.length - MAX_ITEMS) : dated;
	const keptUndated = undated.slice(0, Math.max(0, MAX_ITEMS - keptDated.length));
	const timeline = [...keptDated, ...keptUndated];

	return ok(
		oj({
			action: "timeline",
			person: { query: person.query, name: person.name, emails: person.emails, resolved: person.resolved, ...(person.contact_id ? { contact_id: person.contact_id } : {}) },
			count: timeline.length,
			order: "chronological (oldest → newest); undated items last",
			sources,
			...(timeline.length ? {} : { note: `No interactions found for ${person.name || person.query} across mail, calendar, vault, or files.` }),
			timeline,
		}),
	);
}
