import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type BriefingDeps,
	type EventRef,
	type Flagged,
	type MailRef,
	type TaskRef,
	DEFAULT_MAX_DRAFTS,
	deriveBills,
	gatherBriefing,
	hasBriefing,
	hasBriefingStageDrafts,
	maxDrafts,
	passesDraftGate,
	runBriefing,
} from "./_briefing";

// A TTL-aware-enough OAUTH_KV stub for the idempotency ledger (opts ignored). Mirrors the
// fakeKV in _mail_triage.test.ts — no real Fastmail, no real vault, no real AI. The whole
// feature is exercised through the injected BriefingDeps.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), ...flags }) as any;

// Two personal (flagged) + one newsletter + one receipt — so `flagged` = the two humans.
const SAMPLE_MAIL: MailRef[] = [
	{ id: "p1", from: "alice@gmail.com", subject: "lunch next week?", preview: "are you free thursday" },
	{ id: "p2", from: "bob@icloud.com", subject: "re: the trip", preview: "booked the flights" },
	{ id: "n1", from: "newsletter@substack.com", subject: "Weekly Digest", preview: "unsubscribe" },
	{ id: "r1", from: "receipts@amazon.com", subject: "Your receipt from Amazon", preview: "order #123" },
	{ id: "b1", from: "billing@utility.example", subject: "Your statement is due", preview: "payment due July 20" },
];

const SAMPLE_EVENTS: EventRef[] = [{ summary: "Haircut", start: "2026-07-11T10:30:00", location: "Downtown" }];
const SAMPLE_TASKS: TaskRef[] = [{ summary: "File taxes", due: "2026-07-11", source: "caldav" }];

const mkDeps = (over: Partial<BriefingDeps> = {}) => {
	const d = {
		mailSearch: vi.fn(async (_e: any, _o: any): Promise<MailRef[]> => SAMPLE_MAIL),
		mailRead: vi.fn(async (_e: any, id: string) => ({ subject: `subject of ${id}`, from: SAMPLE_MAIL.find((m) => m.id === id)?.from, body: `body of ${id}` })),
		mailDraft: vi.fn(async (_e: any, a: { reply_to: string; text: string }) => ({ id: `draft-${a.reply_to}` })),
		calEvents: vi.fn(async (_e: any, _o: any): Promise<EventRef[]> => SAMPLE_EVENTS),
		tasks: vi.fn(async (_e: any, _o: any): Promise<TaskRef[]> => SAMPLE_TASKS),
		compose: vi.fn(async (_e: any, _s: string, _m: string) => "Good morning! You have a couple of emails and a haircut at 10:30."),
		composeReply: vi.fn(async (_e: any, f: Flagged) => `Thanks for your note about "${f.subject}" — I'll get back to you shortly.`),
		digestAppend: vi.fn(async (_e: any, _p: string, _c: string) => {}),
	};
	// Overrides win (a passed vi.fn replaces the default) while the properties stay typed as
	// vi.Mock so tests can assert on `.mock` / `.toHaveBeenCalled`.
	Object.assign(d, over);
	return d as typeof d & BriefingDeps;
};

describe("gates — fail-closed, two-stage", () => {
	it("hasBriefing is off unless BRIEFING_ENABLED is truthy", () => {
		expect(hasBriefing({} as any)).toBe(false);
		expect(hasBriefing({ BRIEFING_ENABLED: "" } as any)).toBe(false);
		expect(hasBriefing({ BRIEFING_ENABLED: "0" } as any)).toBe(false);
		expect(hasBriefing({ BRIEFING_ENABLED: "false" } as any)).toBe(false);
		expect(hasBriefing({ BRIEFING_ENABLED: "1" } as any)).toBe(true);
		expect(hasBriefing({ BRIEFING_ENABLED: "true" } as any)).toBe(true);
	});
	it("hasBriefingStageDrafts requires BOTH flags — a stray STAGE without ENABLED never arms", () => {
		expect(hasBriefingStageDrafts({ BRIEFING_STAGE_DRAFTS: "1" } as any)).toBe(false);
		expect(hasBriefingStageDrafts({ BRIEFING_ENABLED: "1" } as any)).toBe(false);
		expect(hasBriefingStageDrafts({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "0" } as any)).toBe(false);
		expect(hasBriefingStageDrafts({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" } as any)).toBe(true);
	});
});

describe("draft cap — configurable via BRIEFING_MAX_DRAFTS", () => {
	it("defaults to 5 when unset or invalid", () => {
		expect(DEFAULT_MAX_DRAFTS).toBe(5);
		expect(maxDrafts({} as any)).toBe(5);
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "" } as any)).toBe(5);
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "abc" } as any)).toBe(5);
	});
	it("reads an integer from env", () => {
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "3" } as any)).toBe(3);
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "12" } as any)).toBe(12);
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "7.9" } as any)).toBe(7);
	});
	it("clamps to [1, 20] (0 is falsy → default, per the numClamp idiom)", () => {
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "0" } as any)).toBe(DEFAULT_MAX_DRAFTS);
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "-4" } as any)).toBe(1);
		expect(maxDrafts({ BRIEFING_MAX_DRAFTS: "999" } as any)).toBe(20);
	});
	it("caps drafts staged per run at the env value", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1", BRIEFING_MAX_DRAFTS: "1" }), { cycle_id: "cap1", date: "2026-07-11" }, deps);
		expect(deps.mailDraft).toHaveBeenCalledTimes(1); // 2 flagged, capped to 1
		expect(report.drafts_staged).toBe(1);
	});
});

