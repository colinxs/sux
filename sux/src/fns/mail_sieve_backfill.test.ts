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
