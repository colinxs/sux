import { describe, expect, it, vi } from "vitest";
import { DEFAULT_QUESTIONS, MAX_QUESTIONS, hasWeeklyRecall, isoWeek, runWeeklyRecall, standingQuestions, type WeeklyRecallDeps } from "./_weekly_recall";

// A single OAUTH_KV stub, TTL-aware only enough for the ledger (opts ignored) — mirrors the
// fakeKV in _mail_triage.test.ts. The whole feature is exercised through the injected deps:
// no real recall, no real vault.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), ...flags }) as any;

const mkDeps = (answer = "the answer", citations = ["vault:x"]): WeeklyRecallDeps & { recallSpy: ReturnType<typeof vi.fn>; digested: ReturnType<typeof vi.fn> } => {
	const recallSpy = vi.fn(async () => ({ answer, citations }));
	const digested = vi.fn(async () => {});
	return { recall: recallSpy, digestAppend: digested, recallSpy, digested };
};

describe("gate — fail-closed", () => {
	it("hasWeeklyRecall is off unless WEEKLY_RECALL_ENABLED is truthy", () => {
		for (const v of [undefined, "", "0", "false", "no", "off"]) expect(hasWeeklyRecall({ WEEKLY_RECALL_ENABLED: v } as any)).toBe(false);
		for (const v of ["1", "true", "on", "yes"]) expect(hasWeeklyRecall({ WEEKLY_RECALL_ENABLED: v } as any)).toBe(true);
	});
});

describe("standingQuestions", () => {
	it("defaults when unset", () => {
		expect(standingQuestions(envWith())).toEqual(DEFAULT_QUESTIONS);
	});
	it("splits an override on newlines and semicolons, trims, drops blanks", () => {
		const env = envWith({ WEEKLY_RECALL_QUESTIONS: "  what's due?  ;\n\n who owes me?  ; " });
		expect(standingQuestions(env)).toEqual(["what's due?", "who owes me?"]);
	});
	it("falls back to defaults when an override parses to nothing", () => {
		expect(standingQuestions(envWith({ WEEKLY_RECALL_QUESTIONS: " ; \n ; " }))).toEqual(DEFAULT_QUESTIONS);
	});
	it("caps at MAX_QUESTIONS to bound cron cost", () => {
		const raw = Array.from({ length: MAX_QUESTIONS + 5 }, (_, i) => `q${i}`).join("\n");
		expect(standingQuestions(envWith({ WEEKLY_RECALL_QUESTIONS: raw })).length).toBe(MAX_QUESTIONS);
	});
});

describe("isoWeek", () => {
	it("is Thursday-anchored — 2027-01-01 (a Friday) belongs to week 53 of 2026", () => {
		// ISO week-year rolls: the Fri/Sat/Sun of that week still count under 2026-W53.
		expect(isoWeek("UTC", new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
	});
	it("formats a mid-year date as YYYY-Www", () => {
		expect(isoWeek("UTC", new Date("2026-07-11T12:00:00Z"))).toMatch(/^2026-W\d{2}$/);
	});
});

describe("runWeeklyRecall", () => {
	it("is a dormant no-op unless enabled — no recall, no vault write", async () => {
		const deps = mkDeps();
		const report = await runWeeklyRecall(envWith(), { week: "2026-W01" }, deps);
		expect(report.dormant).toBe(true);
		expect(deps.recallSpy).not.toHaveBeenCalled();
		expect(deps.digested).not.toHaveBeenCalled();
	});

	it("runs every standing question and appends ONE Weekly-note digest", async () => {
		const env = envWith({ WEEKLY_RECALL_ENABLED: "1", WEEKLY_RECALL_QUESTIONS: "a?;b?" });
		const deps = mkDeps("ans", ["vault:n"]);
		const report = await runWeeklyRecall(env, { week: "2026-W10" }, deps);
		expect(report.dormant).toBeUndefined();
		expect(report.digest_written).toBe(true);
		expect(report.questions).toBe(2);
		expect(deps.recallSpy).toHaveBeenCalledTimes(2);
		expect(deps.digested).toHaveBeenCalledTimes(1);
		const [, path, content] = deps.digested.mock.calls[0];
		expect(path).toBe("Weekly/2026-W10.md");
		expect(content).toContain("### a?");
		expect(content).toContain("### b?");
		expect(content).toContain("ans");
		expect(content).toContain("vault:n");
	});

	it("is idempotent per ISO week — a second same-week tick skips (no re-run, no re-append)", async () => {
		const env = envWith({ WEEKLY_RECALL_ENABLED: "1" });
		const d1 = mkDeps();
		await runWeeklyRecall(env, { week: "2026-W20" }, d1);
		expect(d1.digested).toHaveBeenCalledTimes(1);
		const d2 = mkDeps();
		const report2 = await runWeeklyRecall(env, { week: "2026-W20" }, d2);
		expect(report2.skipped).toBe(true);
		expect(d2.recallSpy).not.toHaveBeenCalled();
		expect(d2.digested).not.toHaveBeenCalled();
	});

	it("a failed vault append leaves the week UNMARKED so the next tick retries", async () => {
		const env = envWith({ WEEKLY_RECALL_ENABLED: "1" });
		const failing = mkDeps();
		failing.digestAppend = vi.fn(async () => {
			throw new Error("vault down");
		});
		const r1 = await runWeeklyRecall(env, { week: "2026-W30" }, failing);
		expect(r1.digest_written).toBe(false);
		// Soft failure surfaces as `error` (not `note`) so runSubJob flips the heartbeat.
		expect(r1.error).toContain("vault append failed");
		// Not marked → a retry actually re-runs and this time succeeds.
		const ok = mkDeps();
		const r2 = await runWeeklyRecall(env, { week: "2026-W30" }, ok);
		expect(r2.skipped).toBeUndefined();
		expect(r2.digest_written).toBe(true);
		expect(ok.digested).toHaveBeenCalledTimes(1);
	});

	it("one failing question doesn't sink the digest — its failure is recorded inline", async () => {
		const env = envWith({ WEEKLY_RECALL_ENABLED: "1", WEEKLY_RECALL_QUESTIONS: "good?;bad?" });
		const deps = mkDeps();
		deps.recall = vi.fn(async (_e, q: string) => {
			if (q === "bad?") throw new Error("boom");
			return { answer: "fine", citations: [] };
		});
		const report = await runWeeklyRecall(env, { week: "2026-W40" }, deps);
		expect(report.digest_written).toBe(true);
		const content = deps.digested.mock.calls[0][2] as string;
		expect(content).toContain("recall failed: boom");
		expect(content).toContain("fine");
	});

	it("force re-runs even a marked week", async () => {
		const env = envWith({ WEEKLY_RECALL_ENABLED: "1" });
		const d1 = mkDeps();
		await runWeeklyRecall(env, { week: "2026-W50" }, d1);
		const d2 = mkDeps();
		const report = await runWeeklyRecall(env, { week: "2026-W50", force: true }, d2);
		expect(report.skipped).toBeUndefined();
		expect(d2.digested).toHaveBeenCalledTimes(1);
	});
});
