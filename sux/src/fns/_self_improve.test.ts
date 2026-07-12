import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackEntry } from "./_feedback";
import { canOpenPr, classifyLane, type Finding, type GithubClient, hasSelfImprove, isArmed, isKilled, selfImproveTick } from "./_self_improve";

// In-memory KV + a spy on put, so tests can assert what keys the loop writes.
function fakeKv() {
	const store = new Map<string, string>();
	const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
	const get = vi.fn(async (k: string) => store.get(k) ?? null);
	return { store, kv: { get, put }, put, get };
}

// Seed the feedback backlog (newest-first, as _feedback.ts stores it) at controlled `at`s.
function seedFeedback(store: Map<string, string>, entries: FeedbackEntry[]) {
	const sorted = [...entries].sort((a, b) => b.at - a.at);
	store.set("sux:feedback", JSON.stringify(sorted));
}

function fakeGithub(opts: { green?: boolean } = {}): GithubClient & { openPr: ReturnType<typeof vi.fn>; mergePr: ReturnType<typeof vi.fn>; checkRunsGreen: ReturnType<typeof vi.fn> } {
	let n = 0;
	const openPr = vi.fn(async (_f: Finding) => ({ number: ++n, sha: `sha-${n}` }));
	const checkRunsGreen = vi.fn(async (_sha: string) => opts.green ?? false);
	const mergePr = vi.fn(async (_pr: number) => {});
	return { openPr, checkRunsGreen, mergePr };
}

const baseEnv = (over: Record<string, string> = {}) => {
	const { store, kv } = fakeKv();
	return { env: { OAUTH_KV: kv, ...over } as any, store, kv };
};

