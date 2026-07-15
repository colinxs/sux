import { type RtEnv } from "../registry";

// CalDAV engine — Fastmail's calendar + tasks (RFC 4791/5545) over an app-specific password.
// JMAP has no jmap:calendars capability on Fastmail, so calendars ride CalDAV instead: Basic
// auth (FASTMAIL_CALDAV_USER : FASTMAIL_APP_PASSWORD), PROPFIND/REPORT to discover + read,
// PUT/DELETE with ETag preconditions to mutate. iCal is built + parsed here so the ergonomic
// cal_*/task_* verbs never hand-roll RFC 5545. Design: docs/design/sux-integration-ultracode-workflow.md §3.
//
// Everything is inert until both secrets are set — hasCalDav(env) gates every verb with a clear
// not_configured message. XML/iCal parsing is regex-based against Fastmail's known response
// shape (Workers have no DOMParser); it curates the common properties, not the whole spec.

const CALDAV_HOST = "https://caldav.fastmail.com";

export function hasCalDav(env: RtEnv): boolean {
	return !!(env as any).FASTMAIL_CALDAV_USER && !!(env as any).FASTMAIL_APP_PASSWORD;
}

export const CALDAV_NOT_CONFIGURED =
	"Fastmail calendar/tasks need CalDAV credentials. Set FASTMAIL_CALDAV_USER (your Fastmail login/email) and FASTMAIL_APP_PASSWORD (Settings → Privacy & Security → App passwords → new, with Calendars/CalDAV access). JMAP has no calendars capability on Fastmail, so this is a separate credential — the verbs are otherwise ready.";

function authHeader(env: RtEnv): string {
	const user = String((env as any).FASTMAIL_CALDAV_USER);
	const pass = String((env as any).FASTMAIL_APP_PASSWORD);
	return `Basic ${btoa(`${user}:${pass}`)}`;
}

const POST_TIMEOUT_MS = 30_000;

export type CalDavResponse = { status: number; ok: boolean; text: string; etag: string | null };

/** One authenticated CalDAV request. `path` is absolute-from-host or a full URL — an
 *  absolute URL must resolve to CALDAV_HOST, since every request attaches the Fastmail
 *  Basic-auth credential unconditionally; a caller-supplied href pointing off-host would
 *  ship that app password to an arbitrary attacker-controlled server (SSRF / credential
 *  exfiltration — mirrors _jmap.ts's resolveUploadBytes SSRF guard). */
