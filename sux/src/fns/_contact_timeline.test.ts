import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The timeline action composes jmap (contacts + mail), _caldav (calendar), _vault_semantic
// (vault mentions) and _dropbox-full (files) — mock each seam (every one has its own suite) so
// we test the ASSEMBLY: person resolution, per-source fan-out, chronological merge, citation
// presence, graceful degrade, and the zero-store invariant. parseICal stays REAL (the calendar
// leg parses whatever reportObjects returns), exactly as recall.test.ts keeps it real.
vi.mock("../ai", () => ({ hasAI: vi.fn(() => true) }));
vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));
vi.mock("./_embed", () => ({ embedOne: vi.fn(async () => [1, 0, 0]) }));
vi.mock("./obsidian", () => ({ vaultCfg: vi.fn(() => ({ repo: "me/vault", branch: "main", dir: "", inVault: (p: string) => p })) }));
vi.mock("./_vault_semantic", () => ({ vaultSemanticIndex: vi.fn(), topKByCosine: vi.fn() }));
vi.mock("./_dropbox-full", () => ({ hasDropboxFull: vi.fn(() => false), searchFull: vi.fn() }));
vi.mock("./_caldav", async () => {
	const actual = await vi.importActual<any>("./_caldav");
	return { ...actual, hasCalDav: vi.fn(() => false), listCalendars: vi.fn(), reportObjects: vi.fn() };
});

import { assembleTimeline } from "./_contact_timeline";
import { contact } from "./contact";
import { hasAI } from "../ai";
import { jmap } from "./jmap";
import { vaultSemanticIndex, topKByCosine } from "./_vault_semantic";
import { hasDropboxFull, searchFull } from "./_dropbox-full";
import { hasCalDav, listCalendars, reportObjects } from "./_caldav";

