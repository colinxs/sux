import { beforeEach, describe, expect, it, vi } from "vitest";

// Two mock surfaces: the jmap engine (the scan) and mail-mcp's labelMessages (the write) — same
// shape as mail_domain_backfill.test.ts's mock, since mail_sieve_backfill now scans the same way.
const { runBatch, labelMessages } = vi.hoisted(() => ({ runBatch: vi.fn(), labelMessages: vi.fn() }));

vi.mock("./_jmap", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_jmap")>();
	return { ...actual, runBatch };
});
vi.mock("../mail-mcp", () => ({ labelMessages: (...args: unknown[]) => labelMessages(...args) }));

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

function scanImpl(_env: unknown, calls: any[]) {
	const method = calls[0][0];
	if (method === "Mailbox/get") return { response: { methodResponses: [["Mailbox/get", { list: [INBOX, ARCHIVE] }, "m"]] }, session: {} };
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
	runBatch.mockReset();
	labelMessages.mockReset();
	runBatch.mockImplementation(scanImpl);
	labelMessages.mockResolvedValue({ isError: false, content: [{ type: "text", text: "{}" }] });
});

describe("mail_sieve_backfill", () => {
	it("dry_run (default): reports matches and calls labelMessages zero times", async () => {
		const r = await mail_sieve_backfill.run(env, {});
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.dry_run).toBe(true);
		expect(parsed.would_tag).toBe(2); // messages 1 (junk) and 2 (mailing-list); 3 matches nothing
		expect(parsed.done).toBe(true);
		expect(parsed.cursor).toBeNull();
		expect(labelMessages).not.toHaveBeenCalled();
	});

	it("dry_run:false actually applies label:add via labelMessages, grouped by flag", async () => {
		const r = await mail_sieve_backfill.run(env, { dry_run: false });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.dry_run).toBe(false);
		expect(parsed.tagged).toBe(2);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["1"], "junk", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["2"], "mailing-list", true);
	});

	it("does not advance the resume cursor past a scan window with a failed label write", async () => {
		labelMessages.mockImplementation(async (_env: unknown, _ids: string[], flag: string) => {
			if (flag === "mailing-list") return { isError: true, content: [{ type: "text", text: "JMAP write failed" }] };
			return { isError: false, content: [{ type: "text", text: "{}" }] };
		});
		const r = await mail_sieve_backfill.run(env, { dry_run: false });
		const p = JSON.parse(r.content![0].text as string);
		expect(p.applied).toEqual(
			expect.arrayContaining([
				{ flag: "junk", count: 1 },
				{ flag: "mailing-list", count: 0, error: "JMAP write failed" },
			]),
		);
		expect(p.done).toBe(false);
		expect(typeof p.cursor).toBe("string");

		// Resuming with the returned cursor re-scans from the START of this call's window
		// (position 0), not past the failed flag's messages.
		labelMessages.mockClear();
		labelMessages.mockResolvedValue({ isError: false, content: [{ type: "text", text: "{}" }] });
		const r2 = await mail_sieve_backfill.run(env, { dry_run: false, cursor: p.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(3); // re-scanned ids 1,2,3 from position 0
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["2"], "mailing-list", true);
	});

	it("rejects an unknown category before ever calling the jmap engine", async () => {
		const r = await mail_sieve_backfill.run(env, { categories: ["bogus"] });
		expect(r.isError).toBe(true);
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("narrows to the requested categories only", async () => {
		const r = await mail_sieve_backfill.run(env, { categories: ["junk"] });
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.would_tag).toBe(1);
		expect(parsed.matches[0].flags).toEqual(["junk"]);
	});

	it("is resumable: a bounded max returns a cursor + done:false, and the cursor resumes the sweep", async () => {
		const r1 = await mail_sieve_backfill.run(env, { max: 2 });
		const p1 = JSON.parse(r1.content![0].text as string);
		expect(p1.scanned).toBe(2); // ids 1,2
		expect(p1.done).toBe(false);
		expect(typeof p1.cursor).toBe("string");
		expect(p1.would_tag).toBe(2);

		const r2 = await mail_sieve_backfill.run(env, { max: 2, cursor: p1.cursor });
		const p2 = JSON.parse(r2.content![0].text as string);
		expect(p2.scanned).toBe(1); // id 3 — resumed at position 2
		expect(p2.would_tag).toBe(0);
		expect(p2.done).toBe(true);
	});

	it("chunks writes per internal page within ONE call, instead of one Email/set for the whole scan window", async () => {
		// Regression test for the un-chunked/late-write bug (R-002): the buggy version accumulated
		// `byFlag` across every loop iteration of a single call and issued ONE Email/set per flag
		// only after the whole while-loop finished scanning. That means a flag spanning many pages
		// got batched into a single write that could exceed JMAP's maxObjectsInSet, AND the
		// resume cursor (already advanced past every scanned page) could never re-visit a page
		// whose write failed. Internal loop iterations only happen when max > PAGE (200), so this
		// uses a 250-message fixture (id "1" on page 1, id "201" on page 2 — a genuine 2nd
		// Email/query/get round-trip, not a mocking artifact) with both matching "junk".
		const CLEAN = { id: "", from: [{ email: "friend@gmail.com" }], subject: "lunch tomorrow?" };
		const BIG = Array.from({ length: 250 }, (_, i) => ({ ...CLEAN, id: String(i + 1) }));
		BIG[0] = { id: "1", from: [{ email: "prize@sketchy.tld" }], subject: "You WON the lottery!" };
		BIG[200] = { id: "201", from: [{ email: "prize@sketchy.tld" }], subject: "FINAL notice: claim your prize" };
		const queryPositions: number[] = [];
		runBatch.mockImplementation((_env: unknown, calls: any[]) => {
			if (calls[0][0] === "Mailbox/get") return scanImpl(_env, calls);
			const { position, limit } = calls[0][1];
			queryPositions.push(position);
			const page = BIG.slice(position, position + limit);
			return {
				response: {
					methodResponses: [
						["Email/query", { ids: page.map((e) => e.id), total: BIG.length, position, queryState: "qs" }, "q"],
						["Email/get", { list: page }, "g"],
					],
				},
				session: {},
			};
		});
		const junkCalls: string[][] = [];
		labelMessages.mockImplementation(async (_env: unknown, ids: string[], flag: string) => {
			if (flag === "junk") junkCalls.push(ids);
			return { isError: false, content: [{ type: "text", text: "{}" }] };
		});

		const r = await mail_sieve_backfill.run(env, { dry_run: false, max: 250 });
		const p = JSON.parse(r.content![0].text as string);

		expect(queryPositions).toEqual([0, 200]); // confirms 2 genuine internal page iterations
		// Chunked: two SEPARATE per-page writes (["1"] then ["201"]), never one combined ["1","201"].
		expect(junkCalls).toEqual([["1"], ["201"]]);
		expect(p.applied.find((a: any) => a.flag === "junk").count).toBe(2);
		expect(p.done).toBe(true);
	});

	it("a write failure on one page doesn't drop the whole run — later pages still apply and report their own errors", async () => {
		labelMessages.mockImplementation(async (_env: unknown, ids: string[], flag: string) => {
			if (flag === "junk") return { isError: true, content: [{ type: "text", text: "Email/set rejected (too many ids)" }] };
			return { isError: false, content: [{ type: "text", text: "{}" }] };
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
		expect(labelMessages).not.toHaveBeenCalled();
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
