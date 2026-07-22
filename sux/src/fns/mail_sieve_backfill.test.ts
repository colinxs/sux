import { beforeEach, describe, expect, it, vi } from "vitest";

// One mock surface: the jmap engine (both the scan AND the write — Email/set — now go through
// runBatch directly, no more mail-mcp labelMessages import).
const { runBatch } = vi.hoisted(() => ({ runBatch: vi.fn() }));

vi.mock("./_jmap", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_jmap")>();
	return { ...actual, runBatch };
});

import { mail_sieve_backfill } from "./mail_sieve_backfill";
import { JmapError } from "./_jmap";

const env = { FASTMAIL_TOKEN: "t" } as any;

const FIXTURE = [
	{ id: "1", from: [{ email: "prize@sketchy.tld" }], subject: "You WON the lottery! Claim your prize now" },
	{ id: "2", from: [{ email: "newsletter@substack.com" }], subject: "Weekly roundup" },
	{ id: "3", from: [{ email: "friend@gmail.com" }], subject: "lunch tomorrow?" },
];

const INBOX = { id: "mb-inbox", name: "Inbox", role: "inbox" };
const ARCHIVE = { id: "mb-archive", name: "Archive", role: "archive" };
const JUNK_SUX = { id: "mb-junk-sux", name: "Junk (sux)", role: null };
const MAILING_LIST_SUX = { id: "mb-ml-sux", name: "Mailing List (sux)", role: null };

// Mutable per-test mailbox list (starts with just the two real system mailboxes, and gains a
// target folder when a test pre-seeds it — otherwise `mail_sieve_backfill` must create it itself).
let boxes: any[];