describe("tone/PII gate on staged drafts", () => {
	it("passes a plain courteous reply", () => {
		expect(passesDraftGate("Thanks for your note — I'll get back to you shortly.")).toBe(true);
	});
	it("rejects money, account numbers, credentials, and commitments", () => {
		expect(passesDraftGate("Sure, I'll send $500 today.")).toBe(false);
		expect(passesDraftGate("Your account 12345678 is set.")).toBe(false);
		expect(passesDraftGate("My password is hunter2.")).toBe(false);
		expect(passesDraftGate("I hereby authorize the payment.")).toBe(false);
		expect(passesDraftGate("go ahead and wire the money")).toBe(false);
		expect(passesDraftGate("")).toBe(false);
	});
});

describe("bills — derived nudges, never a payment", () => {
	it("derives nudges from mail subjects + event titles, deduped", () => {
		const bills = deriveBills(SAMPLE_MAIL, [{ summary: "Rent payment due" }, { summary: "Coffee with Sam" }]);
		const texts = bills.map((b) => b.text);
		expect(texts).toContain("Your statement is due");
		expect(texts).toContain("Rent payment due");
		expect(texts).not.toContain("Coffee with Sam");
	});
});

describe("runBriefing — gating", () => {
	it("is a DORMANT no-op when BRIEFING_ENABLED is unset", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith(), { cycle_id: "c" }, deps);
		expect(report.dormant).toBe(true);
		expect(deps.mailSearch).not.toHaveBeenCalled();
		expect(deps.calEvents).not.toHaveBeenCalled();
		expect(deps.digestAppend).not.toHaveBeenCalled();
		expect(deps.mailDraft).not.toHaveBeenCalled();
	});

	it("ENABLED but STAGE unset → composes + appends the digest but stages NO drafts", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1" }), { cycle_id: "c1", date: "2026-07-11" }, deps);
		expect(report.dormant).toBeUndefined();
		expect(report.stage_drafts_enabled).toBe(false);
		expect(deps.mailDraft).not.toHaveBeenCalled(); // the core regression guard
		expect(deps.digestAppend).toHaveBeenCalledTimes(1);
		expect(report.digest_written).toBe(true);
		expect(report.digest).toContain("Good morning");
		expect(report.flagged!.map((f) => f.id).sort()).toEqual(["p1", "p2"]);
		expect(report.drafts_staged).toBe(0);
	});

	it("ENABLED + STAGE → stages reply drafts to Drafts via mail_draft (never sends)", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" }), { cycle_id: "c2", date: "2026-07-11" }, deps);
		expect(report.stage_drafts_enabled).toBe(true);
		expect(deps.mailDraft).toHaveBeenCalledTimes(2); // p1 + p2
		for (const call of deps.mailDraft.mock.calls) {
			// The draft dep receives ONLY {reply_to, text} — no send, no allow_send, no submission.
			expect(Object.keys(call[1]).sort()).toEqual(["reply_to", "text"]);
		}
		expect(report.drafts_staged).toBe(2);
		expect(report.drafts!.map((d) => d.id).sort()).toEqual(["draft-p1", "draft-p2"]);
	});

	it("dry_run composes + returns but stages nothing and writes no digest", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" }), { cycle_id: "c3", date: "2026-07-11", dry_run: true }, deps);
		expect(report.dry_run).toBe(true);
		expect(report.stage_drafts_enabled).toBe(false);
		expect(deps.mailDraft).not.toHaveBeenCalled();
		expect(deps.digestAppend).not.toHaveBeenCalled();
		expect(report.digest).toContain("Good morning");
	});

	it("draft:false forces summarize + nudge even with STAGE set", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" }), { cycle_id: "c4", date: "2026-07-11", draft: false }, deps);
		expect(report.stage_drafts_enabled).toBe(false);
		expect(deps.mailDraft).not.toHaveBeenCalled();
		expect(deps.digestAppend).toHaveBeenCalledTimes(1);
	});

	it("tone-gate skips a $-amount draft (nudge only, no mail_draft)", async () => {
		const deps = mkDeps({ composeReply: vi.fn(async () => "Sure — I'll send you $250 tomorrow.") });
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" }), { cycle_id: "c5", date: "2026-07-11" }, deps);
		expect(deps.mailDraft).not.toHaveBeenCalled();
		expect(report.drafts_staged).toBe(0);
	});
});