const ARMED = { SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on", SELF_IMPROVE_ARM: "armed", GITHUB_TOKEN: "tok" };

describe("self-improve gate predicates", () => {
	it("kill wins over a fully-armed env", () => {
		const env = { ...ARMED, SELF_IMPROVE_KILL: "1" } as any;
		expect(isKilled(env)).toBe(true);
		expect(hasSelfImprove(env)).toBe(false);
		expect(canOpenPr(env)).toBe(false);
		expect(isArmed(env)).toBe(false);
	});
	it("defaults are all off", () => {
		const env = {} as any;
		expect(hasSelfImprove(env)).toBe(false);
		expect(canOpenPr(env)).toBe(false);
		expect(isArmed(env)).toBe(false);
	});
	it("PR needs enable + token + PR=on; arm needs the exact 'armed' sentinel", () => {
		expect(canOpenPr({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on", GITHUB_TOKEN: "t" } as any)).toBe(true);
		expect(canOpenPr({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on" } as any)).toBe(false); // no token
		expect(isArmed({ ...ARMED, SELF_IMPROVE_ARM: "yes" } as any)).toBe(false); // truthy but not 'armed'
		expect(isArmed(ARMED as any)).toBe(true);
	});
});

describe("classifyLane", () => {
	const e = (text: string, kind: FeedbackEntry["kind"] = "issue", tool?: string): FeedbackEntry => ({ kind, text, at: 1, ...(tool ? { tool } : {}) });
	it("security keywords win over everything (even 'add')", () => {
		expect(classifyLane({} as any, e("please add a fix for the auth token leak")).lane).toBe("security");
	});
	it("suggest-kind ⇒ feature", () => {
		expect(classifyLane({} as any, e("make it faster", "suggest")).lane).toBe("feature");
	});
	it("fix / refactor / cleanup language", () => {
		expect(classifyLane({} as any, e("the tool crashed with a 500 error")).lane).toBe("fix");
		expect(classifyLane({} as any, e("this endpoint is really slow")).lane).toBe("refactor");
		expect(classifyLane({} as any, e("there is a lot of dead code here")).lane).toBe("cleanup");
	});
	it("ambiguous issue ⇒ security (PR-only, bias to safe)", () => {
		expect(classifyLane({} as any, e("hmm not sure about this one")).lane).toBe("security");
	});
});

describe("selfImproveTick gating matrix", () => {
	it("nothing set ⇒ dormant no-op (opens nothing)", async () => {
		const { env, store } = baseEnv();
		seedFeedback(store, [{ kind: "issue", text: "the tool crashed", at: 100 }]);
		const gh = fakeGithub();
		const r = await selfImproveTick(env, { github: gh });
		expect(r.dormant).toBe(true);
		expect(r.reason).toBe("disabled");
		expect(gh.openPr).not.toHaveBeenCalled();
		expect(gh.mergePr).not.toHaveBeenCalled();
		expect(r.prs).toBe(0);
		expect(r.merges).toBe(0);
	});

	it("KILL set while fully armed ⇒ hard no-op (kill wins)", async () => {
		const { env, store } = baseEnv({ ...ARMED, SELF_IMPROVE_KILL: "1" });
		seedFeedback(store, [{ kind: "issue", text: "the tool crashed with an error", at: 100 }]);
		const gh = fakeGithub({ green: true });
		const r = await selfImproveTick(env, { github: gh });
		expect(r.dormant).toBe(true);
		expect(r.reason).toBe("killed");
		expect(gh.openPr).not.toHaveBeenCalled();
		expect(gh.mergePr).not.toHaveBeenCalled();
		expect(r.processed).toBe(0);
	});

	it("review-only (enable, no PR/token) ⇒ reads + records findings, opens nothing", async () => {
		const { env, store } = baseEnv({ SELF_IMPROVE_ENABLE: "1" });
		seedFeedback(store, [{ kind: "issue", text: "the tool crashed with an error", at: 100 }]);
		const gh = fakeGithub();
		const r = await selfImproveTick(env, { github: gh });
		expect(r.dormant).toBe(false);
		expect(r.reason).toBe("review-only");
		expect(r.processed).toBe(1);
		expect(gh.openPr).not.toHaveBeenCalled();
		expect(r.prs).toBe(0);
		// The finding is recorded internally (review record), not opened outward.
		expect(store.get("sux:selfimprove:findings")).toBeTruthy();
	});

	it("PR-only (enable+PR+token, NOT armed): fix finding opens a PR, never merges", async () => {
		const { env, store } = baseEnv({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on", GITHUB_TOKEN: "tok" });
		seedFeedback(store, [{ kind: "issue", text: "the dns tool crashed with a 500 error", at: 100 }]);
		const gh = fakeGithub({ green: true }); // green, but unarmed ⇒ must not merge
		const r = await selfImproveTick(env, { github: gh });
		expect(r.reason).toBe("pr-only");
		expect(gh.openPr).toHaveBeenCalledTimes(1);
		expect(gh.mergePr).not.toHaveBeenCalled();
		expect(r.prs).toBe(1);
		expect(r.merges).toBe(0);
	});

	it("fully armed + fix lane + GREEN CI ⇒ merges", async () => {
		const { env, store } = baseEnv(ARMED);
		seedFeedback(store, [{ kind: "issue", text: "the dns tool crashed with a 500 error", at: 100 }]);
		const gh = fakeGithub({ green: true });
		const r = await selfImproveTick(env, { github: gh });
		expect(r.reason).toBe("armed");
		expect(gh.openPr).toHaveBeenCalledTimes(1);
		expect(gh.mergePr).toHaveBeenCalledTimes(1);
		expect(r.merges).toBe(1);
	});

	it("fully armed + fix lane + non-green CI ⇒ PR only, no merge", async () => {
		const { env, store } = baseEnv(ARMED);
		seedFeedback(store, [{ kind: "issue", text: "the dns tool crashed with a 500 error", at: 100 }]);
		const gh = fakeGithub({ green: false });
		const r = await selfImproveTick(env, { github: gh });
		expect(gh.openPr).toHaveBeenCalledTimes(1);
		expect(gh.mergePr).not.toHaveBeenCalled();
		expect(r.merges).toBe(0);
	});

	it("security lane while fully armed ⇒ PR only, NEVER merges", async () => {
		const { env, store } = baseEnv(ARMED);
		seedFeedback(store, [{ kind: "issue", text: "there is an auth token leak in the login flow", at: 100 }]);
		const gh = fakeGithub({ green: true });
		const r = await selfImproveTick(env, { github: gh });
		expect(gh.openPr).toHaveBeenCalledTimes(1);
		expect(gh.mergePr).not.toHaveBeenCalled();
		expect(gh.checkRunsGreen).not.toHaveBeenCalled(); // never even polls CI on the security path
		expect(r.merges).toBe(0);
	});

	it("feature lane while fully armed ⇒ PR only, never merges", async () => {
		const { env, store } = baseEnv(ARMED);
		seedFeedback(store, [{ kind: "suggest", text: "it would be nice to have a whois tool", at: 100 }]);
		const gh = fakeGithub({ green: true });
		const r = await selfImproveTick(env, { github: gh });
		expect(gh.openPr).toHaveBeenCalledTimes(1);
		expect(gh.mergePr).not.toHaveBeenCalled();
		expect(r.merges).toBe(0);
	});

	it("rate cap: 4th outward action in a day is skipped; cap is the const, not KV", async () => {
		const { env, store } = baseEnv({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on", GITHUB_TOKEN: "tok" });
		// A bogus KV 'cap' key must NOT be able to raise the compile-time cap.
		store.set("sux:selfimprove:cap", "99");
		seedFeedback(store, [
			{ kind: "issue", text: "auth token leak one", at: 101 },
			{ kind: "issue", text: "auth token leak two", at: 102 },
			{ kind: "issue", text: "auth token leak three", at: 103 },
			{ kind: "issue", text: "auth token leak four", at: 104 },
		]);
		const gh = fakeGithub();
		const r = await selfImproveTick(env, { github: gh });
		expect(gh.openPr).toHaveBeenCalledTimes(3);
		expect(r.prs).toBe(3);
		expect(r.skipped).toBe(1);
		const day = new Date().toISOString().slice(0, 10);
		expect(store.get(`sux:selfimprove:count:${day}`)).toBe("3");
	});

	it("idempotency: a second tick over the same feedback opens 0 new PRs", async () => {
		const { env, store } = baseEnv({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on", GITHUB_TOKEN: "tok" });
		seedFeedback(store, [{ kind: "suggest", text: "add a whois tool", at: 100 }]);
		const gh = fakeGithub();
		const r1 = await selfImproveTick(env, { github: gh });
		expect(r1.prs).toBe(1);
		const r2 = await selfImproveTick(env, { github: gh });
		expect(r2.processed).toBe(0);
		expect(r2.prs).toBe(0);
		expect(gh.openPr).toHaveBeenCalledTimes(1);
	});

	it("never throws out of the tick even if a github call rejects", async () => {
		const { env, store } = baseEnv({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_PR: "on", GITHUB_TOKEN: "tok" });
		seedFeedback(store, [{ kind: "suggest", text: "add a whois tool", at: 100 }]);
		const gh = fakeGithub();
		gh.openPr.mockRejectedValueOnce(new Error("boom"));
		const r = await selfImproveTick(env, { github: gh });
		expect(r.processed).toBe(1); // attempted, advanced past it
		expect(r.prs).toBe(0);
	});
});

describe("structural immutability (the loop cannot loosen its own guards)", () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "_self_improve.ts"), "utf8");
	it("the cap is a compile-time literal const, not from env or KV", () => {
		expect(src).toMatch(/const SELF_IMPROVE_DAILY_CAP = \d+;/);
		expect(src).not.toMatch(/env\.SELF_IMPROVE_DAILY_CAP/);
		expect(src).not.toMatch(/get\([^)]*cap/i); // never reads a KV 'cap' value
	});
	it("the module never writes the KILL or ARM control values", () => {
		expect(src).not.toMatch(/put\([^)]*SELF_IMPROVE_KILL/);
		expect(src).not.toMatch(/put\([^)]*SELF_IMPROVE_ARM/);
	});
	it("the module never fetches .github/ workflow/deploy paths", () => {
		expect(src).not.toMatch(/\.github\//);
	});
});
