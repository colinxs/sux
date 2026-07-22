import { beforeEach, describe, expect, it, vi } from "vitest";

// One mock surface: the jmap engine. Both the scan (Email/query + Email/get) AND the write
// (Mailbox/set create + Email/set membership add) now go through runBatch directly — no more
// mail-mcp labelMessages import (the keyword model was invisible in Fastmail, #1196). The _jmap
// mock keeps everything real EXCEPT runBatch (so `JmapError instanceof` still works), stubbing only
// the JMAP round-trip with a canned Mailbox/get + a position-paged Email/query/Email/get fixture +
// Mailbox/set + Email/set.
const { runBatch } = vi.hoisted(() => ({ runBatch: vi.fn() }));

vi.mock("./_jmap", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_jmap")>();
	return { ...actual, runBatch };
});

import { mail_domain_backfill } from "./mail_domain_backfill";
import { JmapError } from "./_jmap";

const env = { FASTMAIL_TOKEN: "t" } as any;

const INBOX = { id: "mb-inbox", name: "Inbox", role: "inbox", parentId: null };
const ARCHIVE = { id: "mb-archive", name: "Archive", role: "archive", parentId: null };

// id 1 → finance, 2 → shopping, 3 → edu+uw+cs, 4 → none (personal), 5 → gov. Each starts life in the
// Inbox (mailboxIds), which the keep-in-place label add must PRESERVE (never remove).
function freshFixture() {
	return [
		{ id: "1", from: [{ email: "alerts@email.chase.com" }], mailboxIds: { [INBOX.id]: true } },
		{ id: "2", from: [{ email: "receipts@order.amazon.com" }], mailboxIds: { [INBOX.id]: true } },
		{ id: "3", from: [{ name: "Prof X", email: "prof@cs.uw.edu" }], mailboxIds: { [INBOX.id]: true } },
		{ id: "4", from: [{ email: "friend@gmail.com" }], mailboxIds: { [INBOX.id]: true } },
		{ id: "5", from: [{ email: "noreply@irs.gov" }], mailboxIds: { [INBOX.id]: true } },
	];
}

let boxes: any[];
let FIXTURE: ReturnType<typeof freshFixture>;

function scanImpl(_env: unknown, calls: any[]) {
	const method = calls[0][0];
	if (method === "Mailbox/get") return { response: { methodResponses: [["Mailbox/get", { list: boxes }, "m"]] }, session: {} };
	if (method === "Mailbox/set") {
		const create = calls[0][1]?.create?.m;
		const id = `mb-created-${boxes.length}`;
		const created = { id, name: create.name, parentId: create.parentId };
		boxes.push({ ...created, role: null });
		return { response: { methodResponses: [["Mailbox/set", { created: { m: created } }, "c"]] }, session: {} };
	}
	if (method === "Email/set") {
		const update = calls[0][1]?.update ?? {};
		const updated: Record<string, unknown> = {};
		for (const id of Object.keys(update)) updated[id] = {};
		return { response: { methodResponses: [["Email/set", { updated }, "s"]] }, session: {} };
	}
	const qArgs = calls[0][1];
	const position = Number(qArgs.position) || 0;
	const limit = Number(qArgs.limit) || 200;
	const page = FIXTURE.slice(position, position + limit);
	return {
		response: {
			methodResponses: [
				["Email/query", { ids: page.map((e) => e.id), total: FIXTURE.length, position, queryState: "qs" }, "q"],
				["Email/get", { list: page }, "g"],
			],
		},
		session: {},
	};
}

/** The single Email/set update patch of the whole run (the fn issues one per page). */
function lastEmailSetUpdate(): Record<string, Record<string, unknown>> {
	const call = [...runBatch.mock.calls].reverse().find((c) => c[1]?.[0]?.[0] === "Email/set");
	return call![1][0][1].update;
}

beforeEach(() => {
	boxes = [INBOX, ARCHIVE];
	FIXTURE = freshFixture();
	runBatch.mockReset();
	runBatch.mockImplementation(scanImpl);
});

