import type { RtEnv } from "../registry";
import { linkResolvesTo } from "../vault-graph";
import { scanVault } from "../vault-mcp";
import { hasCalDav, listCalendars, parseICal, reportObjects } from "./_caldav";
import { hasDropboxFull, searchFull } from "./_dropbox-full";
import { jmap } from "./jmap";
import { errMsg } from "./_util";

// _contact_timeline — the query-time half of v5 W8 (design doc §2.4/§3): a person's history
// assembled on demand from stores that already exist (mail, calendar, vault, Dropbox) — no new
// store, no graph engine, same posture as recall.ts's per-source gather functions. contact.ts's
// `timeline` action / mail-mcp.ts's `contact_timeline` tool is the only caller. Materialized
// `People/<name>.md` notes (Design 2) are explicitly deferred to OPEN #4 — this module never
// writes anything.

export type ResolvedContact = { id: string; name: string; emails: string[] };
export type TimelineItem = { at: string | null; source: "mail" | "calendar" | "vault" | "files"; title: string; detail?: string; citation: string };

function pj(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** Full name from JSCard name.components (RFC 9553) when there's no `full`. Duplicated from
 *  mail-mcp.ts's and _contact_semantic.ts's identical helper rather than imported — both those
 *  modules import (or are imported by) mail-mcp.ts, and importing back would risk a cycle. */
function nameFromComponents(components: any): string {
	if (!Array.isArray(components)) return "";
	const by = (kind: string) => components.find((c: any) => c?.kind === kind)?.value;
	return [by("given"), by("surname")].filter(Boolean).join(" ");
}

function shapeCard(c: any): ResolvedContact | null {
	if (!c?.id) return null;
	const emails = c?.emails ? (Object.values(c.emails).map((e: any) => e?.address).filter(Boolean) as string[]) : [];
	const company = c?.organizations ? ((Object.values(c.organizations)[0] as any)?.name ?? "") : "";
	const name = c?.name?.full || nameFromComponents(c?.name?.components) || company || emails[0] || "(no name)";
	return { id: String(c.id), name, emails };
}

/** Resolve a contact by `id` (direct ContactCard/get) or `name` (ContactCard/query, preferring an
 *  exact case-insensitive full-name match over the server's first hit). Null when nothing matches. */
export async function resolveContact(env: RtEnv, args: { id?: string; name?: string }): Promise<ResolvedContact | null> {
	const calls: [string, Record<string, unknown>, string][] = args.id
		? [["ContactCard/get", { ids: [String(args.id)] }, "g"]]
		: [
				["ContactCard/query", { filter: { text: String(args.name) }, limit: 5 }, "q"],
				["ContactCard/get", { "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "g"],
			];
	const r = await jmap.run(env, { calls });
	const text = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(text || "contact lookup failed");
	const resp = pj(text) as { methodResponses: any[] } | null;
	const g = (resp?.methodResponses ?? []).find((m) => m[0] === "ContactCard/get");
	const list = (g?.[1]?.list ?? []) as any[];
	const shaped = list.map(shapeCard).filter((c): c is ResolvedContact => c !== null);
	if (!shaped.length) return null;
	const wantName = args.name ? String(args.name).trim().toLowerCase() : null;
	if (wantName) {
		const exact = shaped.find((c) => c.name.toLowerCase() === wantName);
		if (exact) return exact;
	}
	return shaped[0];
}

/** A person's name split into ≥3-char stems for keyword-style matching against event/note text —
 *  the same substring-stem approach recall.ts's fromCalendar uses for the same reason (CalDAV/the
 *  vault scan have no server-side full-text search scoped to a person). */
function nameStems(name: string): string[] {
	return name
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/[^a-z0-9]/g, ""))
		.filter((w) => w.length >= 3);
}
function textHit(text: string, stems: string[]): boolean {
	const low = text.toLowerCase();
	return stems.some((s) => low.includes(s));
}

/** Mail by sender: one JMAP batch, one Email/query+get pair per address (≤3), merged and
 *  deduped by id. Cited by JMAP id (not subject) per the design doc's citation shape. */
async function fromMail(env: RtEnv, emails: string[], limit: number): Promise<TimelineItem[]> {
	const addrs = emails.slice(0, 3);
	if (!addrs.length) return [];
	const calls: [string, Record<string, unknown>, string][] = addrs.flatMap((email, i) => [
		["Email/query", { filter: { from: email }, sort: [{ property: "receivedAt", isAscending: false }], limit }, `q${i}`],
		["Email/get", { "#ids": { resultOf: `q${i}`, name: "Email/query", path: "/ids" }, properties: ["id", "subject", "from", "receivedAt", "preview"] }, `g${i}`],
	]);
	const r = await jmap.run(env, { calls });
	const text = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(text || "mail query failed");
	const resp = pj(text) as { methodResponses: any[] } | null;
	const items: TimelineItem[] = [];
	const seen = new Set<string>();
	for (const mr of resp?.methodResponses ?? []) {
		if (mr[0] !== "Email/get") continue;
		for (const e of mr[1]?.list ?? []) {
			const id = e?.id ? String(e.id) : null;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const from = e?.from?.[0]?.email || e?.from?.[0]?.name || "";
			items.push({ at: typeof e?.receivedAt === "string" ? e.receivedAt : null, source: "mail", title: e?.subject || "(no subject)", detail: [from, e?.preview].filter(Boolean).join(": ") || undefined, citation: `mail:${id}` });
		}
	}
	return items.slice(0, limit);
}

/** Calendar events mentioning the contact by name (summary/location/description keyword-stem
 *  match) — CalDAV has no attendee-indexed search, and ATTENDEE lines aren't even preserved when
 *  an event has more than one (parseICal's props is a flat Record, last-write-wins), so name
 *  matching is the same reliable leg recall.ts's fromCalendar already uses. */
async function fromCalendar(env: RtEnv, name: string, limit: number): Promise<TimelineItem[]> {
	if (!hasCalDav(env)) return [];
	const stems = nameStems(name);
	if (!stems.length) return [];
	const now = Date.now();
	const window = { start: new Date(now - 5 * 365 * 864e5).toISOString(), end: new Date(now + 365 * 864e5).toISOString() };
	const cals = (await listCalendars(env)).filter((c) => !c.isTasks);
	const items: TimelineItem[] = [];
	for (const cal of cals) {
		if (items.length >= limit) break;
		let objs: Array<{ href: string; etag: string | null; ical: string }>;
		try {
			objs = await reportObjects(env, cal.href, "VEVENT", window);
		} catch {
			continue; // one unreadable calendar shouldn't sink the whole leg
		}
		for (const o of objs) {
			if (items.length >= limit) break;
			const comp = parseICal(o.ical)[0];
			if (!comp) continue;
			const p = comp.props;
			if (!textHit(`${p.SUMMARY ?? ""} ${p.LOCATION ?? ""} ${p.DESCRIPTION ?? ""}`, stems)) continue;
			items.push({ at: comp.start, source: "calendar", title: p.SUMMARY ?? "(no title)", detail: p.LOCATION || undefined, citation: `calendar:${o.href}` });
		}
	}
	return items;
}

/** Vault mentions: a phantom [[Name]] wikilink (linkResolvesTo — no People/<name>.md note needs to
 *  exist, per the design doc's zero-store constraint) OR a keyword-stem hit in the note's excerpt/
 *  tags. Reuses vault-mcp.ts's scanVault (the same derived-scan cache every backlinks/query/tags
 *  reader shares) rather than writing a second differently-shaped index. */
async function fromVault(env: RtEnv, name: string, limit: number): Promise<TimelineItem[]> {
	const stems = nameStems(name);
	if (!stems.length) return [];
	const { records } = await scanVault(env, undefined, 500);
	const items: TimelineItem[] = [];
	for (const r of records) {
		if (items.length >= limit) break;
		const linked = r.links.some((l) => linkResolvesTo(l, name));
		if (!linked && !textHit(`${r.excerpt} ${r.tags.join(" ")}`, stems)) continue;
		const date = typeof r.fm?.date === "string" ? r.fm.date : null;
		items.push({ at: date, source: "vault", title: r.path, detail: r.excerpt ? r.excerpt.slice(0, 300) : undefined, citation: `vault:${r.path}` });
	}
	return items;
}

/** Dropbox (Mode B) files matching the contact's name — cited by path, dated by `modified` when
 *  Dropbox reports one. Unconfigured Mode B degrades to a skipped leg, same as recall.ts's fromFiles. */
async function fromFiles(env: RtEnv, name: string, limit: number): Promise<TimelineItem[]> {
	if (!hasDropboxFull(env)) return [];
	const res = await searchFull(env, { query: name, max_results: limit });
	const items: TimelineItem[] = [];
	for (const m of res.matches ?? []) {
		const path = m?.path as string | undefined;
		if (!path) continue;
		items.push({ at: typeof m?.modified === "string" ? m.modified : null, source: "files", title: path, detail: typeof m?.size === "number" ? `${m.size} bytes` : undefined, citation: `files:${path}` });
	}
	return items.slice(0, limit);
}

/** The GATHER + merge half of the `timeline` action: fan out across mail/calendar/vault/files
 *  (each degrading independently — an unconfigured or failing leg is reported in `status`, never
 *  fatal), then merge everything into one chronologically-sorted (oldest first, matching
 *  medical_timeline_plan's convention), cited list. Items with no resolvable date sort after every
 *  dated one rather than being dropped — a citation without a timestamp is still a real mention. */
export async function gatherContactTimeline(env: RtEnv, contact: ResolvedContact, opts?: { limit?: number }): Promise<{ items: TimelineItem[]; status: Record<string, string> }> {
	const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
	const legs: Array<[string, () => Promise<TimelineItem[]>]> = [
		["mail", () => fromMail(env, contact.emails, limit)],
		["calendar", () => fromCalendar(env, contact.name, limit)],
		["vault", () => fromVault(env, contact.name, limit)],
		["files", () => fromFiles(env, contact.name, limit)],
	];
	const results = await Promise.allSettled(legs.map(([, fn]) => fn()));
	const status: Record<string, string> = {};
	const items: TimelineItem[] = [];
	legs.forEach(([leg], i) => {
		const r = results[i];
		if (r.status === "fulfilled") {
			items.push(...r.value);
			status[leg] = r.value.length ? `${r.value.length} hit(s)` : "no matches";
		} else {
			status[leg] = `unavailable (${errMsg(r.reason).replace(/^\[[a-z_]+\]\s*/, "").slice(0, 90)})`;
		}
	});
	const dated = items.filter((i) => i.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
	const undated = items.filter((i) => !i.at);
	return { items: [...dated, ...undated].slice(0, limit), status };
}
