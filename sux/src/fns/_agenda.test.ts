import { describe, expect, it, vi } from "vitest";
import { composeDigest, type AgendaDeps, type Drop, detectDrops, detectKnowledgeDrops, detectMonarchDrops, type EventRef, type MailRef, rankDropsLearned, runAgenda } from "./_agenda";
import { listProposals } from "../proposals";
import { recordOutcome } from "./_learning";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ AGENDA_ENABLED: "1", VAULT_TZ: "UTC", OAUTH_KV: kvStub(), ...extra }) as any;

const MAIL: MailRef[] = [
	{ id: "rx1", from: "pharmacy@uwmc.org", subject: "Your prescription is ready for pickup" },
	{ id: "pay1", from: "failed-payments@mail.anthropic.com", subject: "$14.77 payment to Anthropic was unsuccessful" },
	{ id: "med1", from: "no-reply@mychart.com", subject: "You have a new secure message" },
	{ id: "appt1", from: "scheduling@uw.edu", subject: "Your appointment has been rescheduled" },
	{ id: "bill1", from: "billing@chase.com", subject: "Your statement is ready" },
	{ id: "pers1", from: "jeanne@gmail.com", subject: "Hey!", preview: "can you call me sometime this week?" },
	{ id: "noise1", from: "newsletter@bloomberg.com", subject: "Can airports be zen?" },
];
const EVENTS: EventRef[] = [{ summary: "Intake appointment w/ Dr. Enoch", start: "2026-07-15T09:00:00" }];

const deps = (over: Partial<AgendaDeps> = {}): AgendaDeps => ({
	mailSearch: vi.fn(async () => MAIL),
	calEvents: vi.fn(async () => EVENTS),
	digestAppend: vi.fn(async () => {}),
	sendDigest: vi.fn(async () => {}),
	consolidateFindings: vi.fn(async () => null),
	weeklyRecallFindings: vi.fn(async () => null),
	monarchAccounts: vi.fn(async () => []),
	monarchTransactions: vi.fn(async () => []),
	monarchBudgets: vi.fn(async () => []),
	...over,
});

