import { afterEach, describe, expect, it, vi } from "vitest";

// _contact_timeline composes jmap/_caldav/_dropbox-full/vault-mcp — mock each (every one has its
// own suite) so we test the gather+merge logic itself: fan-out, graceful per-leg degrade,
// chronological sort, and citation shape. Mirrors recall.test.ts's mocking approach. Keep
// parseICal (pure) and linkResolvesTo (pure) real.
vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));
vi.mock("./_caldav", async () => {
	const actual = await vi.importActual<any>("./_caldav");
	return { ...actual, hasCalDav: vi.fn(() => false), listCalendars: vi.fn(), reportObjects: vi.fn() };
});
vi.mock("./_dropbox-full", () => ({ hasDropboxFull: vi.fn(() => false), searchFull: vi.fn() }));
vi.mock("../vault-mcp", () => ({ scanVault: vi.fn() }));

import { jmap } from "./jmap";
import { hasCalDav, listCalendars, reportObjects } from "./_caldav";
import { hasDropboxFull, searchFull } from "./_dropbox-full";
import { scanVault } from "../vault-mcp";
import { gatherContactTimeline, resolveContact } from "./_contact_timeline";

const mail = jmap.run as unknown as ReturnType<typeof vi.fn>;
const calHas = hasCalDav as unknown as ReturnType<typeof vi.fn>;
const calList = listCalendars as unknown as ReturnType<typeof vi.fn>;
const calReport = reportObjects as unknown as ReturnType<typeof vi.fn>;
const dbxHas = hasDropboxFull as unknown as ReturnType<typeof vi.fn>;
const dbxSearch = searchFull as unknown as ReturnType<typeof vi.fn>;
const vaultScan = scanVault as unknown as ReturnType<typeof vi.fn>;

const okR = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const env = () => ({}) as any;

/** A minimal stand-in for _jmap.ts's real '#'-back-reference resolver (jmap.run is mocked here) —
 *  just enough to unwrap the one shape this module actually sends. Mirrors
 *  _contact_semantic.test.ts's identical helper. */
function resolvePath(value: any, path: string): any {
	let cur = value;
	for (const seg of path.split("/").filter(Boolean)) {
		if (cur == null) return cur;
		cur = seg === "*" ? (Array.isArray(cur) ? cur : [cur]) : Array.isArray(cur) ? cur.map((v) => v?.[seg]) : cur[seg];
	}
	return cur;
}
function resolveArgs(args: any, results: Record<string, any>): any {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(args ?? {})) {
		if (k.startsWith("#") && v && typeof v === "object" && "resultOf" in (v as any)) out[k.slice(1)] = resolvePath(results[(v as any).resultOf], (v as any).path);
		else out[k] = v;
	}
	return out;
}
/** Route a jmap batch call ([[method,args,callId], ...]) to canned per-method responses, keyed by
 *  method (every call to that method gets the same handler — good enough for the ≤3-address fan-out
 *  fromMail issues, since each Email/query+get pair is otherwise identical in shape). */
function mockBatch(handlers: Record<string, (args: any, callId: string) => [string, any]>) {
	mail.mockImplementation(async (_env: any, args: any) => {
		const results: Record<string, any> = {};
		const methodResponses = (args.calls as [string, any, string][]).map(([method, callArgs, callId]) => {
			const resolved = resolveArgs(callArgs, results);
			const h = handlers[method];
			if (!h) return ["error", { type: "unknownMethod" }, callId];
			const [rMethod, rArgs] = h(resolved, callId);
			results[callId] = rArgs;
			return [rMethod, rArgs, callId];
		});
		return okR({ methodResponses });
	});
}

afterEach(() => vi.clearAllMocks());

describe("resolveContact", () => {
	it("resolves directly by id", async () => {
		mockBatch({ "ContactCard/get": () => ["ContactCard/get", { list: [{ id: "c1", name: { full: "Jane Doe" }, emails: { e: { address: "jane@example.com" } } }] }] });
		const c = await resolveContact(env(), { id: "c1" });
		expect(c).toEqual({ id: "c1", name: "Jane Doe", emails: ["jane@example.com"] });
	});

	it("resolves by name, preferring an exact case-insensitive match over the server's first hit", async () => {
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1", "c2"] }],
			"ContactCard/get": () => [
				"ContactCard/get",
				{
					list: [
						{ id: "c1", name: { full: "Jane Doerr" }, emails: { e: { address: "jd@x.com" } } },
						{ id: "c2", name: { full: "Jane Doe" }, emails: { e: { address: "jane@example.com" } } },
					],
				},
			],
		});
		const c = await resolveContact(env(), { name: "jane doe" });
		expect(c?.id).toBe("c2"); // exact match wins even though it's not the first hit
	});

	it("falls back to name.components when there's no name.full", async () => {
		mockBatch({ "ContactCard/get": () => ["ContactCard/get", { list: [{ id: "c1", name: { components: [{ kind: "given", value: "Jane" }, { kind: "surname", value: "Doe" }] }, emails: {} }] }] });
		const c = await resolveContact(env(), { id: "c1" });
		expect(c?.name).toBe("Jane Doe");
	});

	it("returns null when nothing matches", async () => {
		mockBatch({ "ContactCard/query": () => ["ContactCard/query", { ids: [] }], "ContactCard/get": () => ["ContactCard/get", { list: [] }] });
		expect(await resolveContact(env(), { name: "nobody" })).toBeNull();
	});

	it("throws on a request-level JMAP failure", async () => {
		mail.mockResolvedValue(errR("[not_configured] Fastmail JMAP not configured."));
		await expect(resolveContact(env(), { id: "c1" })).rejects.toThrow();
	});
});