function scanImpl(_env: unknown, calls: any[]) {
	const method = calls[0][0];
	if (method === "Mailbox/get") return { response: { methodResponses: [["Mailbox/get", { list: boxes }, "m"]] }, session: {} };
	if (method === "Mailbox/set") {
		const create = calls[0][1]?.create?.m;
		const id = `mb-created-${boxes.length}`;
		const created = { id, name: create.name };
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

beforeEach(() => {
	boxes = [INBOX, ARCHIVE];
	runBatch.mockReset();
	runBatch.mockImplementation(scanImpl);
});

describe("mail_sieve_backfill", () => {
	it("dry_run (default): reports matches and calls Email/set zero times", async () => {
		const r = await mail_sieve_backfill.run(env, {});
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.dry_run).toBe(true);
		expect(parsed.would_move).toBe(2); // messages 1 (junk) and 2 (mailing-list); 3 matches nothing
		expect(parsed.done).toBe(true);
		expect(parsed.cursor).toBeNull();
		expect(runBatch).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.arrayContaining(["Email/set"])]), expect.anything());
	});

	it("dry_run:false moves matched messages into per-flag mailboxes, creating them on first use", async () => {
		const r = await mail_sieve_backfill.run(env, { dry_run: false });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.dry_run).toBe(false);
		expect(parsed.moved).toBe(2);
		const junk = parsed.applied.find((a: any) => a.flag === "junk");
		const mailingList = parsed.applied.find((a: any) => a.flag === "mailing-list");
		expect(junk).toEqual({ flag: "junk", mailbox: "Junk (sux)", count: 1 });
		expect(mailingList).toEqual({ flag: "mailing-list", mailbox: "Mailing List (sux)", count: 1 });
		// Two NEW mailboxes were created (none pre-existed in `boxes`).
		expect(boxes.some((b) => b.name === "Junk (sux)")).toBe(true);
		expect(boxes.some((b) => b.name === "Mailing List (sux)")).toBe(true);
	});

	it("reuses an existing target mailbox instead of creating a duplicate", async () => {
		boxes.push(JUNK_SUX, MAILING_LIST_SUX);
		await mail_sieve_backfill.run(env, { dry_run: false });
		const setCalls = runBatch.mock.calls.filter((c) => c[1]?.[0]?.[0] === "Mailbox/set");
		expect(setCalls.length).toBe(0);
	});

	it("moves a message matching multiple categories into every matched mailbox in one patch", async () => {
		boxes.push(JUNK_SUX);
		// "ci@circleci.com" matches ONLY the service_notification "ci" rule (unlike a "no-reply@"
		// sender, which would also trip the mailing-list/notification cues) — junk (subject) + ci
		// (sender) is a clean two-flag case.
		const MULTI = [{ id: "1", from: [{ email: "ci@circleci.com" }], subject: "You WON the lottery! Claim your prize now" }];
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Mailbox/get") return scanImpl(_env, calls);
			if (calls[0][0] === "Mailbox/set") return scanImpl(_env, calls);
			if (calls[0][0] === "Email/set") return scanImpl(_env, calls);
			const { position, limit } = calls[0][1];
			const page = MULTI.slice(position, position + limit);
			return { response: { methodResponses: [["Email/query", { ids: page.map((e) => e.id), total: MULTI.length, position, queryState: "qs" }, "q"], ["Email/get", { list: page }, "g"]] }, session: {} };
		});
		const r = await mail_sieve_backfill.run(env, { dry_run: false });
		const p = JSON.parse(r.content![0].text as string);
		expect(p.moved).toBe(1);
		const setCall = runBatch.mock.calls.find((c) => c[1]?.[0]?.[0] === "Email/set");
		const update = setCall![1][0][1].update;
		expect(update["1"][`mailboxIds/${INBOX.id}`]).toBe(null);
		expect(update["1"][`mailboxIds/${JUNK_SUX.id}`]).toBe(true);
		expect(update["1"][`mailboxIds/mb-created-3`]).toBe(true); // "ci" flag's freshly-created mailbox
	});

	it("does not advance the resume cursor past a scan window with a failed write", async () => {
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
		const r = await mail_sieve_backfill.run(env, { dry_run: false });
		const p = JSON.parse(r.content![0].text as string);
		expect(p.applied).toEqual(
			expect.arrayContaining([
				{ flag: "junk", mailbox: "Junk (sux)", count: 1 },
				expect.objectContaining({ flag: "mailing-list", count: 0, error: expect.any(String) }),
			]),
		);
		expect(p.done).toBe(false);
		expect(typeof p.cursor).toBe("string");

		// Resuming with the returned cursor re-scans from the START of this call's window
		// (position 0), not past the failed flag's messages.
		runBatch.mockImplementation(scanImpl);
		const r2 = await mail_sieve_backfill.run(env, { dry_run: false, cursor: p.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(3); // re-scanned ids 1,2,3 from position 0
	});

	it("rejects an unknown category before ever calling the jmap engine", async () => {
		const r = await mail_sieve_backfill.run(env, { categories: ["bogus"] });
		expect(r.isError).toBe(true);
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("narrows to the requested categories only", async () => {
		const r = await mail_sieve_backfill.run(env, { categories: ["junk"] });
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.would_move).toBe(1);
		expect(parsed.matches[0].flags).toEqual(["junk"]);
	});

	it("is resumable: a bounded max returns a cursor + done:false, and the cursor resumes the sweep", async () => {
		const r1 = await mail_sieve_backfill.run(env, { max: 2 });
		const p1 = JSON.parse(r1.content![0].text as string);
		expect(p1.scanned).toBe(2); // ids 1,2
		expect(p1.done).toBe(false);
		expect(typeof p1.cursor).toBe("string");
		expect(p1.would_move).toBe(2);

		const r2 = await mail_sieve_backfill.run(env, { max: 2, cursor: p1.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(1); // id 3 — resumed at position 2
		expect(p2.would_move).toBe(0);
		expect(p2.done).toBe(true);
	});

	it("advances the resume cursor by messages STILL in the mailbox, not the raw page size, once moves happen", async () => {
		// max:2 scans ids 1,2 — both match (junk, mailing-list) and both get moved OUT of inMailbox.
		// A REAL, mutating JMAP server's NEXT Email/query would then see id "3" at position 0 (not
		// 2) — this mock tracks moved ids and filters the live set accordingly, unlike the static
		// FIXTURE-slice mock above. Confirms position advances by (pageSize - movedThisPage) = 0.
		const movedIds = new Set<string>();
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Mailbox/get" || calls[0][0] === "Mailbox/set") return scanImpl(_env, calls);
			if (calls[0][0] === "Email/set") {
				const update = calls[0][1]?.update ?? {};
				const updated: Record<string, unknown> = {};
				for (const id of Object.keys(update)) {
					updated[id] = {};
					movedIds.add(id);
				}
				return { response: { methodResponses: [["Email/set", { updated }, "s"]] }, session: {} };
			}
			const { position, limit } = calls[0][1];
			const live = FIXTURE.filter((e) => !movedIds.has(e.id));
			const page = live.slice(position, position + limit);
			return { response: { methodResponses: [["Email/query", { ids: page.map((e) => e.id), total: live.length, position, queryState: "qs" }, "q"], ["Email/get", { list: page }, "g"]] }, session: {} };
		});
		const r1 = await mail_sieve_backfill.run(env, { dry_run: false, max: 2 });
		const p1 = JSON.parse(r1.content![0].text as string);
		expect(p1.moved).toBe(2);
		expect(p1.done).toBe(false);

		const r2 = await mail_sieve_backfill.run(env, { dry_run: false, max: 2, cursor: p1.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(1); // saw "3" — proves position resumed at 0, not 2
	});

	it("a write failure on one page doesn't drop the whole run — later pages still apply and report their own errors", async () => {
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Email/set") {
				const update = calls[0][1]?.update ?? {};
				const updated: Record<string, unknown> = {};
				const notUpdated: Record<string, unknown> = {};
				for (const id of Object.keys(update)) {
					if (id === "1") notUpdated[id] = { type: "forbidden" };
					else updated[id] = {};
				}
				return { response: { methodResponses: [["Email/set", { updated, notUpdated }, "s"]] }, session: {} };
			}
			return scanImpl(_env, calls);
		});
		const r = await mail_sieve_backfill.run(env, { dry_run: false });
		const p = JSON.parse(r.content![0].text as string);
		const junk = p.applied.find((a: any) => a.flag === "junk");
		const mailingList = p.applied.find((a: any) => a.flag === "mailing-list");
		expect(junk.count).toBe(0);
		expect(junk.error).toBeTruthy();
		expect(mailingList.count).toBe(1);
		expect(mailingList.error).toBeUndefined();
	});

	it("rejects a cursor issued for a different mailbox", async () => {
		const r1 = await mail_sieve_backfill.run(env, { max: 2 });
		const cursor = JSON.parse(r1.content![0].text as string).cursor;
		const r2 = await mail_sieve_backfill.run(env, { mailbox: "archive", cursor });
		expect(r2.isError).toBe(true);
		expect(r2.content![0].text).toContain("different mailbox");
	});

	it("returns not_found for an unknown mailbox, mutating nothing", async () => {
		const r = await mail_sieve_backfill.run(env, { mailbox: "no-such-folder", dry_run: false });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_found");
		expect(runBatch).toHaveBeenCalledTimes(1); // only the Mailbox/get lookup
	});

	it("returns not_configured when FASTMAIL_TOKEN is absent, before any JMAP call", async () => {
		const r = await mail_sieve_backfill.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("maps a JmapError from the engine to its FailCode", async () => {
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Mailbox/get") return scanImpl(_env, calls);
			throw new JmapError("rate_limited", "JMAP rate-limited (429).");
		});
		const r = await mail_sieve_backfill.run(env, {});
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("rate_limited");
	});
});