describe("agenda — detectors", () => {
	it("detects each drop kind from the mail+calendar stream, skips noise", () => {
		const drops = detectDrops(MAIL, EVENTS);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toContain("rx_ready");
		expect(kinds).toContain("payment_problem");
		expect(kinds).toContain("medical_message");
		expect(kinds).toContain("appointment");
		expect(kinds).toContain("bill_due");
		expect(kinds).toContain("unanswered"); // jeanne
		expect(kinds).toContain("appointment_cal"); // the calendar event
		expect(kinds).not.toContain("noise"); // the bloomberg newsletter raises nothing
		expect(drops).toHaveLength(7);
	});

	it("every drop's action is a reversible Todoist add (rung-0, no model)", () => {
		for (const d of detectDrops(MAIL, EVENTS)) {
			expect(d.action.fn).toBe("todoist");
			expect(d.action.args).toMatchObject({ action: "add" });
		}
	});

	it("ranks today-urgency (Rx, payment) ahead of soon/fyi", () => {
		const drops = detectDrops(MAIL, EVENTS);
		expect(drops[0].urgency).toBe("today");
		expect(drops[drops.length - 1].urgency).toBe("fyi"); // the unanswered personal note
	});

	it("wires consolidate + weekly_recall findings in as fyi drops, deduped per week", () => {
		const drops = detectKnowledgeDrops(
			{ week: "2026-W28", stale: [{ path: "Foo.md", reason: "no last_verified marker" }], duplicate_candidates: [{ a: "Foo.md", b: "Foo (2).md", key: "foo" }] },
			{ week: "2026-W28", questions: 3, content_hash: "abc" },
		);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toEqual(["consolidate_stale", "consolidate_dupes", "weekly_recall_ready"]);
		for (const d of drops) {
			expect(d.urgency).toBe("fyi");
			expect(d.dedupe).toContain("2026-W28");
			expect(d.action.fn).toBe("todoist");
		}
	});

	it("no knowledge drops when there's nothing to report", () => {
		expect(detectKnowledgeDrops(null, null)).toHaveLength(0);
		expect(detectKnowledgeDrops({ week: "2026-W28", stale: [], duplicate_candidates: [] }, { week: "2026-W28", questions: 0, content_hash: "abc" })).toHaveLength(0);
	});

	it("detects Monarch financial signals (W7): low balance, unusual charge, bill due soon", () => {
		const drops = detectMonarchDrops(
			"2026-07-28", // 3 days left in July
			[{ id: "acct1", name: "Checking", balance: 42.5 }],
			[{ id: "txn1", amount: -733.2, merchant: "Some LLC", date: "2026-07-27" }],
			[{ category: "Rent", categoryId: "cat1", remaining: 900 }],
		);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toEqual(expect.arrayContaining(["low_balance", "unusual_charge", "bill_due"]));
		for (const d of drops) {
			expect(d.action.fn).toBe("todoist");
			expect(d.action.args).toMatchObject({ action: "add" });
		}
	});

	it("Monarch: no drops when balances/charges/bills are all unremarkable", () => {
		const drops = detectMonarchDrops(
			"2026-07-05", // far from month-end
			[{ id: "acct1", name: "Checking", balance: 4200 }],
			[{ id: "txn1", amount: -12.5, merchant: "Coffee" }],
			[{ category: "Dining", categoryId: "cat2", remaining: 50 }],
		);
		expect(drops).toHaveLength(0);
	});

	it("Monarch: a bill-shaped budget category only surfaces near month-end", () => {
		const near = detectMonarchDrops("2026-07-30", [], [], [{ category: "Utilities", remaining: 60 }]);
		const far = detectMonarchDrops("2026-07-05", [], [], [{ category: "Utilities", remaining: 60 }]);
		expect(near.map((d) => d.kind)).toContain("bill_due");
		expect(far).toHaveLength(0);
	});

	it("Monarch: a large incoming deposit is not flagged as an unusual charge", () => {
		const drops = detectMonarchDrops(
			"2026-07-05",
			[],
			[{ id: "txn1", amount: 3200, merchant: "Employer Payroll" }],
			[],
		);
		expect(drops).toHaveLength(0);
	});
});

describe("agenda — learned ranking (W8)", () => {
	const drop = (kind: string, urgency: "today" | "soon" | "fyi"): Drop => ({
		kind,
		urgency,
		dedupe: `${kind}::x`,
		title: kind,
		emoji: "•",
		action: { fn: "todoist", args: { action: "add", content: kind } },
	});

	it("breaks ties WITHIN an urgency tier by learned weight, never crosses tiers", async () => {
		const e = { OAUTH_KV: kvStub() } as any;
		for (let i = 0; i < 5; i++) await recordOutcome(e, "liked_kind", "approved");
		for (let i = 0; i < 5; i++) await recordOutcome(e, "disliked_kind", "rejected");

		const drops = [drop("disliked_kind", "fyi"), drop("liked_kind", "fyi"), drop("neutral_kind", "today")];
		const ranked = await rankDropsLearned(e, drops);
		// "today" always sorts first regardless of weight.
		expect(ranked[0].kind).toBe("neutral_kind");
		// within "fyi", the approved kind outranks the rejected one.
		expect(ranked[1].kind).toBe("liked_kind");
		expect(ranked[2].kind).toBe("disliked_kind");
	});

	it("a rejected kind still gets ranked (never suppressed), just sorted lower", async () => {
		const e = { OAUTH_KV: kvStub() } as any;
		for (let i = 0; i < 50; i++) await recordOutcome(e, "very_disliked", "rejected");
		const ranked = await rankDropsLearned(e, [drop("very_disliked", "fyi")]);
		expect(ranked).toHaveLength(1);
		expect(ranked[0].kind).toBe("very_disliked");
	});
});