const okR = (text: string) => ({ content: [{ type: "text", text }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const parse = (r: any) => JSON.parse(r.content[0].text);

const jmapRun = jmap.run as unknown as ReturnType<typeof vi.fn>;
const aiHas = hasAI as unknown as ReturnType<typeof vi.fn>;
const vIndex = vaultSemanticIndex as unknown as ReturnType<typeof vi.fn>;
const vTopK = topKByCosine as unknown as ReturnType<typeof vi.fn>;
const dbxHas = hasDropboxFull as unknown as ReturnType<typeof vi.fn>;
const dbxSearch = searchFull as unknown as ReturnType<typeof vi.fn>;
const calHas = hasCalDav as unknown as ReturnType<typeof vi.fn>;
const calList = listCalendars as unknown as ReturnType<typeof vi.fn>;
const calReport = reportObjects as unknown as ReturnType<typeof vi.fn>;

// One VEVENT whose ical mentions the person (an ATTENDEE address) — the client-side match the
// calendar leg does, since CalDAV has no server-side full-text search.
const EVENT_ICAL = [
	"BEGIN:VCALENDAR",
	"BEGIN:VEVENT",
	"UID:ev1",
	"SUMMARY:Coffee with Ada",
	"DTSTART:20260520T090000Z",
	"DTEND:20260520T100000Z",
	"LOCATION:Blue Bottle",
	"ATTENDEE;CN=Ada Lovelace:mailto:ada@x.com",
	"END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

// A KV whose put is SPIED so the zero-store test can assert the action writes nothing.
let kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
const env = () => ({ AI: {}, OAUTH_KV: kv, OBSIDIAN_VAULT_REPO: "me/vault", FASTMAIL_TOKEN: "tok" }) as any;

/** A JMAP mock that answers ContactCard resolution and Email query/get from fixtures. */
function wireJmap(opts: { cards?: any[]; emails?: any[] } = {}) {
	const cards = opts.cards ?? [{ id: "c1", name: { full: "Ada Lovelace" }, emails: { e: { address: "ada@x.com" } } }];
	const emails = opts.emails ?? [];
	jmapRun.mockImplementation(async (_e: any, a: any) => {
		const method = a?.calls?.[0]?.[0];
		if (method === "ContactCard/get" || method === "ContactCard/query") return okR(JSON.stringify({ methodResponses: [["ContactCard/get", { list: cards }, "g"]] }));
		if (method === "Email/query") return okR(JSON.stringify({ methodResponses: [["Email/get", { list: emails }, "g"]] }));
		return okR(JSON.stringify({ methodResponses: [] }));
	});
}

beforeEach(() => {
	const store = new Map<string, string>();
	kv = {
		get: vi.fn(async (k: string) => store.get(k) ?? null),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async () => ({ keys: [], list_complete: true as const })),
	};
	aiHas.mockReturnValue(true);
	wireJmap();
	// Vault/calendar/files default OFF; the mixed-history test turns them on explicitly.
	vIndex.mockResolvedValue(null);
	vTopK.mockReturnValue([]);
	dbxHas.mockReturnValue(false);
	calHas.mockReturnValue(false);
});
afterEach(() => vi.clearAllMocks());

describe("contact timeline — input", () => {
	it("requires a person (name | id | email)", async () => {
		const r = await assembleTimeline(env(), {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
	});

	it("is reachable as the contact fn's `timeline` action", async () => {
		expect((contact.inputSchema as any).properties.action.enum).toContain("timeline");
		const out = parse(await contact.run(env(), { action: "timeline", name: "Ada Lovelace" }));
		expect(out.action).toBe("timeline");
		expect(out.person.name).toBe("Ada Lovelace");
	});
});

describe("contact timeline — mixed-source assembly", () => {
	beforeEach(() => {
		wireJmap({
			emails: [
				{ id: "m1", subject: "Re: analytical engine", from: [{ email: "ada@x.com" }], to: [{ email: "me@x.com" }], receivedAt: "2026-05-10T10:00:00Z", preview: "the engine" },
				{ id: "m2", subject: "Notes back", from: [{ email: "me@x.com" }], to: [{ email: "ada@x.com" }], receivedAt: "2026-06-01T10:00:00Z", preview: "thanks" },
			],
		});
		calHas.mockReturnValue(true);
		calList.mockResolvedValue([{ href: "/dav/cal/personal/", name: "Personal", isTasks: false }]);
		calReport.mockResolvedValue([{ href: "/dav/cal/personal/ev1.ics", etag: null, ical: EVENT_ICAL }]);
		vIndex.mockResolvedValue({ chunks: [{ path: "Daily/2026-05-15.md", title: "2026-05-15", text: "Met Ada Lovelace about the engine", embedding: [1, 0, 0] }] });
		vTopK.mockReturnValue([{ path: "Daily/2026-05-15.md", title: "2026-05-15", text: "Met Ada Lovelace about the engine", score: 1 }]);
		dbxHas.mockReturnValue(true);
		dbxSearch.mockResolvedValue({ matches: [{ path: "/Docs/ada-notes.pdf", size: 1234, modified: "2026-04-01T00:00:00Z" }], has_more: false });
	});

	it("assembles a chronologically-sorted, fully-cited timeline across mail+calendar+vault+files", async () => {
		const out = parse(await assembleTimeline(env(), { name: "Ada Lovelace" }));

		expect(out.person).toMatchObject({ name: "Ada Lovelace", emails: ["ada@x.com"], resolved: true, contact_id: "c1" });
		expect(out.sources).toMatchObject({ mail: "2 hit(s)", calendar: "1 hit(s)", vault: "1 hit(s)", files: "1 hit(s)" });
		expect(out.count).toBe(5);

		// Chronological (oldest → newest): files(04-01) < mail(05-10) < vault(05-15) < cal(05-20) < mail(06-01).
		expect(out.timeline.map((i: any) => i.source)).toEqual(["files", "mail", "vault", "calendar", "mail"]);
		const times = out.timeline.map((i: any) => Date.parse(i.date));
		expect(times).toEqual([...times].sort((a, b) => a - b));

		// Every item carries a citation pointing back to its source item.
		for (const it of out.timeline) expect(typeof it.citation).toBe("string"), expect(it.citation.length).toBeGreaterThan(0);
		const cites = out.timeline.map((i: any) => i.citation);
		expect(cites).toEqual(expect.arrayContaining(["files:/Docs/ada-notes.pdf", "mail:m1", "vault:Daily/2026-05-15.md", "calendar:/dav/cal/personal/ev1.ics", "mail:m2"]));

		// Mail direction: from the person = received, to the person = sent.
		expect(out.timeline.find((i: any) => i.citation === "mail:m1").direction).toBe("received");
		expect(out.timeline.find((i: any) => i.citation === "mail:m2").direction).toBe("sent");
	});

	it("writes NOTHING — zero-store (no KV put, no JMAP */set mutation)", async () => {
		await assembleTimeline(env(), { name: "Ada Lovelace" });
		expect(kv.put).not.toHaveBeenCalled();
		const methodsCalled = jmapRun.mock.calls.flatMap((c: any) => (c[1]?.calls ?? []).map((call: any) => call[0]));
		expect(methodsCalled.length).toBeGreaterThan(0);
		expect(methodsCalled.some((m: string) => /\/set$/.test(m))).toBe(false); // only reads: query/get, never Email/set or ContactCard/set
	});
});

describe("contact timeline — empty + degrade", () => {
	it("a person with no interactions returns an empty timeline, not an error", async () => {
		// No contact card, no mail, and every other store unconfigured.
		wireJmap({ cards: [], emails: [] });
		const r = await assembleTimeline(env(), { name: "Nobody Here" });
		expect(r.isError).toBeFalsy();
		const out = parse(r);
		expect(out.count).toBe(0);
		expect(out.timeline).toEqual([]);
		expect(out.person.resolved).toBe(false);
		expect(out.note).toContain("No interactions found");
	});

	it("a failing source is reported unavailable, never fatal to the rest", async () => {
		wireJmap({ emails: [{ id: "m9", subject: "Hi", from: [{ email: "ada@x.com" }], to: [{ email: "me@x.com" }], receivedAt: "2026-05-01T00:00:00Z" }] });
		dbxHas.mockReturnValue(true);
		dbxSearch.mockRejectedValue(new Error("dropbox down"));
		const out = parse(await assembleTimeline(env(), { name: "Ada Lovelace" }));
		expect(out.sources.files).toContain("unavailable");
		expect(out.sources.mail).toBe("1 hit(s)"); // the reachable stores still populate
		expect(out.count).toBe(1);
	});

	it("skips the vault leg (no crash) when the AI binding is absent", async () => {
		aiHas.mockReturnValue(false);
		vIndex.mockResolvedValue({ chunks: [{ path: "n.md", title: "n", text: "Ada", embedding: [1, 0, 0] }] });
		const out = parse(await assembleTimeline(env(), { name: "Ada Lovelace" }));
		expect(out.sources.vault).toBe("no matches");
		expect(vIndex).not.toHaveBeenCalled();
	});
});

describe("contact timeline — resolution", () => {
	it("resolves by email and queries mail by that address", async () => {
		wireJmap({ cards: [], emails: [{ id: "m1", subject: "Hi", from: [{ email: "ada@x.com" }], to: [{ email: "me@x.com" }], receivedAt: "2026-01-01T00:00:00Z" }] });
		const out = parse(await assembleTimeline(env(), { email: "ada@x.com" }));
		expect(out.person.emails).toContain("ada@x.com");
		const emailQuery = jmapRun.mock.calls.map((c: any) => c[1]).find((a: any) => a?.calls?.[0]?.[0] === "Email/query");
		expect(JSON.stringify(emailQuery.calls[0][1].filter)).toContain("ada@x.com");
		expect(out.count).toBe(1);
	});
});
