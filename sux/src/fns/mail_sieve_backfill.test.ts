import { beforeEach, describe, expect, it, vi } from "vitest";

const searchRun = vi.fn();
const labelMessages = vi.fn();

vi.mock("../mail-mcp", () => ({
	MAIL_TOOLS: [{ name: "mail_search", run: (...args: unknown[]) => searchRun(...args) }],
	labelMessages: (...args: unknown[]) => labelMessages(...args),
}));

import { mail_sieve_backfill } from "./mail_sieve_backfill";

const emails = [
	{ id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery! Claim your prize now" },
	{ id: "2", from: "newsletter@substack.com", subject: "Weekly roundup" },
	{ id: "3", from: "friend@gmail.com", subject: "lunch tomorrow?" },
];

const okResult = (body: unknown) => ({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });

beforeEach(() => {
	searchRun.mockReset();
	labelMessages.mockReset();
	searchRun.mockResolvedValue(okResult({ emails }));
	labelMessages.mockResolvedValue({ isError: false, content: [{ type: "text", text: "{}" }] });
});

describe("mail_sieve_backfill", () => {
	it("dry_run (default): reports matches and calls labelMessages zero times", async () => {
		const r = await mail_sieve_backfill.run({} as any, {});
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.dry_run).toBe(true);
		expect(parsed.would_tag).toBe(2); // messages 1 (junk) and 2 (mailing-list); 3 matches nothing
		expect(labelMessages).not.toHaveBeenCalled();
	});

	it("dry_run:false actually applies label:add via labelMessages, grouped by flag", async () => {
		const r = await mail_sieve_backfill.run({} as any, { dry_run: false });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.dry_run).toBe(false);
		expect(parsed.tagged).toBe(2);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["1"], "junk", true);
		expect(labelMessages).toHaveBeenCalledWith(expect.anything(), ["2"], "mailing-list", true);
	});

	it("rejects an unknown category before ever calling mail_search", async () => {
		const r = await mail_sieve_backfill.run({} as any, { categories: ["bogus"] });
		expect(r.isError).toBe(true);
		expect(searchRun).not.toHaveBeenCalled();
	});

	it("narrows to the requested categories only", async () => {
		const r = await mail_sieve_backfill.run({} as any, { categories: ["junk"] });
		const parsed = JSON.parse(r.content![0].text as string);
		expect(parsed.would_tag).toBe(1);
		expect(parsed.matches[0].flags).toEqual(["junk"]);
	});

	it("surfaces a mail_search failure as an upstream_error, mutating nothing", async () => {
		searchRun.mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] });
		const r = await mail_sieve_backfill.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(labelMessages).not.toHaveBeenCalled();
	});
});
