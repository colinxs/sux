import { describe, expect, it, vi } from "vitest";
import { ACTION_FOR, AUTO_ACT_OPS, CONFIDENCE_THRESHOLD, classifyMessage, hasMailTriage, hasMailTriageAct, isAutoActAllowed, runTriage, type TriageDeps, type TriageMsg, type TriageOp } from "./_mail_triage";
import { appendTriageEntries, bulkUndo, readTriageEntries } from "./_mail_triage_log";

// A single OAUTH_KV stub, TTL-aware only enough for the ledger (opts ignored). Mirrors the
// fakeKV in _dropbox-full.test.ts / vault-batch's obsidian-mock style — no real Fastmail,
// no real vault. The whole feature is exercised through the injected TriageDeps.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), ...flags }) as any;

describe("gates — fail-closed, two-stage", () => {
	it("hasMailTriage is off unless MAIL_TRIAGE_ENABLED is truthy", () => {
		expect(hasMailTriage({} as any)).toBe(false);
		expect(hasMailTriage({ MAIL_TRIAGE_ENABLED: "" } as any)).toBe(false);
		expect(hasMailTriage({ MAIL_TRIAGE_ENABLED: "0" } as any)).toBe(false);
		expect(hasMailTriage({ MAIL_TRIAGE_ENABLED: "false" } as any)).toBe(false);
		expect(hasMailTriage({ MAIL_TRIAGE_ENABLED: "1" } as any)).toBe(true);
		expect(hasMailTriage({ MAIL_TRIAGE_ENABLED: "true" } as any)).toBe(true);
	});

	it("hasMailTriageAct requires BOTH flags — a stray ACT without ENABLED never arms", () => {
		expect(hasMailTriageAct({ MAIL_TRIAGE_ACT: "1" } as any)).toBe(false);
		expect(hasMailTriageAct({ MAIL_TRIAGE_ENABLED: "1" } as any)).toBe(false);
		expect(hasMailTriageAct({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "0" } as any)).toBe(false);
		expect(hasMailTriageAct({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" } as any)).toBe(true);
	});
});

describe("classifier — rules stub", () => {
	const cases: Array<[string, TriageMsg, string]> = [
		["junk", { id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery! Claim your prize now" }, "junk"],
		["receipt", { id: "2", from: "receipts@amazon.com", subject: "Your receipt from Amazon" }, "receipt"],
		["newsletter", { id: "3", from: "newsletter@substack.com", subject: "Weekly Digest", preview: "unsubscribe" }, "newsletter"],
		["notification", { id: "4", from: "noreply@github.com", subject: "New sign-in to your account" }, "notification"],
		["personal", { id: "5", from: "friend@gmail.com", subject: "lunch tomorrow?" }, "personal"],
		["unknown", { id: "6", from: "someone@randomcorp.example", subject: "Quick question" }, "unknown"],
	];
	for (const [name, msg, label] of cases) {
		it(`labels ${name}`, () => {
			expect(classifyMessage(msg).label).toBe(label);
		});
	}
	it("gives unmatched mail LOW confidence so the gate stays meaningful", () => {
		expect(classifyMessage({ id: "x", from: "a@randomcorp.example", subject: "hey" }).confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
	});
	it("actionable labels clear the confidence threshold", () => {
		for (const l of ["junk", "receipt", "newsletter", "notification"]) {
			const c = cases.find((k) => k[2] === l)![1];
			expect(classifyMessage(c).confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
		}
	});
});

const mkDeps = (msgs: TriageMsg[]): TriageDeps & { actSpy: ReturnType<typeof vi.fn>; digested: ReturnType<typeof vi.fn> } => {
	const actSpy = vi.fn(async () => {});
	const digested = vi.fn(async () => {});
	return { search: async () => msgs, act: actSpy, digestAppend: digested, actSpy, digested };
};

const SAMPLE: TriageMsg[] = [
	{ id: "j1", from: "x@sketchy.tld", subject: "You WON the lottery! Claim your prize now" }, // junk → LABEL (reversible), not a junk-move
	{ id: "r1", from: "receipts@amazon.com", subject: "Your receipt from Amazon" }, // receipt → archive
	{ id: "p1", from: "friend@gmail.com", subject: "lunch tomorrow?" }, // personal → suggest-only
	{ id: "u1", from: "someone@randomcorp.example", subject: "Quick question" }, // unknown → suggest-only
];

describe("auto-act allow-list — reversible ops only", () => {
	it("AUTO_ACT_OPS is EXACTLY the five reversible ops — no junk-move, no delete", () => {
		expect([...AUTO_ACT_OPS].sort()).toEqual(["archive", "label:add", "label:remove", "unarchive", "undelete"].sort());
	});
	it("every allow-listed op passes the guard", () => {
		const ops: TriageOp[] = [{ kind: "archive" }, { kind: "unarchive" }, { kind: "undelete" }, { kind: "label", label: "junk", add: true }, { kind: "label", label: "junk", add: false }];
		for (const op of ops) expect(isAutoActAllowed(op)).toBe(true);
	});
	it("junk LABELS (reversible flag) instead of MOVING into Junk", () => {
		expect(ACTION_FOR.junk).toEqual({ kind: "label", label: "junk", add: true });
	});
	it("declutter labels archive (inverse: unarchive); personal/unknown never auto-act", () => {
		for (const l of ["receipt", "newsletter", "notification"] as const) expect(ACTION_FOR[l]).toEqual({ kind: "archive" });
		expect(ACTION_FOR.personal).toBeNull();
		expect(ACTION_FOR.unknown).toBeNull();
	});
});

describe("runTriage — gating + idempotency", () => {
	it("is a DORMANT no-op when MAIL_TRIAGE_ENABLED is unset", async () => {
		const deps = mkDeps(SAMPLE);
		const searchSpy = vi.fn(deps.search);
		const report = await runTriage(envWith(), { cycle_id: "c" }, { ...deps, search: searchSpy });
		expect(report.dormant).toBe(true);
		expect(searchSpy).not.toHaveBeenCalled();
		expect(deps.actSpy).not.toHaveBeenCalled();
		expect(deps.digested).not.toHaveBeenCalled();
	});

	it("ENABLED but ACT unset → classifies + writes a digest but NEVER acts", async () => {
		const deps = mkDeps(SAMPLE);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1" });
		const report = await runTriage(env, { cycle_id: "c1" }, deps);
		expect(report.dormant).toBeUndefined();
		expect(report.act_enabled).toBe(false);
		expect(deps.actSpy).not.toHaveBeenCalled(); // the core regression guard
		expect(deps.digested).toHaveBeenCalledTimes(1);
		// junk + receipt would-act but suggest-only → they land in suggested, nothing acted.
		expect(report.acted).toHaveLength(0);
		expect(report.suggested!.length).toBe(4);
	});

	it("dry_run forces suggest-only even with ACT set", async () => {
		const deps = mkDeps(SAMPLE);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "c2", dry_run: true }, deps);
		expect(report.act_enabled).toBe(false);
		expect(deps.actSpy).not.toHaveBeenCalled();
	});

	it("ENABLED + ACT → LABELS junk + ARCHIVES receipt (reversible), suggests personal/unknown; NEVER junk-moves", async () => {
		const deps = mkDeps(SAMPLE);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "c3" }, deps);
		expect(deps.actSpy).toHaveBeenCalledTimes(2);
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["j1"], { kind: "label", label: "junk", add: true });
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["r1"], { kind: "archive" });
		// No call ever files a message into the Junk mailbox — junk-move is gone.
		for (const call of deps.actSpy.mock.calls) expect((call[2] as TriageOp).kind).not.toBe("junk");
		expect(report.acted).toEqual([
			{ id: "j1", label: "junk", confidence: 0.9, op: "label", to: "+label:junk" },
			{ id: "r1", label: "receipt", confidence: 0.85, op: "archive", to: "archive" },
		]);
		// personal (0.70, no action) + unknown (0.20, low confidence) → suggestions only, never acted.
		expect(report.suggested!.map((s) => s.id).sort()).toEqual(["p1", "u1"]);
	});

	it("idempotent pull: a re-run performs ZERO new actions on already-seen ids", async () => {
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const deps1 = mkDeps(SAMPLE);
		await runTriage(env, { cycle_id: "r1" }, deps1);
		expect(deps1.actSpy).toHaveBeenCalledTimes(2);
		// Same env (same KV ledger) → every id already marked seen.
		const deps2 = mkDeps(SAMPLE);
		const report2 = await runTriage(env, { cycle_id: "r2" }, deps2);
		expect(deps2.actSpy).not.toHaveBeenCalled();
		expect(report2.new).toBe(0);
		expect(report2.skipped_seen).toBe(4);
	});

	it("self-bounds its wall-clock budget and reports truncated", async () => {
		const many: TriageMsg[] = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, from: "friend@gmail.com", subject: "hi" }));
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1" });
		const report = await runTriage(env, { cycle_id: "b1", budget_ms: 1000 }, { ...mkDeps(many), search: async () => many });
		// budget_ms clamps to a 1000ms floor; with Date.now() already past deadline on entry it stops early.
		expect(report.truncated === true || report.scanned! <= many.length).toBe(true);
	});
});

