import { describe, expect, it, vi } from "vitest";
import { composeDigest, type AgendaDeps, type Drop, detectCrossSemanticDrops, detectDocumentExpiryDrops, detectDrops, detectFollowUpDrops, detectKnowledgeDrops, detectMonarchDrops, detectMyChartDrops, detectMychartAllergyGapDrops, detectMychartConflictDrops, detectPortfolioDrops, detectRelationshipDrops, detectSavingsRateDrop, detectStudyReviewDrops, detectTextDrops, detectWatchDrops, computeSavingsRate, type EventRef, mailRelationshipThreads, type MailRef, type RelationshipBaseline, type TextThreadRef, rankDropsLearned, runAgenda } from "./_agenda";
import { listProposals } from "../proposals";
import { recordOutcome } from "./_learning";
import { readInferSignals } from "./_infer";

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
	mailRelationshipSearch: vi.fn(async () => []),
	calEvents: vi.fn(async () => EVENTS),
	digestAppend: vi.fn(async () => {}),
	sendDigest: vi.fn(async () => {}),
	consolidateFindings: vi.fn(async () => null),
	weeklyRecallFindings: vi.fn(async () => null),
	watchFindings: vi.fn(async () => null),
	studyTopics: vi.fn(async () => []),
	crossSemanticFindings: vi.fn(async () => null),
	monarchAccounts: vi.fn(async () => []),
	monarchTransactions: vi.fn(async () => []),
	monarchBudgets: vi.fn(async () => []),
	monarchCashflow: vi.fn(async () => null),
	monarchHoldings: vi.fn(async () => []),
	textThreads: vi.fn(async () => []),
	mychartSummary: vi.fn(async () => null),
	mychartConflicts: vi.fn(async () => []),
	mychartAllergyGaps: vi.fn(async () => []),
	trackedDocuments: vi.fn(async () => []),
	followUpThreads: vi.fn(async () => []),
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

	it("wires the watch sweep's changed pages in as fyi drops (#899), keyed on the new hash", () => {
		const drops = detectWatchDrops({
			checked_at: "2026-07-18T00:00:00.000Z",
			changed_count: 1,
			changed: [{ url: "https://example.com/price", label: "price watch", hash: "new-hash", previous_hash: "old-hash", checked_at: "2026-07-18T00:00:00.000Z" }],
		});
		expect(drops).toHaveLength(1);
		expect(drops[0]).toMatchObject({ kind: "watch_changed", urgency: "fyi" });
		expect(drops[0].dedupe).toContain("new-hash");
		expect(drops[0].title).toContain("price watch");
		expect(drops[0].action.fn).toBe("todoist");
	});

	it("no watch drops when there's nothing to report", () => {
		expect(detectWatchDrops(null)).toHaveLength(0);
		expect(detectWatchDrops({ checked_at: "2026-07-18T00:00:00.000Z", changed_count: 0, changed: [] })).toHaveLength(0);
	});

	it("wires studied topics due for review in as fyi drops (#1092), keyed on the review cycle", () => {
		const drops = detectStudyReviewDrops([{ topic: "thermodynamics", title: "Intro Thermo", learned_at: 1_700_000_000_000, cycle: 1 }]);
		expect(drops).toHaveLength(1);
		expect(drops[0]).toMatchObject({ kind: "study_review_due", urgency: "fyi" });
		expect(drops[0].dedupe).toBe("study_review::thermodynamics::1");
		expect(drops[0].title).toContain("thermodynamics");
		expect(drops[0].title).toContain("Intro Thermo");
		expect(drops[0].action.fn).toBe("todoist");
	});

	it("no study review drops when nothing is due", () => {
		expect(detectStudyReviewDrops([])).toHaveLength(0);
	});

	it("wires the cross-semantic sweep's findings in as an fyi drop (#785/#948), never auto-applying", () => {
		const drops = detectCrossSemanticDrops({
			week: "2026-W28",
			count: 2,
			links: [{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "Re: alpha kickoff", score: 0.9 }],
		});
		expect(drops).toHaveLength(1);
		expect(drops[0]).toMatchObject({ kind: "cross_semantic_ready", urgency: "fyi" });
		expect(drops[0].dedupe).toContain("2026-W28");
		expect(drops[0].title).toContain("2 cross-domain link candidate");
		expect(drops[0].action.fn).toBe("todoist");
		expect(drops[0].action.args.content).toContain("vault_cross_link_plan");
	});

	it("no cross-semantic drops when there's nothing to report", () => {
		expect(detectCrossSemanticDrops(null)).toHaveLength(0);
		expect(detectCrossSemanticDrops({ week: "2026-W28", count: 0, links: [] })).toHaveLength(0);
	});

	it("detects Monarch financial signals (W7): low balance, unusual charge, bill due soon", () => {
		const drops = detectMonarchDrops(
			"2026-07-28", // 3 days left in July
			[{ id: "acct1", name: "Checking", balance: 42.5, type: "depository" }],
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

	it("Monarch: low_balance ignores non-depository accounts (credit card/loan, #901)", () => {
		const drops = detectMonarchDrops(
			"2026-07-05",
			[
				{ id: "acct1", name: "Amex", balance: 42, type: "credit" },
				{ id: "acct2", name: "Mortgage", balance: 10, type: "loan" },
			],
			[],
			[],
		);
		expect(drops.map((d) => d.kind)).not.toContain("low_balance");
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

	it("Monarch: bill_due's dedupe key changes with the remaining amount, so a later worse reading isn't swallowed (#847)", () => {
		const early = detectMonarchDrops("2026-07-28", [], [], [{ category: "Rent", categoryId: "cat1", remaining: 100 }]);
		const later = detectMonarchDrops("2026-07-29", [], [], [{ category: "Rent", categoryId: "cat1", remaining: 900 }]);
		expect(early[0].dedupe).not.toBe(later[0].dedupe);
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

	it("Monarch: subscription creep flags a recurring merchant whose charge grew over time (#1059)", () => {
		const drops = detectMonarchDrops(
			"2026-07-28",
			[],
			[
				{ id: "t1", amount: -9.99, merchant: "Streamflix", date: "2026-05-28" },
				{ id: "t2", amount: -9.99, merchant: "Streamflix", date: "2026-06-28" },
				{ id: "t3", amount: -14.99, merchant: "Streamflix", date: "2026-07-28" },
			],
			[],
		);
		const creep = drops.find((d) => d.kind === "subscription_creep");
		expect(creep).toBeDefined();
		expect(creep?.evidence).toMatchObject({ merchant: "Streamflix", firstAmount: 9.99, latestAmount: 14.99, occurrences: 3 });
	});

	it("Monarch: subscription creep dedupes on the amount, not the latest transaction id, so a same-amount repeat next cycle doesn't re-propose (#1067)", () => {
		const drops1 = detectMonarchDrops(
			"2026-07-28",
			[],
			[
				{ id: "t1", amount: -9.99, merchant: "Streamflix", date: "2026-05-28" },
				{ id: "t2", amount: -9.99, merchant: "Streamflix", date: "2026-06-28" },
				{ id: "t3", amount: -14.99, merchant: "Streamflix", date: "2026-07-28" },
			],
			[],
		);
		// Next billing cycle: same already-flagged amount posts under a brand-new transaction id.
		const drops2 = detectMonarchDrops(
			"2026-08-28",
			[],
			[
				{ id: "t1", amount: -9.99, merchant: "Streamflix", date: "2026-05-28" },
				{ id: "t2", amount: -9.99, merchant: "Streamflix", date: "2026-06-28" },
				{ id: "t3", amount: -14.99, merchant: "Streamflix", date: "2026-07-28" },
				{ id: "t4-new-id", amount: -14.99, merchant: "Streamflix", date: "2026-08-28" },
			],
			[],
		);
		const dedupe1 = drops1.find((d) => d.kind === "subscription_creep")?.dedupe;
		const dedupe2 = drops2.find((d) => d.kind === "subscription_creep")?.dedupe;
		expect(dedupe1).toBeDefined();
		expect(dedupe2).toBe(dedupe1); // same amount ⇒ same dedupe key, regardless of transaction id
	});

	it("Monarch: subscription creep does not flag a flat recurring charge or too few occurrences", () => {
		const flat = detectMonarchDrops(
			"2026-07-28",
			[],
			[
				{ id: "t1", amount: -9.99, merchant: "Streamflix", date: "2026-05-28" },
				{ id: "t2", amount: -9.99, merchant: "Streamflix", date: "2026-06-28" },
				{ id: "t3", amount: -9.99, merchant: "Streamflix", date: "2026-07-28" },
			],
			[],
		);
		expect(flat.map((d) => d.kind)).not.toContain("subscription_creep");

		const tooFew = detectMonarchDrops(
			"2026-07-28",
			[],
			[
				{ id: "t1", amount: -9.99, merchant: "Streamflix", date: "2026-06-28" },
				{ id: "t2", amount: -14.99, merchant: "Streamflix", date: "2026-07-28" },
			],
			[],
		);
		expect(tooFew.map((d) => d.kind)).not.toContain("subscription_creep");
	});

	it("Monarch: subscription creep ignores a bill-sized recurring charge (already covered by bill_due)", () => {
		const drops = detectMonarchDrops(
			"2026-07-05",
			[],
			[
				{ id: "t1", amount: -900, merchant: "Landlord LLC", date: "2026-05-05" },
				{ id: "t2", amount: -900, merchant: "Landlord LLC", date: "2026-06-05" },
				{ id: "t3", amount: -1200, merchant: "Landlord LLC", date: "2026-07-05" },
			],
			[],
		);
		expect(drops.map((d) => d.kind)).not.toContain("subscription_creep");
	});

	it("Monarch: unusual_charge only scans its own recency window even when transactions span the wider subscription-creep lookback", () => {
		const drops = detectMonarchDrops(
			"2026-07-28",
			[],
			[{ id: "t1", amount: -733.2, merchant: "Old LLC", date: "2026-05-01" }],
			[],
		);
		expect(drops.map((d) => d.kind)).not.toContain("unusual_charge");
	});
});

describe("agenda — detectors: portfolio drift + savings rate (W7.1, #803)", () => {
	it("flags a concentrated position with no prior snapshot needed", () => {
		const drops = detectPortfolioDrops(
			"2026-07-18",
			[{ ticker: "AAPL", value: 8000 }, { ticker: "MSFT", value: 2000 }],
			null,
		);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toContain("portfolio_concentration");
		expect(kinds).not.toContain("portfolio_drift"); // nothing to compare against yet
	});

	it("flags drift once allocation has moved more than the threshold since the last check", () => {
		const prior = { AAPL: 0.5, MSFT: 0.5 };
		const drops = detectPortfolioDrops(
			"2026-07-18",
			[{ ticker: "AAPL", value: 9000 }, { ticker: "MSFT", value: 1000 }],
			prior,
		);
		expect(drops.map((d) => d.kind)).toContain("portfolio_drift");
	});

	it("a fully sold-off ticker still reads as drift (compares against 0)", () => {
		const prior = { AAPL: 0.5, MSFT: 0.5 };
		const drops = detectPortfolioDrops("2026-07-18", [{ ticker: "MSFT", value: 5000 }], prior);
		const drift = drops.find((d) => d.kind === "portfolio_drift" && (d.evidence as any)?.key === "AAPL");
		expect(drift).toBeTruthy();
	});

	it("no drops when allocation barely moves and nothing is concentrated", () => {
		const prior = { AAPL: 0.34, MSFT: 0.33, CASH: 0.33 };
		const drops = detectPortfolioDrops(
			"2026-07-18",
			[{ ticker: "AAPL", value: 3450 }, { ticker: "MSFT", value: 3350 }, { ticker: "CASH", value: 3200 }],
			prior,
		);
		expect(drops).toHaveLength(0);
	});

	it("computeSavingsRate derives from sumIncome/savings, not the undocumented raw field (#807)", () => {
		expect(computeSavingsRate({ sumIncome: 5000, savings: 1000, savingsRate: 999 })).toBeCloseTo(0.2);
		expect(computeSavingsRate({ savingsRate: 0.33 })).toBeCloseTo(0.33); // falls back w/o income
		expect(computeSavingsRate({})).toBeUndefined();
		expect(computeSavingsRate(null)).toBeUndefined();
	});

	it("detectSavingsRateDrop always flags a negative rate, even with no prior snapshot", () => {
		const drops = detectSavingsRateDrop("2026-07-03", -0.1, null);
		expect(drops.map((d) => d.kind)).toEqual(["savings_rate_negative"]);
	});

	it("detectSavingsRateDrop flags a sharp drop from the prior checked cycle", () => {
		const drops = detectSavingsRateDrop("2026-07-18", 0.05, 0.3);
		expect(drops.map((d) => d.kind)).toEqual(["savings_rate_drop"]);
	});

	it("detectSavingsRateDrop is quiet on a healthy, stable rate or when there's no reading", () => {
		expect(detectSavingsRateDrop("2026-07-18", 0.25, 0.3)).toHaveLength(0);
		expect(detectSavingsRateDrop("2026-07-18", undefined, 0.3)).toHaveLength(0);
	});

	it("detectSavingsRateDrop's dedupe key changes with the rate, so a materially worse same-month reading isn't swallowed (#847)", () => {
		const early = detectSavingsRateDrop("2026-07-05", -0.2, null);
		const later = detectSavingsRateDrop("2026-07-28", -0.35, null);
		expect(early[0].dedupe).not.toBe(later[0].dedupe);
	});
});

describe("agenda — text detectors (iMessage, #849)", () => {
	it("flags a thread whose last message was NOT from me", () => {
		const threads: TextThreadRef[] = [
			{ id: "1", contact: "+15551234", name: "Jeanne", lastText: "you around this weekend?", lastFromMe: false },
			{ id: "2", contact: "+15555678", lastText: "sounds good, see you then", lastFromMe: true },
		];
		const drops = detectTextDrops(threads);
		expect(drops.map((d) => d.kind)).toEqual(["unanswered_text"]);
		expect(drops[0].dedupe).toBe("reply_text::1::");
		expect(drops[0].urgency).toBe("fyi");
		expect(drops[0].action.fn).toBe("todoist");
		expect(drops[0].action.args).toMatchObject({ action: "add" });
	});

	it("dedupe key differs for two distinct unanswered texts on the same thread (#1045)", () => {
		const first = detectTextDrops([{ id: "42", contact: "+15551234", lastText: "you free tomorrow?", lastFromMe: false, lastMessageId: "100" }]);
		const second = detectTextDrops([{ id: "42", contact: "+15551234", lastText: "did you see my last text?", lastFromMe: false, lastMessageId: "137" }]);
		expect(first[0].dedupe).not.toBe(second[0].dedupe);
	});

	it("skips a thread whose last message is already from me, or whose sender is unknown (fail-closed)", () => {
		expect(detectTextDrops([{ id: "1", lastFromMe: true }])).toHaveLength(0);
		expect(detectTextDrops([{ id: "1" }])).toHaveLength(0); // lastFromMe undefined — can't tell, so skip
	});

	it("skips a last message that's a tapback/reaction placeholder, not real text (#852)", () => {
		expect(detectTextDrops([{ id: "1", lastFromMe: false, lastText: "[unparsed rich message]" }])).toHaveLength(0);
		expect(detectTextDrops([{ id: "1", lastFromMe: false, lastText: "" }])).toHaveLength(0);
		expect(detectTextDrops([{ id: "1", lastFromMe: false }])).toHaveLength(0); // no lastText at all
	});
});

describe("agenda — follow-up detector (sent mail awaiting reply, #1217)", () => {
	const NOW = Date.parse("2026-07-22T00:00:00Z");

	it("flags a thread whose last message was sent by me and is past the min-days wait", () => {
		const drops = detectFollowUpDrops(NOW, [
			{ id: "t1", subject: "Re: contract", to: "vendor@example.com", lastAt: "2026-07-10T00:00:00Z", lastFromMe: true },
		]);
		expect(drops.map((d) => d.kind)).toEqual(["follow_up"]);
		expect(drops[0].action.fn).toBe("todoist");
		expect(drops[0].action.args).toMatchObject({ action: "add" });
	});

	it("skips a thread that hasn't waited long enough, or whose last message was from them / unknown (fail-closed)", () => {
		expect(detectFollowUpDrops(NOW, [{ id: "t1", lastAt: "2026-07-20T00:00:00Z", lastFromMe: true }])).toHaveLength(0); // only 2d
		expect(detectFollowUpDrops(NOW, [{ id: "t1", lastAt: "2026-07-01T00:00:00Z", lastFromMe: false }])).toHaveLength(0); // they replied last
		expect(detectFollowUpDrops(NOW, [{ id: "t1", lastAt: "2026-07-01T00:00:00Z" }])).toHaveLength(0); // can't tell, skip
		expect(detectFollowUpDrops(NOW, [{ id: "t1", lastFromMe: true }])).toHaveLength(0); // no lastAt
	});

	it("dedupe key buckets by week so a sustained wait doesn't re-propose daily", () => {
		const a = detectFollowUpDrops(NOW, [{ id: "t1", lastAt: "2026-07-10T00:00:00Z", lastFromMe: true }]);
		const b = detectFollowUpDrops(Date.parse("2026-07-23T00:00:00Z"), [{ id: "t1", lastAt: "2026-07-10T00:00:00Z", lastFromMe: true }]);
		expect(a[0].dedupe).toBe(b[0].dedupe);
	});
});

describe("agenda — MyChart detectors (W6)", () => {
	it("flags lab/vital results, refills due, new conditions/documents — every drop stays redacted", () => {
		const drops = detectMyChartDrops(
			[{ id: "obs1", category: "laboratory", direction: "high" }],
			[{ id: "med1", name: "Atorvastatin", dueDate: "2026-07-25" }],
			[{ id: "cond1" }],
			[{ id: "doc1", docType: "After Visit Summary" }],
		);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toEqual(expect.arrayContaining(["mychart_lab_flag", "mychart_refill_due", "mychart_new_condition", "mychart_new_document"]));
		for (const d of drops) expect(d.action.fn).toBe("todoist");
		const labDrop = drops.find((d) => d.kind === "mychart_lab_flag");
		expect(labDrop?.title).not.toMatch(/\d/); // no raw lab value leaks into the digest line
		const condDrop = drops.find((d) => d.kind === "mychart_new_condition");
		expect(condDrop?.title).toBe("New condition added to your chart — check MyChart"); // never the diagnosis name
	});

	it("dedupe is purely per resource id (no date) — a still-flagged result only ever proposes once", () => {
		const first = detectMyChartDrops([{ id: "obs1", category: "laboratory", direction: "low" }], [], [], []);
		const second = detectMyChartDrops([{ id: "obs1", category: "laboratory", direction: "low" }], [], [], []);
		expect(first[0].dedupe).toBe(second[0].dedupe);
	});

	it("no drops when the summary is empty", () => {
		expect(detectMyChartDrops([], [], [], [])).toHaveLength(0);
	});
});

describe("agenda — MyChart cross-org reconciliation detector (#1005)", () => {
	it("flags a cross-org medication/allergy overlap with a non-diagnostic, org-labeled title", () => {
		const drops = detectMychartConflictDrops([{ medOrg: "uwmedicine", medId: "med1", medName: "Penicillin V", allergyOrg: "swedish", allergyId: "al1", allergySubstance: "Penicillin" }]);
		expect(drops).toHaveLength(1);
		expect(drops[0].kind).toBe("mychart_conflict");
		expect(drops[0].title).toContain("Penicillin V");
		expect(drops[0].title).toMatch(/verify with your provider/i);
		expect(drops[0].action.fn).toBe("todoist");
	});

	it("dedupe is the med+allergy resource-id pair — a still-flagged overlap only ever proposes once", () => {
		const conflict = { medOrg: "uwmedicine", medId: "med1", medName: "Penicillin V", allergyOrg: "swedish", allergyId: "al1", allergySubstance: "Penicillin" };
		const first = detectMychartConflictDrops([conflict]);
		const second = detectMychartConflictDrops([conflict]);
		expect(first[0].dedupe).toBe(second[0].dedupe);
	});

	it("no drops when there are no conflicts", () => {
		expect(detectMychartConflictDrops([])).toHaveLength(0);
	});
});

describe("agenda — MyChart one-sided allergy-gap detector (#1009)", () => {
	it("flags an allergy on file at one org missing at another, with a non-diagnostic, org-labeled title", () => {
		const drops = detectMychartAllergyGapDrops([{ org: "uwmedicine", allergyId: "al1", allergySubstance: "Penicillin", missingOrg: "swedish" }]);
		expect(drops).toHaveLength(1);
		expect(drops[0].kind).toBe("mychart_allergy_gap");
		expect(drops[0].title).toContain("Penicillin");
		expect(drops[0].action.fn).toBe("todoist");
	});

	it("dedupe is the org+allergy+missingOrg key — a still-flagged gap only ever proposes once", () => {
		const gap = { org: "uwmedicine", allergyId: "al1", allergySubstance: "Penicillin", missingOrg: "swedish" };
		const first = detectMychartAllergyGapDrops([gap]);
		const second = detectMychartAllergyGapDrops([gap]);
		expect(first[0].dedupe).toBe(second[0].dedupe);
	});

	it("no drops when there are no gaps", () => {
		expect(detectMychartAllergyGapDrops([])).toHaveLength(0);
	});
});

describe("agenda — document-expiry radar detector (#1148)", () => {
	it("flags a document expiring within the default 30-day window as urgency 'soon'", () => {
		const drops = detectDocumentExpiryDrops("2026-07-01", [{ path: "Documents/passport.md", docType: "passport", expiryDate: "2026-07-20" }]);
		expect(drops).toHaveLength(1);
		expect(drops[0].kind).toBe("document_expiry");
		expect(drops[0].urgency).toBe("soon");
		expect(drops[0].title).toContain("passport");
		expect(drops[0].action.fn).toBe("todoist");
	});

	it("flags a document expiring within 7 days as urgency 'today'", () => {
		const drops = detectDocumentExpiryDrops("2026-07-01", [{ path: "Documents/license.md", docType: "drivers_license", expiryDate: "2026-07-05" }]);
		expect(drops[0].urgency).toBe("today");
	});

	it("flags an already-expired document", () => {
		const drops = detectDocumentExpiryDrops("2026-07-10", [{ path: "Documents/warranty.md", docType: "warranty", expiryDate: "2026-07-01" }]);
		expect(drops).toHaveLength(1);
		expect(drops[0].title).toContain("expired");
		expect(drops[0].evidence).toMatchObject({ daysLeft: -9 });
	});

	it("ignores a document with no expiry date, and one expiring well outside the window", () => {
		const drops = detectDocumentExpiryDrops("2026-07-01", [
			{ path: "Documents/a.md", docType: "insurance" },
			{ path: "Documents/b.md", docType: "registration", expiryDate: "2027-01-01" },
		]);
		expect(drops).toHaveLength(0);
	});

	it("dedupe includes the expiry date — a renewed document (new expiry_date) proposes again", () => {
		const first = detectDocumentExpiryDrops("2026-07-01", [{ path: "Documents/passport.md", expiryDate: "2026-07-20" }]);
		const renewedButStillDueSoon = detectDocumentExpiryDrops("2026-07-01", [{ path: "Documents/passport.md", expiryDate: "2026-07-25" }]);
		expect(first[0].dedupe).not.toBe(renewedButStillDueSoon[0].dedupe);
	});
});

describe("agenda — relationship-decay detector (Relationship Radar, #930)", () => {
	it("a thread tracked for the first time just seeds a baseline — no drop, no established cadence yet", () => {
		const threads: TextThreadRef[] = [{ id: "t1", contact: "+1555", name: "Mom", lastAt: "2026-06-01T00:00:00Z" }];
		const r = detectRelationshipDrops(Date.parse("2026-07-01T00:00:00Z"), threads, {});
		expect(r.drops).toHaveLength(0);
		expect(r.baselines.t1).toEqual({ lastAt: "2026-06-01T00:00:00Z", baselineDays: 0, sampleCount: 0 });
	});

	it("a fresh message refines (never flags) the baseline the same cycle it lands", () => {
		const prior: Record<string, RelationshipBaseline> = { t1: { lastAt: "2026-06-01T00:00:00Z", baselineDays: 0, sampleCount: 0 } };
		const threads: TextThreadRef[] = [{ id: "t1", contact: "+1555", name: "Mom", lastAt: "2026-06-04T00:00:00Z" }];
		const r = detectRelationshipDrops(Date.parse("2026-06-04T00:00:00Z"), threads, prior);
		expect(r.drops).toHaveLength(0);
		expect(r.baselines.t1).toEqual({ lastAt: "2026-06-04T00:00:00Z", baselineDays: 3, sampleCount: 1 });
	});

	it("flags a thread whose current silence significantly exceeds ITS OWN established baseline", () => {
		const prior: Record<string, RelationshipBaseline> = { t1: { lastAt: "2026-06-01T00:00:00Z", baselineDays: 3, sampleCount: 5 } };
		const threads: TextThreadRef[] = [{ id: "t1", contact: "+1555", name: "Mom", lastAt: "2026-06-01T00:00:00Z" }]; // unchanged — still silent
		const r = detectRelationshipDrops(Date.parse("2026-06-18T00:00:00Z"), threads, prior); // 17d quiet, baseline ~3d
		expect(r.drops.map((d) => d.kind)).toEqual(["relationship_drop"]);
		expect(r.drops[0].title).toMatch(/Mom/);
	});

	it("never a fixed global threshold — the same absolute silence is fine for a naturally low-cadence contact", () => {
		const prior: Record<string, RelationshipBaseline> = { t1: { lastAt: "2026-06-01T00:00:00Z", baselineDays: 20, sampleCount: 5 } };
		const threads: TextThreadRef[] = [{ id: "t1", contact: "+1555", lastAt: "2026-06-01T00:00:00Z" }];
		const r = detectRelationshipDrops(Date.parse("2026-06-26T00:00:00Z"), threads, prior); // 25d quiet, but baseline is ~20d
		expect(r.drops).toHaveLength(0);
	});

	it("stays quiet within a contact's own normal cadence, even past the absolute floor", () => {
		const prior: Record<string, RelationshipBaseline> = { t1: { lastAt: "2026-06-01T00:00:00Z", baselineDays: 3, sampleCount: 5 } };
		const threads: TextThreadRef[] = [{ id: "t1", contact: "+1555", lastAt: "2026-06-01T00:00:00Z" }];
		const r = detectRelationshipDrops(Date.parse("2026-06-05T00:00:00Z"), threads, prior); // 4d quiet, under both 2x baseline (6) and the 5d floor
		expect(r.drops).toHaveLength(0);
	});

	it("never fires for a thread with no established baseline yet, however long silent", () => {
		const prior: Record<string, RelationshipBaseline> = { t1: { lastAt: "2026-01-01T00:00:00Z", baselineDays: 0, sampleCount: 0 } };
		const threads: TextThreadRef[] = [{ id: "t1", contact: "+1555", lastAt: "2026-01-01T00:00:00Z" }];
		const r = detectRelationshipDrops(Date.parse("2026-07-19T00:00:00Z"), threads, prior); // ~200d, but sampleCount is 0
		expect(r.drops).toHaveLength(0);
	});
});

describe("agenda — mailRelationshipThreads (#981, widening Relationship Radar beyond iMessage)", () => {
	it("turns a personal-classified sender into a mail:-prefixed TextThreadRef", () => {
		const mail: MailRef[] = [{ id: "m1", from: "Jeanne <jeanne@gmail.com>", subject: "Hey!", preview: "how are you", date: "2026-06-01T00:00:00Z" }];
		const out = mailRelationshipThreads(mail);
		expect(out).toEqual([{ id: "mail:jeanne@gmail.com", contact: "jeanne@gmail.com", name: "Jeanne", lastAt: "2026-06-01T00:00:00Z" }]);
	});

	it("skips non-personal senders (a notification/bank domain) — precision over recall, same as isPersonal elsewhere", () => {
		const mail: MailRef[] = [{ id: "m1", from: "alerts@chase.com", subject: "Your statement is ready", date: "2026-06-01T00:00:00Z" }];
		expect(mailRelationshipThreads(mail)).toHaveLength(0);
	});

	it("collapses multiple messages from the same sender to one entry — the latest date wins", () => {
		const mail: MailRef[] = [
			{ id: "m1", from: "jeanne@gmail.com", subject: "Hey!", preview: "call me?", date: "2026-06-01T00:00:00Z" },
			{ id: "m2", from: "jeanne@gmail.com", subject: "Re: Hey!", preview: "call me?", date: "2026-06-10T00:00:00Z" },
		];
		const out = mailRelationshipThreads(mail);
		expect(out).toHaveLength(1);
		expect(out[0].lastAt).toBe("2026-06-10T00:00:00Z");
	});

	it("feeds straight into detectRelationshipDrops's per-contact cadence, same as an iMessage thread", () => {
		const prior: Record<string, RelationshipBaseline> = { "mail:jeanne@gmail.com": { lastAt: "2026-06-01T00:00:00Z", baselineDays: 3, sampleCount: 5 } };
		const threads = mailRelationshipThreads([{ id: "m1", from: "Jeanne <jeanne@gmail.com>", subject: "Hey!", preview: "call me?", date: "2026-06-01T00:00:00Z" }]);
		const r = detectRelationshipDrops(Date.parse("2026-06-18T00:00:00Z"), threads, prior); // 17d quiet, baseline ~3d
		expect(r.drops.map((d) => d.kind)).toEqual(["relationship_drop"]);
		expect(r.drops[0].title).toMatch(/Jeanne/);
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

	it("records 'digest (vault only)' in the vault note when the send fails, not 'digest emailed' (#1089)", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d = deps({ sendDigest: vi.fn(async () => { throw new Error("no primary identity"); }) });
		const r = await runAgenda(e, {}, d);
		expect(r.emailed).toBe(false);
		expect(r.digest_written).toBe(true);
		const written = (d.digestAppend as any).mock.calls[0][2] as string;
		expect(written).toContain("digest (vault only)");
		expect(written).not.toContain("digest emailed");
	});

	it("ledgers the sent digest's Message-ID so _agenda_reply.ts can thread-match a later reply", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d = deps({ sendDigest: vi.fn(async () => ({ messageId: "abc123@fastmail.com" })) });
		await runAgenda(e, {}, d);
		expect(e.OAUTH_KV.map.get("sux:ledger:agenda_digest_msgid:abc123@fastmail.com")).toBe("1");
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

	it("proposes a drop from the watch sweep's cached findings alongside mail+calendar (#899)", async () => {
		const e = env();
		const d = deps({
			watchFindings: vi.fn(async () => ({
				checked_at: "2026-07-18T00:00:00.000Z",
				changed_count: 1,
				changed: [{ url: "https://example.com/price", hash: "new-hash", previous_hash: "old-hash", checked_at: "2026-07-18T00:00:00.000Z" }],
			})),
		});
		const r = await runAgenda(e, {}, d);
		expect(r.proposed).toBe(8); // 7 mail/cal + watch_changed
		expect(r.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["watch_changed"]));
		expect(r.sources.watch).toMatch(/1 changed/);
	});

	it("wires Monarch financial signals (W7) in only when MONARCH_TOKEN is set", async () => {
		const e = env({ MONARCH_TOKEN: "tok" });
		const d = deps({
			monarchAccounts: vi.fn(async () => [{ id: "acct1", name: "Checking", balance: 10, type: "depository" }]),
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

	it("wires iMessage unanswered-text signals (#849) in only when IMESSAGE_URL/SECRET are set", async () => {
		const e = env({ IMESSAGE_URL: "https://mac.ts.net", IMESSAGE_SECRET: "s".repeat(20) });
		const d = deps({ textThreads: vi.fn(async () => [{ id: "t1", contact: "+15551234", name: "Jeanne", lastText: "you around?", lastFromMe: false }]) });
		const r = await runAgenda(e, {}, d);
		expect(r.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["unanswered_text"]));
		expect(r.sources.imessage).toMatch(/thread/);
	});

	it("skips iMessage entirely (not_configured) when IMESSAGE_URL/SECRET are unset", async () => {
		const e = env();
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.sources.imessage).toBe("not_configured");
		expect(d.textThreads).not.toHaveBeenCalled();
	});

	it("wires relationship-decay signals in across cycles, once a thread's baseline is established (#930)", async () => {
		const e = env({ IMESSAGE_URL: "https://mac.ts.net", IMESSAGE_SECRET: "s".repeat(20) });
		// Cycle 1 — first ever sighting: just seeds the baseline, no drop.
		await runAgenda(e, { date: "2026-06-01" }, deps({ textThreads: vi.fn(async () => [{ id: "t1", contact: "+15551234", name: "Mom", lastFromMe: true, lastAt: "2026-06-01T12:00:00Z" }]) }));
		// Cycle 2 — a new message lands 3 days later: refines the baseline (~3d), no drop yet.
		const r2 = await runAgenda(e, { date: "2026-06-04" }, deps({ textThreads: vi.fn(async () => [{ id: "t1", contact: "+15551234", name: "Mom", lastFromMe: true, lastAt: "2026-06-04T12:00:00Z" }]) }));
		expect(r2.proposals?.map((p) => p.kind)).not.toContain("relationship_drop");
		expect(e.OAUTH_KV.map.get("sux:ledger:agenda_relationship:t1")).toContain("\"sampleCount\":1");
		// Cycle 3 — 20 days of silence since, way past the ~3d baseline: fires.
		const r3 = await runAgenda(e, { date: "2026-06-24" }, deps({ textThreads: vi.fn(async () => [{ id: "t1", contact: "+15551234", name: "Mom", lastFromMe: true, lastAt: "2026-06-04T12:00:00Z" }]) }));
		expect(r3.proposals?.map((p) => p.kind)).toContain("relationship_drop");
	});

	it("keeps tracking a mail contact's cadence via mailRelationshipSearch even once their message is read, not the unread-only mailSearch stream (#1133)", async () => {
		const e = env();
		// mailSearch (unread inbox) is empty — as if the contact's message has already been read —
		// while mailRelationshipSearch (recent-window, not unread-gated) still sees it.
		const jeanne = { id: "m1", from: "Jeanne <jeanne@gmail.com>", subject: "Hey!", preview: "how's it going", date: "2026-06-01T12:00:00Z" };
		await runAgenda(e, { date: "2026-06-01" }, deps({ mailSearch: vi.fn(async () => []), mailRelationshipSearch: vi.fn(async () => [jeanne]) }));
		expect(e.OAUTH_KV.map.get("sux:ledger:agenda_relationship:mail:jeanne@gmail.com")).toContain("\"sampleCount\":0");
		// Next cycle: still unread-empty via mailSearch, but mailRelationshipSearch sees a fresh message
		// from the same contact — the baseline refines instead of freezing.
		await runAgenda(e, { date: "2026-06-04" }, deps({ mailSearch: vi.fn(async () => []), mailRelationshipSearch: vi.fn(async () => [{ ...jeanne, date: "2026-06-04T12:00:00Z" }]) }));
		expect(e.OAUTH_KV.map.get("sux:ledger:agenda_relationship:mail:jeanne@gmail.com")).toContain("\"sampleCount\":1");
	});

	it("dry_run never persists the relationship baseline", async () => {
		const e = env({ IMESSAGE_URL: "https://mac.ts.net", IMESSAGE_SECRET: "s".repeat(20) });
		await runAgenda(e, { date: "2026-06-01" }, deps({ textThreads: vi.fn(async () => [{ id: "t1", contact: "+15551234", lastFromMe: true, lastAt: "2026-06-01T12:00:00Z" }]) }));
		// This cycle would refine the baseline to ~3d, but it's a dry run — must not persist.
		await runAgenda(e, { date: "2026-06-04", dry_run: true }, deps({ textThreads: vi.fn(async () => [{ id: "t1", contact: "+15551234", lastFromMe: true, lastAt: "2026-06-04T12:00:00Z" }]) }));
		expect(e.OAUTH_KV.map.get("sux:ledger:agenda_relationship:t1")).toContain("\"sampleCount\":0");
	});

	it("wires Monarch portfolio + savings-rate signals (W7.1, #803) in only when MONARCH_TOKEN is set", async () => {
		const e = env({ MONARCH_TOKEN: "tok" });
		const d = deps({
			monarchHoldings: vi.fn(async () => [{ ticker: "AAPL", value: 9000 }, { ticker: "MSFT", value: 1000 }]),
			monarchCashflow: vi.fn(async () => ({ sumIncome: 1000, sumExpense: 1200, savings: -200, savingsRate: 999 })),
		});
		const r = await runAgenda(e, {}, d);
		expect(r.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["portfolio_concentration", "savings_rate_negative"]));
		expect(d.monarchHoldings).toHaveBeenCalled();
		expect(d.monarchCashflow).toHaveBeenCalled();
	});

	it("caches the Monarch snapshot across cycles so drift compares to the last check, not from scratch", async () => {
		const e = env({ MONARCH_TOKEN: "tok" });
		await runAgenda(e, { date: "2026-07-17" }, deps({ monarchHoldings: vi.fn(async () => [{ ticker: "AAPL", value: 5000 }, { ticker: "MSFT", value: 5000 }]) }));

		const r = await runAgenda(e, { date: "2026-07-18" }, deps({ monarchHoldings: vi.fn(async () => [{ ticker: "AAPL", value: 9000 }, { ticker: "MSFT", value: 1000 }]) }));
		expect(r.proposals?.map((p) => p.kind)).toContain("portfolio_drift");
	});

	it("wires MyChart health signals (W6) in only when EPIC_CLIENT_ID/SECRET/FHIR_BASE are set", async () => {
		const e = env({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", EPIC_FHIR_BASE: "https://fhir.example.org/R4" });
		const d = deps({ mychartSummary: vi.fn(async () => ({ labFlags: [{ id: "obs1", category: "laboratory", direction: "high" }], refillsDue: [], newConditions: [], newDocuments: [] })) });
		const r = await runAgenda(e, {}, d);
		expect(r.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["mychart_lab_flag"]));
		expect(r.sources.mychart).toMatch(/lab flag/);
		expect(d.mychartSummary).toHaveBeenCalled();
	});

	it("skips MyChart entirely (not_configured) when EPIC_* is unset", async () => {
		const e = env();
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.sources.mychart).toBe("not_configured");
		expect(d.mychartSummary).not.toHaveBeenCalled();
	});

	it("MyChart configured but never connected (no grant) reads as not_connected, no drops", async () => {
		const e = env({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", EPIC_FHIR_BASE: "https://fhir.example.org/R4" });
		const d = deps({ mychartSummary: vi.fn(async () => null) });
		const r = await runAgenda(e, {}, d);
		expect(r.sources.mychart).toBe("not_connected");
		expect(r.proposals?.map((p) => p.kind)).not.toContain("mychart_lab_flag");
	});

	it("wires cross-org MyChart conflicts (#1005) in only when MYCHART_RECONCILE_ENABLED is set", async () => {
		const e = env({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", MYCHART_RECONCILE_ENABLED: "1" });
		const d = deps({ mychartConflicts: vi.fn(async () => [{ medOrg: "uwmedicine", medId: "med1", medName: "Penicillin V", allergyOrg: "swedish", allergyId: "al1", allergySubstance: "Penicillin" }]) });
		const r = await runAgenda(e, {}, d);
		expect(r.proposals?.map((p) => p.kind)).toContain("mychart_conflict");
		expect(r.sources.mychart_reconcile).toMatch(/1 cross-org conflict/);
		expect(d.mychartConflicts).toHaveBeenCalled();
	});

	it("skips cross-org reconciliation (disabled) when MYCHART_RECONCILE_ENABLED is unset, even with MyChart configured", async () => {
		const e = env({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec" });
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.sources.mychart_reconcile).toBe("disabled");
		expect(d.mychartConflicts).not.toHaveBeenCalled();
	});

	it("skips cross-org reconciliation (not_configured) when the flag is set but EPIC_* is unset", async () => {
		const e = env({ MYCHART_RECONCILE_ENABLED: "1" });
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.sources.mychart_reconcile).toBe("not_configured");
		expect(d.mychartConflicts).not.toHaveBeenCalled();
	});

	it("wires cross-org MyChart allergy gaps (#1009) in only when MYCHART_RECONCILE_ENABLED is set", async () => {
		const e = env({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", MYCHART_RECONCILE_ENABLED: "1" });
		const d = deps({ mychartAllergyGaps: vi.fn(async () => [{ org: "uwmedicine", allergyId: "al1", allergySubstance: "Penicillin", missingOrg: "swedish" }]) });
		const r = await runAgenda(e, {}, d);
		expect(r.proposals?.map((p) => p.kind)).toContain("mychart_allergy_gap");
		expect(r.sources.mychart_reconcile).toMatch(/1 allergy gap/);
		expect(d.mychartAllergyGaps).toHaveBeenCalled();
	});

	it("skips cross-org allergy-gap detection when MYCHART_RECONCILE_ENABLED is unset", async () => {
		const e = env({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec" });
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(d.mychartAllergyGaps).not.toHaveBeenCalled();
	});

	it("dry_run never persists the Monarch snapshot", async () => {
		const e = env({ MONARCH_TOKEN: "tok" });
		await runAgenda(e, { date: "2026-07-17", dry_run: true }, deps({ monarchHoldings: vi.fn(async () => [{ ticker: "AAPL", value: 5000 }, { ticker: "MSFT", value: 5000 }]) }));

		const r = await runAgenda(e, { date: "2026-07-18" }, deps({ monarchHoldings: vi.fn(async () => [{ ticker: "AAPL", value: 9000 }, { ticker: "MSFT", value: 1000 }]) }));
		expect(r.proposals?.map((p) => p.kind)).not.toContain("portfolio_drift");
	});
});

describe("agenda — Monarch infer signal wiring (#1085)", () => {
	const TXNS = [
		{ id: "txn1", merchant: "Coffee Shop", amount: 4.5, date: "2026-07-17" },
		{ id: "txn2", merchant: "Grocery Store", amount: 62.1, date: "2026-07-17" },
	];

	it("does not feed the infer signal log when INFER_ARM_PURCHASES is unset (dormant by default)", async () => {
		const e = env({ MONARCH_TOKEN: "tok" });
		e.AI = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) };
		const d = deps({ monarchTransactions: vi.fn(async () => TXNS) });
		await runAgenda(e, {}, d);
		expect(e.AI.run).not.toHaveBeenCalled();
		expect(await readInferSignals(e, "purchases")).toEqual([]);
	});

	it("feeds a redacted, embedded signal per new transaction when INFER_ARM_PURCHASES is armed", async () => {
		const e = env({ MONARCH_TOKEN: "tok", INFER_ARM_PURCHASES: "1" });
		e.AI = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) };
		const d = deps({ monarchTransactions: vi.fn(async () => TXNS) });
		await runAgenda(e, {}, d);
		expect(e.AI.run).toHaveBeenCalledTimes(TXNS.length);
		const signals = await readInferSignals(e, "purchases");
		expect(signals).toHaveLength(TXNS.length);
		expect(signals.map((s) => s.source_tag).sort()).toEqual(TXNS.map((t) => `purchases:${t.id}`).sort());
	});

	it("does not re-log the same transaction across cycles (rolling-window dedupe)", async () => {
		const e = env({ MONARCH_TOKEN: "tok", INFER_ARM_PURCHASES: "1" });
		e.AI = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) };
		await runAgenda(e, { date: "2026-07-17" }, deps({ monarchTransactions: vi.fn(async () => TXNS) }));
		// Next cycle re-fetches the same rolling window (both txns still inside it) plus one new one.
		await runAgenda(e, { date: "2026-07-18" }, deps({ monarchTransactions: vi.fn(async () => [...TXNS, { id: "txn3", merchant: "Bookstore", amount: 18, date: "2026-07-18" }]) }));
		const signals = await readInferSignals(e, "purchases");
		expect(signals).toHaveLength(3);
	});

	it("dry_run never persists purchase signals", async () => {
		const e = env({ MONARCH_TOKEN: "tok", INFER_ARM_PURCHASES: "1" });
		e.AI = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) };
		await runAgenda(e, { dry_run: true }, deps({ monarchTransactions: vi.fn(async () => TXNS) }));
		expect(e.AI.run).not.toHaveBeenCalled();
		expect(await readInferSignals(e, "purchases")).toEqual([]);
	});

	it("a signal-log failure (e.g. AI down) is swallowed — the agenda cycle still completes", async () => {
		const e = env({ MONARCH_TOKEN: "tok", INFER_ARM_PURCHASES: "1" });
		e.AI = { run: vi.fn(async () => { throw new Error("AI unavailable"); }) };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const r = await runAgenda(e, {}, deps({ monarchTransactions: vi.fn(async () => TXNS) }));
		expect(r.digest_written).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/infer: purchases signal log failed/));
		warn.mockRestore();
	});
});

describe("agenda — defaultDeps.monarchTransactions pagination (#1097)", () => {
	const page = (ids: number[], offset: number, totalCount: number) => ({
		content: [{ text: JSON.stringify({ totalCount, count: ids.length, offset, limit: 200, transactions: ids.map((i) => ({ id: `txn${i}`, amount: -1, date: "2026-07-17" })) }) }],
	});

	it("paginates past a single 200-row page using totalCount, rather than silently truncating", async () => {
		const { defaultDeps } = await import("./_agenda");
		const { monarch } = await import("./monarch");
		const run = vi
			.spyOn(monarch, "run")
			.mockImplementationOnce(async () => page(Array.from({ length: 200 }, (_, i) => i), 0, 350) as any)
			.mockImplementationOnce(async () => page(Array.from({ length: 150 }, (_, i) => 200 + i), 200, 350) as any);

		const deps = await defaultDeps();
		const txns = await deps.monarchTransactions({} as any, { start: "2026-04-19", end: "2026-07-17" });

		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenNthCalledWith(1, {}, { op: "transactions", start: "2026-04-19", end: "2026-07-17", limit: 200, offset: 0 });
		expect(run).toHaveBeenNthCalledWith(2, {}, { op: "transactions", start: "2026-04-19", end: "2026-07-17", limit: 200, offset: 200 });
		expect(txns).toHaveLength(350);
		expect(txns[349]?.id).toBe("txn349");
		run.mockRestore();
	});

	it("stops at a single page when totalCount fits (no wasted extra call)", async () => {
		const { defaultDeps } = await import("./_agenda");
		const { monarch } = await import("./monarch");
		const run = vi.spyOn(monarch, "run").mockImplementationOnce(async () => page([0, 1, 2], 0, 3) as any);

		const deps = await defaultDeps();
		const txns = await deps.monarchTransactions({} as any, { start: "2026-07-14", end: "2026-07-17" });

		expect(run).toHaveBeenCalledTimes(1);
		expect(txns).toHaveLength(3);
		run.mockRestore();
	});

	it("stops at MONARCH_TRANSACTIONS_MAX rather than looping forever on a pathological totalCount", async () => {
		const { defaultDeps } = await import("./_agenda");
		const { monarch } = await import("./monarch");
		const run = vi.spyOn(monarch, "run").mockImplementation(async (_env: any, a: any) => page(Array.from({ length: 200 }, (_, i) => a.offset + i), a.offset, 1_000_000) as any);

		const deps = await defaultDeps();
		const txns = await deps.monarchTransactions({} as any, { start: "2026-04-19", end: "2026-07-17" });

		expect(txns.length).toBeLessThanOrEqual(1000);
		expect(run.mock.calls.length).toBeLessThanOrEqual(6);
		run.mockRestore();
	});
});

describe("agenda — pending-delivery queue survives a failed digest write (#996)", () => {
	const RX_MAIL: MailRef = { id: "rx1", from: "pharmacy@uwmc.org", subject: "Your prescription is ready for pickup" };
	const BILL_MAIL: MailRef = { id: "bill9", from: "billing@chase.com", subject: "Your statement is ready" };

	it("a digest-append failure carries the drop into the NEXT cycle's digest attempt, merged with anything newly proposed", async () => {
		const e = env();
		const d1 = deps({ mailSearch: vi.fn(async () => [RX_MAIL]), calEvents: vi.fn(async () => []), digestAppend: vi.fn(async () => { throw new Error("vault down"); }) });
		const r1 = await runAgenda(e, { date: "2026-07-10" }, d1);
		expect(r1.proposed).toBe(1); // propose() itself succeeded — it's only the digest write that failed
		expect(r1.digest_written).toBe(false);
		expect((await listProposals(e)).length).toBe(1); // already recorded, not lost

		// Next cycle: the rx mail is gone (already proposed), but a fresh bill lands. digestAppend now succeeds.
		const d2 = deps({ mailSearch: vi.fn(async () => [BILL_MAIL]), calEvents: vi.fn(async () => []) });
		const r2 = await runAgenda(e, { date: "2026-07-11" }, d2);
		expect(r2.proposed).toBe(1); // only the new bill is freshly proposed — rx is already ledgered in agenda_drop
		expect(r2.digest_written).toBe(true);
		expect(d2.digestAppend).toHaveBeenCalledTimes(1);
		const written = (d2.digestAppend as any).mock.calls[0][2] as string;
		expect(written).toMatch(/[Pp]rescription/); // yesterday's failed drop survived into today's digest
		expect(written).toMatch(/statement/i); // merged with today's newly proposed drop
		expect(r2.proposals?.map((p) => p.kind)).toEqual(expect.arrayContaining(["rx_ready", "bill_due"]));
	});

	it("once delivery succeeds, the pending queue is cleared and the old drop is not retried a third time", async () => {
		const e = env();
		const d1 = deps({ mailSearch: vi.fn(async () => [RX_MAIL]), calEvents: vi.fn(async () => []), digestAppend: vi.fn(async () => { throw new Error("vault down"); }) });
		await runAgenda(e, { date: "2026-07-10" }, d1);

		const d2 = deps({ mailSearch: vi.fn(async () => []), calEvents: vi.fn(async () => []) });
		const r2 = await runAgenda(e, { date: "2026-07-11" }, d2);
		expect(r2.digest_written).toBe(true); // the carried rx drop finally lands, clearing the queue

		const d3 = deps({ mailSearch: vi.fn(async () => []), calEvents: vi.fn(async () => []) });
		const r3 = await runAgenda(e, { date: "2026-07-12" }, d3);
		expect(d3.digestAppend).not.toHaveBeenCalled(); // nothing left pending — never re-sent
		expect(r3.proposals ?? []).toHaveLength(0);
	});

	it("a same-day drop proposed AFTER an earlier same-cycle digest already sent is not requeued for a full extra cycle (#1041)", async () => {
		const e = env();
		const d1 = deps({ mailSearch: vi.fn(async () => [RX_MAIL]), calEvents: vi.fn(async () => []) });
		const r1 = await runAgenda(e, { date: "2026-07-10" }, d1);
		expect(r1.digest_written).toBe(true); // morning run: digest sent + agenda_digest marked for this cycle

		// Afternoon: same cycle/date, but a genuinely new drop is detected. digestAppend must NOT
		// be attempted again (already delivered this cycle) — the new drop should still not sit in
		// the pending queue for tomorrow, since it's still visible via listProposals.
		const d2 = deps({ mailSearch: vi.fn(async () => [BILL_MAIL]), calEvents: vi.fn(async () => []) });
		const r2 = await runAgenda(e, { date: "2026-07-10" }, d2);
		expect(r2.proposed).toBe(1); // the new bill was freshly proposed this call
		expect(d2.digestAppend).not.toHaveBeenCalled(); // already delivered earlier this cycle
		expect(r2.proposals?.map((p) => p.kind)).toContain("bill_due");

		// Tomorrow: nothing carried over from the afternoon call — it was treated as covered.
		const d3 = deps({ mailSearch: vi.fn(async () => []), calEvents: vi.fn(async () => []) });
		const r3 = await runAgenda(e, { date: "2026-07-11" }, d3);
		expect(d3.digestAppend).not.toHaveBeenCalled();
		expect(r3.proposals ?? []).toHaveLength(0);
	});

	it("email delivery alone marks the digest delivered — a stuck vault write doesn't keep re-sending a growing digest (#1058)", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d1 = deps({ mailSearch: vi.fn(async () => [RX_MAIL]), calEvents: vi.fn(async () => []), digestAppend: vi.fn(async () => { throw new Error("vault down"); }) });
		const r1 = await runAgenda(e, { date: "2026-07-10" }, d1);
		expect(r1.digest_written).toBe(false); // vault append still failing
		expect(d1.sendDigest).toHaveBeenCalledTimes(1); // but email succeeded

		// Same cycle, a new drop arrives. The digest is already considered delivered via email —
		// neither channel should fire again for this cycle.
		const d2 = deps({ mailSearch: vi.fn(async () => [BILL_MAIL]), calEvents: vi.fn(async () => []) });
		await runAgenda(e, { date: "2026-07-10" }, d2);
		expect(d2.sendDigest).not.toHaveBeenCalled();
		expect(d2.digestAppend).not.toHaveBeenCalled();

		// Next day: nothing carried over — the pending queue was already cleared once email delivered.
		const d3 = deps({ mailSearch: vi.fn(async () => []), calEvents: vi.fn(async () => []) });
		await runAgenda(e, { date: "2026-07-11" }, d3);
		expect(d3.digestAppend).not.toHaveBeenCalled();
		expect(d3.sendDigest).not.toHaveBeenCalled();
	});

	it("a pending-queue KV write failure never crashes the cycle (#1134)", async () => {
		const e = env();
		e.OAUTH_KV.put = vi.fn(async (k: string, v: string) => {
			if (k.includes("agenda_pending")) throw new Error("KV put failed (value too large)");
			e.OAUTH_KV.map.set(k, v);
		});
		const d = deps({ mailSearch: vi.fn(async () => [RX_MAIL]), calEvents: vi.fn(async () => []), digestAppend: vi.fn(async () => { throw new Error("vault down"); }) });
		await expect(runAgenda(e, { date: "2026-07-10" }, d)).resolves.toMatchObject({ digest_written: false });
	});

	it("caps the pending queue's serialized size so a sustained outage can't grow it past KV's put limit (#1134)", async () => {
		const e = env();
		const bigDrop = (i: number): unknown => ({
			proposalId: `carried-${i}`,
			drop: { kind: "bill_due", urgency: "fyi", dedupe: `carried::${i}`, title: `old bill ${i}`, emoji: "🧾", action: { fn: "todoist", args: { action: "add", content: `old ${i}` } }, evidence: { note: "x".repeat(50_000) } },
		});
		e.OAUTH_KV.map.set("sux:ledger:agenda_pending:queue", JSON.stringify(Array.from({ length: 40 }, (_, i) => bigDrop(i))));
		const d = deps({ mailSearch: vi.fn(async () => []), calEvents: vi.fn(async () => []), digestAppend: vi.fn(async () => { throw new Error("vault down"); }) });
		await runAgenda(e, { date: "2026-07-10" }, d);
		const persisted = e.OAUTH_KV.map.get("sux:ledger:agenda_pending:queue");
		expect(persisted).toBeDefined();
		expect(new TextEncoder().encode(persisted as string).length).toBeLessThan(1024 * 1024);
	});
});