describe("agenda — digest", () => {
	it("empty → a calm 'nothing pressing' note", () => {
		const d = composeDigest("2026-07-13", []);
		expect(d.body).toMatch(/nothing's about to slip/i);
	});
	it("groups by urgency, shows short ids + the reply-syntax interface", () => {
		const d = composeDigest("2026-07-13", [{ proposalId: "abcdef1234", drop: detectDrops(MAIL, [])[0] }]);
		expect(d.subject).toMatch(/need/);
		expect(d.body).toContain("abcdef12"); // short id (first 8)
		expect(d.body).toMatch(/approve <id>/);
	});
});

describe("agenda — loop", () => {
	it("is dormant (no-op) unless AGENDA_ENABLED", async () => {
		const r = await runAgenda({ VAULT_TZ: "UTC", OAUTH_KV: kvStub() } as any, {}, deps());
		expect(r.dormant).toBe(true);
	});

	it("armed: detects, records a proposal per drop, appends the digest, does NOT email (AGENDA_EMAIL unset)", async () => {
		const e = env();
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.proposed).toBe(7);
		expect(r.digest_written).toBe(true);
		expect(r.emailed).toBe(false);
		expect(d.sendDigest).not.toHaveBeenCalled();
		expect(d.digestAppend).toHaveBeenCalledTimes(1);
		// the proposals are really recorded in the W1 queue
		expect((await listProposals(e)).length).toBe(7);
	});

	it("emails the digest to self only when AGENDA_EMAIL is armed", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.emailed).toBe(true);
		expect(d.sendDigest).toHaveBeenCalledTimes(1);
	});

	it("is idempotent — a second cycle re-proposes nothing (dedupe ledger)", async () => {
		const e = env();
		await runAgenda(e, {}, deps());
		const second = await runAgenda(e, {}, deps());
		expect(second.proposed).toBe(0);
		expect((await listProposals(e)).length).toBe(7); // unchanged
	});

	it("dry_run: detects + composes but records/sends nothing", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d = deps();
		const r = await runAgenda(e, { dry_run: true }, d);
		expect(r.drops_detected).toBe(7);
		expect(r.digest).toMatch(/about to slip/i);
		expect(d.digestAppend).not.toHaveBeenCalled();
		expect(d.sendDigest).not.toHaveBeenCalled();
		expect((await listProposals(e)).length).toBe(0); // nothing recorded
	});

	it("a source failure degrades independently, never fatal", async () => {
		const e = env();
		const r = await runAgenda(e, {}, deps({ calEvents: vi.fn(async () => { throw new Error("caldav down"); }) }));
		expect(r.sources.calendar).toMatch(/unavailable/);
		expect(r.proposed).toBeGreaterThan(0); // mail drops still recorded
	});

	it("proposes a drop from consolidate/weekly_recall's cached findings alongside mail+calendar", async () => {
		const e = env();
		const d = deps({
			consolidateFindings: vi.fn(async () => ({ week: "2026-W28", stale: [{ path: "Foo.md", reason: "no last_verified marker" }], duplicate_candidates: [] })),
			weeklyRecallFindings: vi.fn(async () => ({ week: "2026-W28", questions: 3, content_hash: "abc" })),
		});
		const r = await runAgenda(e, {}, d);
		expect(r.proposed).toBe(9); // 7 mail/cal + consolidate_stale + weekly_recall_ready
		expect(r.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["consolidate_stale", "weekly_recall_ready"]));
	});

	it("wires Monarch financial signals (W7) in only when MONARCH_TOKEN is set", async () => {
		const e = env({ MONARCH_TOKEN: "tok" });
		const d = deps({
			monarchAccounts: vi.fn(async () => [{ id: "acct1", name: "Checking", balance: 10 }]),
			monarchTransactions: vi.fn(async () => []),
			monarchBudgets: vi.fn(async () => []),
		});
		const r = await runAgenda(e, {}, d);
		expect(r.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["low_balance"]));
		expect(r.sources.monarch).toMatch(/account/);
	});

	it("skips Monarch entirely (not_configured) when MONARCH_TOKEN is unset", async () => {
		const e = env();
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.sources.monarch).toBe("not_configured");
		expect(d.monarchAccounts).not.toHaveBeenCalled();
	});
});
