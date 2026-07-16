import { beforeEach, describe, expect, it, vi } from "vitest";

// Two mock surfaces: the jmap engine (the scan) and mail-mcp's labelMessages (the write). The
// _jmap mock keeps everything real EXCEPT runBatch (so `JmapError instanceof` still works in the fn
// and in these tests), stubbing only the JMAP round-trip with a canned Mailbox/get + a position-paged
// Email/query + Email/get over a small fixture.
const { runBatch, labelMessages } = vi.hoisted(() => ({ runBatch: vi.fn(), labelMessages: vi.fn() }));

vi.mock("./_jmap", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_jmap")>();
	return { ...actual, runBatch };
});
vi.mock("../mail-mcp", () => ({ labelMessages: (...args: unknown[]) => labelMessages(...args) }));

import { mail_domain_backfill } from "./mail_domain_backfill";
import { JmapError } from "./_jmap";

const env = { FASTMAIL_TOKEN: "t" } as any;

// id 1 → finance, 2 → shopping, 3 → edu+uw+cs, 4 → none (personal), 5 → gov.
const FIXTURE = [
	{ id: "1", from: [{ email: "alerts@email.chase.com" }] },
	{ id: "2", from: [{ email: "receipts@order.amazon.com" }] },
	{ id: "3", from: [{ name: "Prof X", email: "prof@cs.uw.edu" }] },
	{ id: "4", from: [{ email: "friend@gmail.com" }] },
	{ id: "5", from: [{ email: "noreply@irs.gov" }] },
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

describe("mail_domain_backfill", () => {
	it("dry_run (default): reports per-keyword counts, mutates nothing", async () => {
		const r = await mail_domain_backfill.run(env, {});
		expect(r.isError).toBeFalsy();
		const p = JSON.parse(r.content![0].text as string);
		expect(p.dry_run).toBe(true);
		expect(p.scanned).toBe(5);
		expect(p.tagged).toBe(4); // 1,2,3,5 tag; 4 (gmail) does not
		expect(p.per_keyword).toEqual({ finance: 1, shopping: 1, edu: 1, uw: 1, cs: 1, gov: 1 });
		expect(p.done).toBe(true);
		expect(p.cursor).toBeNull();
		expect(labelMessages).not.toHaveBeenCalled();
	});

	it("dry_run:false applies reversible keyword-adds via labelMessages, grouped by keyword", async () => {
		const r = await mail_domain_backfill.run(env, { dry_run: false });
		expect(r.isError).toBeFalsy();
		const p = JSON.parse(r.content![0].text as string);
		expect(p.dry_run).toBe(false);
		expect(p.tagged).toBe(4);
		expect(p.done).toBe(true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["1"], "finance", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["2"], "shopping", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["3"], "edu", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["3"], "uw", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["3"], "cs", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["5"], "gov", true);
		// The personal sender (id 4) is never labeled.
		expect(labelMessages).not.toHaveBeenCalledWith(expect.anything(), ["4"], expect.anything(), true);
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
		expect(p2.scanned).toBe(2); // ids 3,4 — resumed at position 2
		expect(p2.per_keyword).toEqual({ edu: 1, uw: 1, cs: 1 });
		expect(p2.done).toBe(false);
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
		expect(labelMessages).not.toHaveBeenCalled();
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