describe("gatherContactTimeline", () => {
	const contact = { id: "c1", name: "Jane Doe", emails: ["jane@example.com"] };

	it("fans out across mail+calendar+vault, merges chronologically, and cites every item", async () => {
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"] }],
			"Email/get": () => ["Email/get", { list: [{ id: "e1", subject: "Re: lunch", from: [{ email: "jane@example.com" }], receivedAt: "2026-02-01T00:00:00Z", preview: "sounds good" }] }],
		});
		calHas.mockReturnValue(true);
		calList.mockResolvedValue([{ href: "/cal/1/", name: "Personal", isTasks: false }]);
		calReport.mockResolvedValue([{ href: "/cal/1/e1.ics", etag: "et1", ical: "BEGIN:VEVENT\r\nUID:ev1\r\nSUMMARY:Coffee with Jane Doe\r\nDTSTART:20260301T150000Z\r\nEND:VEVENT" }]);
		vaultScan.mockResolvedValue({ records: [{ path: "Areas/People/jane.md", fm: { date: "2026-01-01" }, links: [], tags: [], tasks: [], excerpt: "Met Jane Doe at the conference.", keywords: [] }], total: 1, truncated: false });
		dbxHas.mockReturnValue(false);

		const { items, status } = await gatherContactTimeline(env(), contact);
		expect(status).toMatchObject({ mail: "1 hit(s)", calendar: "1 hit(s)", vault: "1 hit(s)", files: "no matches" });
		expect(items).toHaveLength(3);
		for (const item of items) expect(item.citation).toMatch(/^(mail|calendar|vault|files):/);
		// Oldest-first (matches medical_timeline_plan's chronological convention).
		expect(items.map((i) => i.source)).toEqual(["vault", "mail", "calendar"]);
		expect(items.find((i) => i.source === "mail")?.citation).toBe("mail:e1");
		expect(items.find((i) => i.source === "calendar")?.citation).toBe("calendar:/cal/1/e1.ics");
		expect(items.find((i) => i.source === "vault")?.citation).toBe("vault:Areas/People/jane.md");
	});

	it("returns a graceful empty result (not an error) for a contact with no history anywhere", async () => {
		mockBatch({ "Email/query": () => ["Email/query", { ids: [] }], "Email/get": () => ["Email/get", { list: [] }] });
		calHas.mockReturnValue(false);
		vaultScan.mockResolvedValue({ records: [], total: 0, truncated: false });
		dbxHas.mockReturnValue(false);

		const { items, status } = await gatherContactTimeline(env(), contact);
		expect(items).toEqual([]);
		expect(status).toEqual({ mail: "no matches", calendar: "no matches", vault: "no matches", files: "no matches" });
	});

	it("finds a vault mention via a phantom [[Name]] wikilink with no People/<name>.md note required to exist", async () => {
		mockBatch({ "Email/query": () => ["Email/query", { ids: [] }], "Email/get": () => ["Email/get", { list: [] }] });
		calHas.mockReturnValue(false);
		dbxHas.mockReturnValue(false);
		vaultScan.mockResolvedValue({ records: [{ path: "Daily/2026-01-05.md", fm: {}, links: ["Jane Doe"], tags: [], tasks: [], excerpt: "", keywords: [] }], total: 1, truncated: false });

		const { items } = await gatherContactTimeline(env(), contact);
		expect(items).toEqual([expect.objectContaining({ source: "vault", citation: "vault:Daily/2026-01-05.md" })]);
	});

	it("degrades one failing leg without sinking the others", async () => {
		mockBatch({ "Email/query": () => ["Email/query", { ids: [] }], "Email/get": () => ["Email/get", { list: [] }] });
		calHas.mockReturnValue(true);
		calList.mockResolvedValue([{ href: "/cal/1/", name: "Personal", isTasks: false }]);
		calReport.mockRejectedValue(new Error("caldav down"));
		vaultScan.mockRejectedValue(new Error("vault list failed"));
		dbxHas.mockReturnValue(false);

		const { items, status } = await gatherContactTimeline(env(), contact);
		expect(items).toEqual([]);
		expect(status.calendar).toBe("no matches"); // per-calendar REPORT failure is swallowed inside the leg itself
		expect(status.vault).toMatch(/^unavailable/); // scanVault's own rejection surfaces as an unavailable leg
	});

	it("sorts dated items chronologically and pushes undated ones to the end", async () => {
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1", "e2"] }],
			"Email/get": () => [
				"Email/get",
				{
					list: [
						{ id: "e1", subject: "Later", from: [{ email: "jane@example.com" }], receivedAt: "2026-03-01T00:00:00Z" },
						{ id: "e2", subject: "Earlier", from: [{ email: "jane@example.com" }], receivedAt: "2026-01-01T00:00:00Z" },
					],
				},
			],
		});
		calHas.mockReturnValue(false);
		dbxHas.mockReturnValue(true);
		dbxSearch.mockResolvedValue({ matches: [{ path: "/jane/notes.txt", size: 10 }], has_more: false }); // no `modified` → undated
		vaultScan.mockResolvedValue({ records: [], total: 0, truncated: false });

		const { items } = await gatherContactTimeline(env(), contact);
		expect(items.map((i) => i.title)).toEqual(["Earlier", "Later", "/jane/notes.txt"]);
	});
});