describe("runBriefing — degrade independently", () => {
	it("a failing mail source is skipped and reported, calendar/tasks still compose", async () => {
		const deps = mkDeps({ mailSearch: vi.fn(async () => { throw new Error("Fastmail 401"); }) });
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1" }), { cycle_id: "d1", date: "2026-07-11" }, deps);
		expect(report.sources.mail).toMatch(/unavailable/);
		expect(report.sources.calendar).toMatch(/event/);
		expect(report.sources.tasks).toMatch(/task/);
		expect(report.emails).toBe(0);
		expect(report.events).toBe(1);
		expect(deps.digestAppend).toHaveBeenCalledTimes(1); // still writes a digest
	});

	it("only the requested sources are gathered", async () => {
		const deps = mkDeps();
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1" }), { cycle_id: "d2", date: "2026-07-11", sources: ["calendar"] }, deps);
		expect(deps.mailSearch).not.toHaveBeenCalled();
		expect(deps.tasks).not.toHaveBeenCalled();
		expect(deps.calEvents).toHaveBeenCalledTimes(1);
		expect(report.sources.mail).toBeUndefined();
		expect(report.sources.calendar).toMatch(/event/);
	});

	it("no configured sources (all fail) still returns a digest, never throws", async () => {
		const boom = async () => { throw new Error("not configured"); };
		const deps = mkDeps({ mailSearch: vi.fn(boom), calEvents: vi.fn(boom), tasks: vi.fn(boom), compose: vi.fn(async () => { throw new Error("no AI"); }) });
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1" }), { cycle_id: "d3", date: "2026-07-11" }, deps);
		expect(report.digest).toContain("Good morning");
		expect(report.dormant).toBeUndefined();
	});

	it("compose failure falls back to a deterministic template digest", async () => {
		const deps = mkDeps({ compose: vi.fn(async () => { throw new Error("model unavailable"); }) });
		const report = await runBriefing(envWith({ BRIEFING_ENABLED: "1" }), { cycle_id: "d4", date: "2026-07-11" }, deps);
		expect(report.digest).toContain("Good morning");
		expect(report.digest).toContain("Haircut"); // template lists the events
	});
});

describe("runBriefing — idempotency", () => {
	it("a re-run in the same env stages no new drafts and does not double-append", async () => {
		const env = envWith({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" });
		const deps1 = mkDeps();
		await runBriefing(env, { cycle_id: "idem", date: "2026-07-11" }, deps1);
		expect(deps1.mailDraft).toHaveBeenCalledTimes(2);
		expect(deps1.digestAppend).toHaveBeenCalledTimes(1);
		// Same env (same KV ledger) → drafts already staged for this cycle, digest already written.
		const deps2 = mkDeps();
		const report2 = await runBriefing(env, { cycle_id: "idem", date: "2026-07-11" }, deps2);
		expect(deps2.mailDraft).not.toHaveBeenCalled();
		expect(deps2.digestAppend).not.toHaveBeenCalled();
		expect(report2.digest_written).toBe(false);
	});
});

describe("gatherBriefing — mail flagging + body read", () => {
	it("flags personal senders, reads their bodies, and derives bills", async () => {
		const deps = mkDeps();
		const g = await gatherBriefing(envWith({ BRIEFING_ENABLED: "1" }), "2026-07-11", ["mail", "bills"], { max_mail: 10, horizon_days: 1 }, deps);
		expect(g.flagged.map((f) => f.id).sort()).toEqual(["p1", "p2"]);
		expect(g.flagged.every((f) => typeof f.body === "string")).toBe(true);
		expect(g.bills.map((b) => b.text)).toContain("Your statement is due");
		expect(deps.mailRead).toHaveBeenCalledTimes(2);
	});
});

describe("structural — no send path is reachable from the engine", () => {
	it("_briefing.ts CODE references no mail_send / EmailSubmission / moveMessages / allow_send", () => {
		// Strip comments first — the safety docstring names those tokens on purpose; what must
		// hold is that no CODE path reaches a send/submission/move verb.
		const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "_briefing.ts"), "utf8");
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		expect(code).not.toMatch(/mail_send/);
		expect(code).not.toMatch(/EmailSubmission/);
		expect(code).not.toMatch(/moveMessages/);
		expect(code).not.toMatch(/allow_send/);
		// The only mail mutation the code performs is mail_draft (mode:"reply", send=false).
		expect(code).toMatch(/mail_draft/);
	});
});