export async function caldavFetch(
	env: RtEnv,
	method: string,
	path: string,
	opts: { body?: string; contentType?: string; depth?: string; ifMatch?: string; ifNoneMatch?: string } = {},
): Promise<CalDavResponse> {
	let url: string;
	if (path.startsWith("http")) {
		let origin: string;
		try {
			origin = new URL(path).origin;
		} catch {
			throw new Error(`invalid CalDAV href '${path}'.`);
		}
		if (origin !== CALDAV_HOST) throw new Error(`CalDAV href must be on ${CALDAV_HOST} — refusing off-host URL (would leak the Fastmail credential).`);
		url = path;
	} else {
		url = `${CALDAV_HOST}${path}`;
	}
	const headers: Record<string, string> = { Authorization: authHeader(env) };
	if (opts.contentType) headers["Content-Type"] = opts.contentType;
	if (opts.depth) headers.Depth = opts.depth;
	if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
	if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
	const resp = await fetch(url, { method, headers, body: opts.body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
	const text = await resp.text();
	return { status: resp.status, ok: resp.ok, text, etag: resp.headers.get("etag") };
}

/** The user's calendar-home collection path (where calendars live). */
export function calendarHome(env: RtEnv): string {
	return `/dav/calendars/user/${encodeURIComponent(String((env as any).FASTMAIL_CALDAV_USER))}/`;
}

// ---- XML (WebDAV multistatus) — regex extraction against Fastmail's response shape ----

const tag = (name: string) => new RegExp(`<(?:[a-zA-Z]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z]+:)?${name}>`, "i");
const tagAll = (name: string) => new RegExp(`<(?:[a-zA-Z]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z]+:)?${name}>`, "gi");

/** Split a multistatus body into <response> blocks. */
export function multistatusResponses(xml: string): string[] {
	return [...xml.matchAll(tagAll("response"))].map((m) => m[1]);
}

function firstTag(block: string, name: string): string | null {
	const m = block.match(tag(name));
	return m ? m[1].trim() : null;
}

export type CalendarRef = { href: string; name: string; description?: string; isTasks: boolean };

/** PROPFIND the calendar-home (Depth 1) → the list of calendar collections. */
export async function listCalendars(env: RtEnv): Promise<CalendarRef[]> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><c:calendar-description/></d:prop>
</d:propfind>`;
	const r = await caldavFetch(env, "PROPFIND", calendarHome(env), { body, contentType: "application/xml; charset=utf-8", depth: "1" });
	if (!r.ok && r.status !== 207) throw new Error(`CalDAV PROPFIND failed: HTTP ${r.status}`);
	const out: CalendarRef[] = [];
	for (const block of multistatusResponses(r.text)) {
		const href = firstTag(block, "href");
		if (!href) continue;
		const rtype = firstTag(block, "resourcetype") ?? "";
		if (!/calendar/i.test(rtype)) continue; // skip the home collection + non-calendar resources
		const comps = block.match(/supported-calendar-component-set([\s\S]*?)supported-calendar-component-set/i)?.[1] ?? "";
		const isTasks = /VTODO/i.test(comps) && !/VEVENT/i.test(comps);
		out.push({ href: href.trim(), name: firstTag(block, "displayname") ?? href.trim(), description: firstTag(block, "calendar-description") ?? undefined, isTasks });
	}
	return out;
}

// ---- iCalendar (RFC 5545) build + parse ----

const enc = new TextEncoder();

/** RFC 5545 §3.1 content-line folding at 75 OCTETS (not chars). Iterating by code point
 *  (for…of) never splits a multibyte UTF-8 sequence; each continuation line starts with a
 *  single space, which counts toward its 75-octet budget so unfolding restores it exactly. */
function foldLine(logical: string): string {
	const out: string[] = [];
	let cur = "";
	let bytes = 0;
	for (const ch of logical) {
		const b = enc.encode(ch).length;
		if (bytes + b > 75) {
			out.push(cur);
			cur = ` ${ch}`; // the leading space is part of this line's octet count
			bytes = 1 + b;
		} else {
			cur += ch;
			bytes += b;
		}
	}
	out.push(cur);
	return out.join("\r\n");
}

function escapeText(value: string): string {
	return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** One unfolded TEXT property line (escaped) — the caller folds it (buildVEvent) or hands it to replaceProps (which folds). */
export function textProp(name: string, value: string): string {
	return `${name}:${escapeText(value)}`;
}

/** One unfolded date/date-time property line: `NAME:20260711T090000Z`, `NAME;VALUE=DATE:20261225`,
 *  or — when `tz` is given (re-anchoring an existing TZID-bearing property) — `NAME;TZID=<tz>:<wall-stamp>`,
 *  DST-aware via `zonedStamp`. A date-only `iso` ignores `tz` (all-day has no zone). */
export function dateProp(name: string, iso: string, tz?: string | null): string {
	if (tz && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
		try {
			return `${name};TZID=${tz}:${zonedStamp(iso, tz)}`;
		} catch {
			/* unrecognized zone — fall through to the UTC stamp rather than fail the whole update */
		}
	}
	const { value, dateOnly } = icalStamp(iso);
	return dateOnly ? `${name};VALUE=DATE:${value}` : `${name}:${value}`;
}

/** An absolute instant (any Date-parseable ISO-8601 form) rendered as iCal wall-clock digits
 *  (`YYYYMMDDTHHMMSS`, no trailing Z) AS OBSERVED IN `tz` — DST-aware via the runtime's tz database
 *  (Workers ship full ICU). Used to re-anchor a TZID-bearing DTSTART/DTEND/DUE without collapsing it
 *  to UTC (the bug this fixes: rewriting a zoned property used to always emit a bare Z stamp, silently
 *  discarding the TZID — correct at the instant of the edit but wrong for how a recurring event's future
 *  occurrences track DST). */
export function zonedStamp(iso: string, tz: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) throw new Error(`invalid date-time '${iso}' (want ISO-8601).`);
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
	return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

/** ISO-8601 → iCal UTC stamp (20260711T090000Z). A date-only value stays a VALUE=DATE. */
export function icalStamp(iso: string): { value: string; dateOnly: boolean } {
	if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { value: iso.replace(/-/g, ""), dateOnly: true };
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) throw new Error(`invalid date-time '${iso}' (want ISO-8601).`);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return { value: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, dateOnly: false };
}

export type EventInput = { uid: string; summary: string; start: string; end?: string; description?: string; location?: string; dtstamp: string };

/** Build a VCALENDAR wrapping one VEVENT. `dtstamp` is passed in (Workers forbid Date.now() ambient use elsewhere, but a real send needs a stamp). */
export function buildVEvent(e: EventInput): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//sux//caldav//EN",
		"BEGIN:VEVENT",
		foldLine(textProp("UID", e.uid)),
		foldLine(dateProp("DTSTAMP", e.dtstamp)),
		foldLine(dateProp("DTSTART", e.start)),
		...(e.end ? [foldLine(dateProp("DTEND", e.end))] : []),
		foldLine(textProp("SUMMARY", e.summary)),
		...(e.description ? [foldLine(textProp("DESCRIPTION", e.description))] : []),
		...(e.location ? [foldLine(textProp("LOCATION", e.location))] : []),
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return lines.join("\r\n");
}

export type TaskInput = { uid: string; summary: string; due?: string; description?: string; status?: string; completed?: string; dtstamp: string };

/** Build a VCALENDAR wrapping one VTODO. A COMPLETED status carries its completion stamp + PERCENT-COMPLETE:100. */
export function buildVTodo(t: TaskInput): string {
	const status = t.status ?? "NEEDS-ACTION";
	const done = status.toUpperCase() === "COMPLETED";
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//sux//caldav//EN",
		"BEGIN:VTODO",
		foldLine(textProp("UID", t.uid)),
		foldLine(dateProp("DTSTAMP", t.dtstamp)),
		...(t.due ? [foldLine(dateProp("DUE", t.due))] : []),
		foldLine(textProp("SUMMARY", t.summary)),
		...(t.description ? [foldLine(textProp("DESCRIPTION", t.description))] : []),
		foldLine(textProp("STATUS", status)),
		...(done ? [foldLine(dateProp("COMPLETED", t.completed ?? t.dtstamp)), "PERCENT-COMPLETE:100"] : []),
		"END:VTODO",
		"END:VCALENDAR",
	];
	return lines.join("\r\n");
}

export type ParsedComponent = {
	component: string;
	props: Record<string, string>;
	params: Record<string, Record<string, string>>;
	start: string | null;
	end: string | null;
	all_day: boolean;
	tz: string | null;
};

/** iCal date/date-time value + its parameters → a normalized ISO-ish string, all-day flag, and zone.
 *  `20261225` / VALUE=DATE → all-day date; `…Z` → UTC (`…Z`); a TZID or floating value keeps its wall
 *  time and surfaces the zone (never silently coerced to UTC). */
export function icalDateToIso(value: string, params: Record<string, string> = {}): { iso: string; all_day: boolean; tz: string | null } {
	const tz = params.TZID ?? null;
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(value.trim());
	if (!m) return { iso: value, all_day: params.VALUE === "DATE", tz };
	const [, y, mo, d, hh, mm, ss, z] = m;
	if (!hh || params.VALUE === "DATE") return { iso: `${y}-${mo}-${d}`, all_day: true, tz: null };
	const wall = `${y}-${mo}-${d}T${hh}:${mm}:${ss ?? "00"}`;
	return z ? { iso: `${wall}Z`, all_day: false, tz: null } : { iso: wall, all_day: false, tz };
}

function splitPropName(namePart: string): { name: string; params: Record<string, string> } {
	const segs = namePart.split(";");
	const params: Record<string, string> = {};
	for (const seg of segs.slice(1)) {
		const eq = seg.indexOf("=");
		if (eq < 0) continue;
		params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
	}
	return { name: segs[0].toUpperCase(), params };
}

function finalizeComponent(component: string, props: Record<string, string>, params: Record<string, Record<string, string>>): ParsedComponent {
	const s = props.DTSTART ? icalDateToIso(props.DTSTART, params.DTSTART) : null;
	const e = props.DTEND ? icalDateToIso(props.DTEND, params.DTEND) : null;
	return { component, props, params, start: s?.iso ?? null, end: e?.iso ?? null, all_day: s?.all_day ?? false, tz: s?.tz ?? null };
}

/** Unfold (RFC 5545 §3.1) + tokenize an iCal blob into its top-level VEVENT/VTODO components.
 *  Once a component is open, a `sub` counter tracks every nested BEGIN…END (VALARM, VTIMEZONE
 *  sub-parts, or any child) and props are captured ONLY while sub===0 — so a VALARM's DESCRIPTION
 *  or a timezone's DTSTART can never bleed into the event, even under malformed/unbalanced nesting.
 *  Never throws; a truncated or garbage blob simply yields whatever closed. */
export function parseICal(text: string): ParsedComponent[] {
	const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
	const lines = unfolded.split(/\r\n|\n/);
	const out: ParsedComponent[] = [];
	let cur: { component: string; props: Record<string, string>; params: Record<string, Record<string, string>> } | null = null;
	let sub = 0; // depth of nested components inside the open target
	for (const line of lines) {
		const begin = /^BEGIN:(.+)$/i.exec(line);
		if (begin) {
			const name = begin[1].trim().toUpperCase();
			if (cur) sub++; // a child component (VALARM/…) of the open target — suppress capture
			else if (name === "VEVENT" || name === "VTODO") {
				cur = { component: name, props: {}, params: {} };
				sub = 0;
			}
			continue;
		}
		const end = /^END:(.+)$/i.exec(line);
		if (end) {
			if (cur) {
				if (sub > 0) sub--; // closing a child — resume capture at the target level
				else {
					out.push(finalizeComponent(cur.component, cur.props, cur.params));
					cur = null;
				}
			}
			continue;
		}
		if (!cur || sub > 0) continue; // only capture directly inside the target, never inside a child
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const { name, params } = splitPropName(line.slice(0, idx));
		if (!name) continue;
		cur.props[name] = line.slice(idx + 1).replace(/\\n/g, "\n").replace(/\\N/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
		if (Object.keys(params).length) cur.params[name] = params;
	}
	return out;
}

/** Rewrite properties of the first VEVENT/VTODO in an iCal blob, preserving everything else
 *  (VALARM, VTIMEZONE, TZID-bearing DTSTART, unknown props). `sets` maps a PROPERTY name to a
 *  full unfolded property line (from textProp/dateProp) to set, or null to delete. Missing
 *  properties are appended before END. The result is re-folded. Used by cal_update/task_*. */
export function replaceProps(ical: string, comp: "VEVENT" | "VTODO", sets: Record<string, string | null>): string {
	const norm: Record<string, string | null> = {};
	for (const [k, v] of Object.entries(sets)) norm[k.toUpperCase()] = v;
	const unfolded = ical.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
	const lines = unfolded.split(/\r\n|\n/);
	const out: string[] = [];
	const applied = new Set<string>();
	let inTarget = false;
	let sub = 0;
	let done = false;
	for (const line of lines) {
		const begin = /^BEGIN:(.+)$/i.exec(line);
		if (begin) {
			if (inTarget) sub++;
			else if (!done && begin[1].trim().toUpperCase() === comp) {
				inTarget = true;
				sub = 0;
			}
			out.push(line);
			continue;
		}
		const end = /^END:(.+)$/i.exec(line);
		if (end) {
			if (inTarget && sub > 0) sub--;
			else if (inTarget) {
				for (const [k, v] of Object.entries(norm)) if (v !== null && !applied.has(k)) out.push(foldLine(v));
				inTarget = false;
				done = true;
			}
			out.push(line);
			continue;
		}
		if (inTarget && sub === 0) {
			const idx = line.indexOf(":");
			const propName = idx >= 0 ? line.slice(0, idx).split(";")[0].toUpperCase() : "";
			if (propName && propName in norm) {
				applied.add(propName);
				const repl = norm[propName];
				if (repl === null) continue; // delete: drop the line
				out.push(foldLine(repl));
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\r\n");
}

/** now..+90d as CalDAV UTC stamps, or a caller override. Absent bound → the default. */
function timeRangeFilter(comp: "VEVENT" | "VTODO", window?: { start?: string; end?: string } | null): string {
	// A time-range on VTODO would drop undated tasks (RFC 4791 §9.9), so only bound events by
	// default; a VTODO window is emitted only when the caller explicitly asks for one.
	const explicit = !!(window && (window.start || window.end));
	if (comp === "VTODO" && !explicit) return "";
	const now = Date.now();
	const stamp = (iso: string): string => {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) throw new Error(`invalid time-range bound '${iso}' (want ISO-8601).`);
		return icalStamp(d.toISOString()).value;
	};
	const start = stamp(window?.start ?? new Date(now).toISOString());
	const end = stamp(window?.end ?? new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString());
	return `<c:time-range start="${start}" end="${end}"/>`;
}

/** REPORT a calendar collection for its VEVENT/VTODO objects, bounded by a time-range so a
 *  multi-year calendar can't blow the deadline/output ceiling. Events default to now..+90d
 *  (caller-overridable via `window`); tasks are unbounded unless a window is passed. */
export async function reportObjects(
	env: RtEnv,
	calendarHref: string,
	comp: "VEVENT" | "VTODO",
	window?: { start?: string; end?: string } | null,
): Promise<Array<{ href: string; etag: string | null; ical: string }>> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${comp}">${timeRangeFilter(comp, window)}</c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
	const r = await caldavFetch(env, "REPORT", calendarHref, { body, contentType: "application/xml; charset=utf-8", depth: "1" });
	if (!r.ok && r.status !== 207) throw new Error(`CalDAV REPORT failed: HTTP ${r.status}`);
	const out: Array<{ href: string; etag: string | null; ical: string }> = [];
	for (const block of multistatusResponses(r.text)) {
		const href = firstTag(block, "href");
		const ical = firstTag(block, "calendar-data");
		if (href && ical) out.push({ href: href.trim(), etag: firstTag(block, "getetag"), ical: ical.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") });
	}
	return out;
}