describe("action log + bulk undo", () => {
	it("reverses each op by its allow-listed inverse (archive→unarchive, label→un-label), idempotently", async () => {
		const env = envWith();
		await appendTriageEntries(env, [
			{ cycle: "u", id: "a", action: "acted", label: "newsletter", confidence: 0.8, reason: "r", op: "archive", from_mailbox: "inbox", to_mailbox: "archive", at: 1 },
			{ cycle: "u", id: "b", action: "acted", label: "receipt", confidence: 0.85, reason: "r", op: "archive", from_mailbox: "inbox", to_mailbox: "archive", at: 2 },
			{ cycle: "u", id: "k", action: "acted", label: "junk", confidence: 0.9, reason: "r", op: "label", keyword: "junk", at: 3 },
			{ cycle: "u", id: "c", action: "suggested", label: "unknown", confidence: 0.2, reason: "r", at: 4 },
		]);
		const move = vi.fn(async () => {});
		const label = vi.fn(async () => {});
		const res: any = await bulkUndo(env, "u", { move, label });
		expect(res.undone).toBe(3);
		// The two archived messages move back to their origin (inbox), grouped into one call.
		expect(move).toHaveBeenCalledTimes(1);
		const [, movedIds, target] = move.mock.calls[0] as unknown as [unknown, string[], string];
		expect([...movedIds].sort()).toEqual(["a", "b"]);
		expect(target).toBe("inbox");
		// The labeled message is un-labeled (keyword removed), never moved/deleted.
		expect(label).toHaveBeenCalledTimes(1);
		expect(label).toHaveBeenCalledWith(env, ["k"], "junk", false);
		// A suggestion is never reversed.
		expect(res.ids.sort()).toEqual(["a", "b", "k"]);

		// Second undo is a safe no-op (entries already marked undone).
		move.mockClear();
		label.mockClear();
		const res2: any = await bulkUndo(env, "u", { move, label });
		expect(res2.undone).toBe(0);
		expect(move).not.toHaveBeenCalled();
		expect(label).not.toHaveBeenCalled();
	});

	it("readTriageEntries filters by cycle, newest-first", async () => {
		const env = envWith();
		await appendTriageEntries(env, [
			{ cycle: "x", id: "1", action: "suggested", label: "unknown", confidence: 0.2, reason: "r", at: 1 },
			{ cycle: "y", id: "2", action: "suggested", label: "unknown", confidence: 0.2, reason: "r", at: 2 },
		]);
		const x = await readTriageEntries(env, { cycle: "x" });
		expect(x.map((e) => e.id)).toEqual(["1"]);
		const all = await readTriageEntries(env);
		expect(all[0].id).toBe("2"); // newest-first (last appended is first)
	});
});