describe("mail_domain_backfill", () => {
	it("dry_run (default): reports per-label counts, mutates nothing (no Mailbox/set, no Email/set)", async () => {
		const r = await mail_domain_backfill.run(env, {});
		expect(r.isError).toBeFalsy();
		const p = JSON.parse(r.content![0].text as string);
		expect(p.dry_run).toBe(true);
		expect(p.scanned).toBe(5);
		expect(p.would_label).toBe(4); // 1,2,3,5 label; 4 (gmail) does not
		expect(p.per_keyword).toEqual({ finance: 1, shopping: 1, edu: 1, uw: 1, cs: 1, gov: 1 });
		expect(p.done).toBe(true);
		expect(p.cursor).toBeNull();
		// No mutation of any kind in dry-run — the ONLY calls are Mailbox/get + the scan pages.
		expect(runBatch.mock.calls.some((c) => c[1]?.[0]?.[0] === "Mailbox/set")).toBe(false);
		expect(runBatch.mock.calls.some((c) => c[1]?.[0]?.[0] === "Email/set")).toBe(false);
	});

	it("dry_run:false adds each message to a per-label folder NESTED under Inbox, creating them on first use", async () => {
		const r = await mail_domain_backfill.run(env, { dry_run: false });
		expect(r.isError).toBeFalsy();
		const p = JSON.parse(r.content![0].text as string);
		expect(p.dry_run).toBe(false);
		expect(p.labeled).toBe(4);
		expect(p.per_keyword).toEqual({ finance: 1, shopping: 1, edu: 1, uw: 1, cs: 1, gov: 1 });
		// A label folder was created for every distinct flag, each nested under Inbox.
		for (const name of ["finance", "shopping", "edu", "uw", "cs", "gov"]) {
			expect(boxes.some((b) => b.name === name && b.parentId === INBOX.id)).toBe(true);
		}
		// The create calls asked for that nesting explicitly (never top-level).
		const createNames = runBatch.mock.calls.filter((c) => c[1]?.[0]?.[0] === "Mailbox/set").map((c) => c[1][0][1].create.m);
		expect(createNames.every((m: any) => m.parentId === INBOX.id)).toBe(true);
	});

	it("KEEP-IN-PLACE + REVERSIBLE: the Email/set patch only ever ADDS label membership — never removes the Inbox, never a keyword, never a null", async () => {
		await mail_domain_backfill.run(env, { dry_run: false });
		const update = lastEmailSetUpdate();
		// Every message's patch: at least one `mailboxIds/*: true` add, the Inbox membership left
		// untouched (no `mailboxIds/<inbox>: null` — that would be a MOVE/skip-inbox), no keyword patch.
		for (const id of Object.keys(update)) {
			const patch = update[id];
			const keys = Object.keys(patch);
			expect(keys.length).toBeGreaterThan(0);
			for (const k of keys) {
				expect(k.startsWith("mailboxIds/")).toBe(true); // never `keywords/*`
				expect(patch[k]).toBe(true); // additive only — never null (a removal)
			}
			expect(keys).not.toContain(`mailboxIds/${INBOX.id}`); // Inbox membership never touched (keep-in-place)
		}
	});

	it("a message matching multiple categories (edu+uw+cs) joins every label folder in one additive patch, still in the Inbox", async () => {
		const r = await mail_domain_backfill.run(env, { dry_run: false });
		JSON.parse(r.content![0].text as string);
		const update = lastEmailSetUpdate();
		const eduId = boxes.find((b) => b.name === "edu" && b.parentId === INBOX.id).id;
		const uwId = boxes.find((b) => b.name === "uw" && b.parentId === INBOX.id).id;
		const csId = boxes.find((b) => b.name === "cs" && b.parentId === INBOX.id).id;
		expect(update["3"][`mailboxIds/${eduId}`]).toBe(true);
		expect(update["3"][`mailboxIds/${uwId}`]).toBe(true);
		expect(update["3"][`mailboxIds/${csId}`]).toBe(true);
		expect(update["3"][`mailboxIds/${INBOX.id}`]).toBeUndefined(); // still in the Inbox
	});

	it("IDEMPOTENT: a message already in a label folder is skipped (dry-run counts it as nothing-to-do)", async () => {
		// Pre-seed a nested finance folder AND put message 1 already in it.
		const FINANCE = { id: "mb-finance", name: "finance", role: null, parentId: INBOX.id };
		boxes.push(FINANCE);
		FIXTURE[0].mailboxIds = { [INBOX.id]: true, [FINANCE.id]: true };
		const r = await mail_domain_backfill.run(env, {});
		const p = JSON.parse(r.content![0].text as string);
		expect(p.would_label).toBe(3); // 1 is already labeled → skipped; 2,3,5 remain
		expect(p.per_keyword.finance).toBeUndefined();
		expect(p.per_keyword).toEqual({ shopping: 1, edu: 1, uw: 1, cs: 1, gov: 1 });
	});

	it("IDEMPOTENT on apply: the already-labeled message gets no Email/set patch and reuses the existing folder", async () => {
		const FINANCE = { id: "mb-finance", name: "finance", role: null, parentId: INBOX.id };
		boxes.push(FINANCE);
		FIXTURE[0].mailboxIds = { [INBOX.id]: true, [FINANCE.id]: true };
		await mail_domain_backfill.run(env, { dry_run: false });
		const update = lastEmailSetUpdate();
		expect(update["1"]).toBeUndefined(); // never re-patched
		// The pre-existing finance folder was reused, not duplicated.
		const financeCreates = runBatch.mock.calls.filter((c) => c[1]?.[0]?.[0] === "Mailbox/set" && c[1][0][1].create.m.name === "finance");
		expect(financeCreates.length).toBe(0);
	});

	it("is resumable: a bounded max returns a cursor + done:false, and the cursor resumes the sweep", async () => {
		const r1 = await mail_domain_backfill.run(env, { max: 2 });
		const p1 = JSON.parse(r1.content![0].text as string);
		expect(p1.scanned).toBe(2); // ids 1,2
		expect(p1.done).toBe(false);
		expect(typeof p1.cursor).toBe("string");
		expect(p1.per_keyword).toEqual({ finance: 1, shopping: 1 });

		const r2 = await mail_domain_backfill.run(env, { max: 2, cursor: p1.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(2); // ids 3,4 — resumed at position 2 (keep-in-place: full-page advance)
		expect(p2.per_keyword).toEqual({ edu: 1, uw: 1, cs: 1 });
		expect(p2.done).toBe(false);
	});

	it("does not advance the resume cursor past a page whose label write failed", async () => {
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Email/set") {
				const update = calls[0][1]?.update ?? {};
				const updated: Record<string, unknown> = {};
				const notUpdated: Record<string, unknown> = {};
				for (const id of Object.keys(update)) {
					if (id === "2") notUpdated[id] = { type: "invalidPatch" };
					else updated[id] = {};
				}
				return { response: { methodResponses: [["Email/set", { updated, notUpdated }, "s"]] }, session: {} };
			}
			return scanImpl(_env, calls);
		});
		const r = await mail_domain_backfill.run(env, { max: 2, dry_run: false }); // page: ids 1 (finance), 2 (shopping)
		const p = JSON.parse(r.content![0].text as string);
		expect(p.errors).toEqual([{ keyword: "shopping", error: expect.any(String) }]);
		expect(p.done).toBe(false);
		expect(typeof p.cursor).toBe("string");

		// Resuming re-scans the SAME failed page (position 0), not the next one.
		runBatch.mockImplementation(scanImpl);
		const r2 = await mail_domain_backfill.run(env, { max: 2, dry_run: false, cursor: p.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(2); // re-scanned ids 1,2 from position 0
		expect(p2.per_keyword).toEqual({ finance: 1, shopping: 1 });
		expect(p2.errors).toBeUndefined();
	});

	it("rejects a cursor issued for a different mailbox", async () => {
		const r1 = await mail_domain_backfill.run(env, { max: 2 });
		const cursor = JSON.parse(r1.content![0].text as string).cursor;
		const r2 = await mail_domain_backfill.run(env, { mailbox: "archive", cursor });
		expect(r2.isError).toBe(true);
		expect(r2.content![0].text).toContain("different mailbox");
	});

	it("returns not_found for an unknown mailbox, mutating nothing", async () => {
		const r = await mail_domain_backfill.run(env, { mailbox: "no-such-folder", dry_run: false });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_found");
		expect(runBatch).toHaveBeenCalledTimes(1); // only the Mailbox/get lookup
	});

	it("returns not_configured when FASTMAIL_TOKEN is absent, before any JMAP call", async () => {
		const r = await mail_domain_backfill.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("maps a JmapError from the engine to its FailCode", async () => {
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Mailbox/get") return scanImpl(_env, calls);
			throw new JmapError("rate_limited", "JMAP rate-limited (429).");
		});
		const r = await mail_domain_backfill.run(env, {});
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("rate_limited");
	});
});
