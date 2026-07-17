import { beforeEach, describe, expect, it, vi } from "vitest";
import { mail_triage_plan } from "./mail_triage_plan";

const searchRun = vi.fn();
vi.mock("../mail-mcp", () => ({ MAIL_TOOLS: [{ name: "mail_search", run: (...args: unknown[]) => searchRun(...args) }] }));

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

describe("mail_triage_plan", () => {
	beforeEach(() => {
		searchRun.mockReset();
		runVerb.mockReset();
	});

	it("fetches a page of inbox messages and starts a durable run of mail-triage-plan", async () => {
		searchRun.mockResolvedValueOnce({
			content: [{ type: "text", text: JSON.stringify({ emails: [{ id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery!", preview: "p", labels: ["Inbox"] }] }) }],
		});
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await mail_triage_plan.run({} as any, { mailbox: "inbox", max: 10 });

		expect(searchRun).toHaveBeenCalledWith({}, { mailbox: "inbox", unread: true, limit: 10 });
		expect(runVerb).toHaveBeenCalledWith({ op: "mail-triage-plan", input: [{ id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery!", preview: "p", mailboxes: ["Inbox"] }], mode: "durable" }, {});
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ mailbox: "inbox", scanned: 1, instanceId: "abc123" });
	});

	it("skips starting a run when there is nothing to triage", async () => {
		searchRun.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ emails: [] }) }] });

		const res = await mail_triage_plan.run({} as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ mailbox: "inbox", scanned: 0, note: "no messages to triage" });
	});

	it("surfaces a mail_search failure as an upstream_error", async () => {
		searchRun.mockResolvedValueOnce({ content: [{ type: "text", text: "boom" }], isError: true });

		const res = await mail_triage_plan.run({} as any, {});

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("boom");
	});
});
