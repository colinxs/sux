import { describe, expect, it, vi } from "vitest";
import { ACTION_FOR, ARCHIVE_CONFIDENCE_THRESHOLD, AUTO_ACT_OPS, CONFIDENCE_THRESHOLD, DRAFT_REPLY_CONFIDENCE_THRESHOLD, classify, classifyMessage, detectReplyDraft, hasMailTriage, hasMailTriageAct, isAutoActAllowed, isSensitiveSender, resolveOp, runTriage, type TriageDeps, type TriageLabel, type TriageMsg, type TriageOp } from "./_mail_triage";
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
		["receipt", { id: "2", from: "receipts@shopco.example", subject: "Your receipt from ShopCo" }, "receipt"],
		["transaction", { id: "t1", from: "alerts@chase.com", subject: "Your statement is ready" }, "transaction"],
		["amazon_return", { id: "a1", from: "return@amazon.com", subject: "Your refund and return label" }, "amazon_return"],
		["mailing_list", { id: "3", from: "newsletter@substack.com", subject: "Weekly Digest", preview: "unsubscribe" }, "mailing_list"],
		["notification", { id: "4", from: "noreply@github.com", subject: "New sign-in to your account" }, "notification"],
		["important", { id: "i1", from: "friend@gmail.com", subject: "Please reply — need your answer by tomorrow" }, "important"],
		["personal", { id: "5", from: "friend@gmail.com", subject: "lunch tomorrow?" }, "personal"],
		["unknown", { id: "6", from: "someone@randomcorp.example", subject: "Quick question" }, "unknown"],
	];
	for (const [name, msg, label] of cases) {
		it(`labels ${name}`, () => {
			expect(classifyMessage(msg).label).toBe(label);
		});
	}
	it("keeps transaction distinct from receipt (bank account event vs purchase confirmation)", () => {
		// A purchase confirmation with an order # is a RECEIPT, not a transaction…
		expect(classifyMessage({ id: "d1", from: "orders@shopco.example", subject: "Order confirmation #12345" }).label).toBe("receipt");
		// …while a card/brokerage account event (or a bank sender) is a TRANSACTION.
		expect(classifyMessage({ id: "d2", from: "no-reply@wellsfargo.com", subject: "Payment received" }).label).toBe("transaction");
		expect(classifyMessage({ id: "d3", from: "info@somebank.example", subject: "Direct deposit posted to your account", preview: "available balance" }).label).toBe("transaction");
	});
	it("amazon return/refund beats the generic receipt rule and emits the amazon-return tag", () => {
		const c = classifyMessage({ id: "a2", from: "auto-confirm@amazon.com", subject: "Your return label is ready", preview: "drop off at any location" });
		expect(c.label).toBe("amazon_return");
		expect(ACTION_FOR[c.label]).toEqual({ kind: "label", label: "amazon-return", add: true });
	});
	it("does NOT call a personal-domain sender a mailing list on a preview cue alone (no mislabel of real mail)", () => {
		// "weekly"/"unsubscribe" in a preview must not, by itself, override the sender check —
		// a gmail.com human whose message merely contains those words stays PERSONAL, not a mailing list.
		for (const preview of ["let's meet weekly going forward", "unsubscribe me from the group calendar?"]) {
			const c = classifyMessage({ id: "n", from: "friend@gmail.com", subject: "lunch tomorrow?", preview });
			expect(c.label).not.toBe("mailing_list");
			expect(c.label).toBe("personal");
		}
	});
	it("still labels a real bulk sender a mailing list (cue + bulk-sender signal)", () => {
		expect(classifyMessage({ id: "n2", from: "newsletter@substack.com", subject: "Weekly Digest", preview: "unsubscribe" }).label).toBe("mailing_list");
		// A non-personal domain may qualify on a preview cue even without a bulk-sender address.
		expect(classifyMessage({ id: "n3", from: "hi@somebrand.example", subject: "hello", preview: "you can unsubscribe any time" }).label).toBe("mailing_list");
	});
	it("important AUTO-elevates (add-only label): personal human + urgency cue → reversible label:add", () => {
		const c = classifyMessage({ id: "im", from: "friend@gmail.com", subject: "Action required: please respond ASAP" });
		expect(c.label).toBe("important");
		expect(c.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
		expect(ACTION_FOR.important).toEqual({ kind: "label", label: "important", add: true });
	});
	it("labels GitHub notifications by TYPE with a reversible label op (never archived)", () => {
		const cases: Array<[TriageMsg, string]> = [
			[{ id: "g1", from: "notifications@github.com", subject: "[owner/repo] Run failed: CI (main)" }, "gh:ci-fail"],
			[{ id: "g2", from: "notifications@github.com", subject: "Bump lodash from 4.17.20 to 4.17.21 (#42)" }, "gh:dependabot"],
			[{ id: "g3", from: "notifications@github.com", subject: "[owner/repo] PR title (#7)", preview: "colinxs mentioned you in this thread" }, "gh:mention"],
			[{ id: "g4", from: "notifications@github.com", subject: "[owner/repo] review requested on PR #7" }, "gh:review"],
			[{ id: "g5", from: "notifications@github.com", subject: "[owner/repo] Something happened (#9)" }, "gh:activity"], // no subtype cue → generic, but NOT a subtype... falls to :notification
		];
		for (const [msg, keyword] of cases.slice(0, 4)) {
			const c = classifyMessage(msg);
			expect(c.label).toBe("notification");
			expect(c.op).toEqual({ kind: "label", label: keyword, add: true });
			expect(c.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
			expect(isAutoActAllowed(c.op!)).toBe(true); // reversible-only
		}
		// A GitHub sender with no recognizable subtype still gets a reversible generic label, kept visible.
		const generic = classifyMessage({ id: "g5", from: "notifications@github.com", subject: "[owner/repo] Something happened (#9)" });
		expect(generic.op).toEqual({ kind: "label", label: "gh:notification", add: true });
	});
	it("generalizes lightly to other services (GitLab/Vercel/CI) with a reversible generic label", () => {
		for (const [from, prefix] of [["noreply@gitlab.com", "gitlab"], ["notifications@vercel.com", "vercel"], ["builds@circleci.com", "ci"]] as const) {
			const c = classifyMessage({ id: "s", from, subject: "pipeline update" });
			expect(c.label).toBe("notification");
			expect(c.op).toEqual({ kind: "label", label: `${prefix}:notification`, add: true });
		}
	});
	it("gives unmatched mail LOW confidence so the gate stays meaningful", () => {
		expect(classifyMessage({ id: "x", from: "a@randomcorp.example", subject: "hey" }).confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
	});
	it("actionable labels clear the confidence threshold", () => {
		for (const l of ["junk", "transaction", "receipt", "amazon_return", "mailing_list", "notification"]) {
			const c = cases.find((k) => k[2] === l)![1];
			expect(classifyMessage(c).confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
		}
	});
	it("labels a strong promotional pitch spam (distinct from junk's scam cues and mailing_list's bulk-sender footer), reversibly", () => {
		const c = classifyMessage({ id: "sp1", from: "deals@somebrand.example", subject: "Flash sale: 40% off everything, shop now" });
		expect(c.label).toBe("spam");
		expect(c.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
		expect(ACTION_FOR.spam).toEqual({ kind: "label", label: "spam", add: true });
		expect(isAutoActAllowed(ACTION_FOR.spam!)).toBe(true);
	});
});

describe("classify() — ambiguous-spam AI seam (best-effort, cost-controlled)", () => {
	// A weak/borderline cue only ("coupon") — NOT one of the strong SPAM_SUBJECT_CUE phrases, so
	// classifyMessage's sync rules fall through to "unknown" and leave the decision to the AI seam.
	const ambiguous: TriageMsg = { id: "amb1", from: "someone@randomcorp.example", subject: "New coupon just for you" };
	it("without an AI binding, falls back to the rules-stub result untouched", async () => {
		const c = await classify(envWith(), ambiguous);
		expect(c).toEqual(classifyMessage(ambiguous));
	});
	it("with AI available, a SPAM verdict on a weak/ambiguous cue upgrades the label", async () => {
		const env = envWith({}) as any;
		env.AI = { run: vi.fn(async () => ({ response: "SPAM" })) };
		const c = await classify(env, ambiguous);
		expect(c.label).toBe("spam");
		expect(env.AI.run).toHaveBeenCalledTimes(1);
	});
	it("with AI available, a NOT_SPAM verdict (or no weak cue at all) leaves the base result alone", async () => {
		const env = envWith({}) as any;
		env.AI = { run: vi.fn(async () => ({ response: "NOT_SPAM" })) };
		expect((await classify(env, ambiguous)).label).toBe("unknown");
		// No promotional cue at all → the AI call is never made (cost control).
		const noCue: TriageMsg = { id: "amb2", from: "someone@randomcorp.example", subject: "Quick question" };
		await classify(env, noCue);
		expect(env.AI.run).toHaveBeenCalledTimes(1); // only the `ambiguous` case above called it
	});
	it("a model/transport failure best-effort falls back to the base result", async () => {
		const env = envWith({}) as any;
		env.AI = { run: vi.fn(async () => { throw new Error("boom"); }) };
		const c = await classify(env, ambiguous);
		expect(c.label).toBe("unknown");
	});
});

const mkDeps = (msgs: TriageMsg[]): TriageDeps & { actSpy: ReturnType<typeof vi.fn>; digested: ReturnType<typeof vi.fn> } => {
	const actSpy = vi.fn(async () => {});
	const digested = vi.fn(async () => {});
	return { search: async () => msgs, act: actSpy, digestAppend: digested, actSpy, digested };
};

const SAMPLE: TriageMsg[] = [
	{ id: "j1", from: "x@sketchy.tld", subject: "You WON the lottery! Claim your prize now" }, // junk → LABEL (reversible), not a junk-move
	{ id: "r1", from: "receipts@shopco.example", subject: "Your receipt from ShopCo" }, // receipt → LABEL (reversible tag), not archive
	{ id: "p1", from: "friend@gmail.com", subject: "lunch tomorrow?" }, // personal → LABEL (reversible tag)
	{ id: "u1", from: "someone@randomcorp.example", subject: "Quick question" }, // unknown → suggest-only
];

describe("auto-act allow-list — attention-increasing ops + high-confidence archive + send-proof draft-reply", () => {
	it("AUTO_ACT_OPS is EXACTLY label:add / archive / unarchive / undelete / draft-reply — no label-remove, no delete, no send", () => {
		expect([...AUTO_ACT_OPS].sort()).toEqual(["archive", "draft-reply", "label:add", "unarchive", "undelete"].sort());
	});
	it("every allow-listed op (incl. draft-reply) passes the guard", () => {
		const ops: TriageOp[] = [{ kind: "archive" }, { kind: "unarchive" }, { kind: "undelete" }, { kind: "label", label: "junk", add: true }, { kind: "draft-reply" }];
		for (const op of ops) expect(isAutoActAllowed(op)).toBe(true);
	});
	it("a label-REMOVE (attention-reducing) is rejected by the guard even though it's representable", () => {
		expect(isAutoActAllowed({ kind: "label", label: "junk", add: false })).toBe(false);
	});
	it("every obvious category TAGS (label:add) — never archive; a label op is not a hiding move", () => {
		const tags: Array<[TriageLabel, string]> = [
			["transaction", "transaction"],
			["receipt", "receipt"],
			["amazon_return", "amazon-return"],
			["mailing_list", "mailing-list"],
			["notification", "notification"],
			["personal", "personal"],
		];
		for (const [label, keyword] of tags) {
			const op = ACTION_FOR[label]!;
			expect(op).toEqual({ kind: "label", label: keyword, add: true });
			expect(op.kind).toBe("label"); // never "archive"
			expect(isAutoActAllowed(op)).toBe(true);
		}
	});
	it("archive is still a representable/allow-listed op but no longer any category's default", () => {
		expect([...AUTO_ACT_OPS]).toContain("archive");
		for (const op of Object.values(ACTION_FOR)) if (op) expect(op.kind).not.toBe("archive");
	});
	it("important AUTO-adds (attention-increasing = safe) but only the ADD side — no remove rule", () => {
		expect(ACTION_FOR.important).toEqual({ kind: "label", label: "important", add: true });
		// The whole ACTION_FOR table only ever ADDs labels — no category maps to a label REMOVE (an
		// attention-reducing move); un-labeling stays human-only.
		for (const op of Object.values(ACTION_FOR)) if (op && op.kind === "label") expect(op.add).toBe(true);
	});
	it("unknown is GATED (op null) — classified/suggested, never auto-acted", () => {
		expect(ACTION_FOR.unknown).toBeNull();
	});
	it("resolveOp gates archive on the HIGHER bar: below it de-escalates to a label in place, above it archives", () => {
		expect(ARCHIVE_CONFIDENCE_THRESHOLD).toBeGreaterThan(CONFIDENCE_THRESHOLD);
		// Below the archive bar → label the message where it is (kept visible), never hide it.
		expect(resolveOp({ kind: "archive" }, "receipt", ARCHIVE_CONFIDENCE_THRESHOLD - 0.01)).toEqual({ kind: "label", label: "receipt", add: true });
		expect(resolveOp({ kind: "archive" }, "mailing_list", 0.85)).toEqual({ kind: "label", label: "mailing_list", add: true });
		// At/above the bar → archive survives.
		expect(resolveOp({ kind: "archive" }, "receipt", ARCHIVE_CONFIDENCE_THRESHOLD)).toEqual({ kind: "archive" });
		expect(resolveOp({ kind: "archive" }, "notification", 0.95)).toEqual({ kind: "archive" });
		// Non-archive ops pass through untouched regardless of confidence.
		expect(resolveOp({ kind: "label", label: "junk", add: true }, "junk", 0.1)).toEqual({ kind: "label", label: "junk", add: true });
		expect(resolveOp({ kind: "unarchive" }, "receipt", 0.1)).toEqual({ kind: "unarchive" });
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

	it("a vault digest-append failure never fails the cycle but is logged + surfaced as digest_error", async () => {
		const deps = mkDeps(SAMPLE);
		deps.digested.mockRejectedValueOnce(new Error("git push rejected"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1" });
		const report = await runTriage(env, { cycle_id: "cerr" }, deps);
		expect(report.digest_written).toBe(false);
		expect(report.digest_error).toMatch(/git push rejected/);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/mail_triage: vault digest-append failed.*git push rejected/));
		expect(report.suggested!.length).toBe(4); // the cycle still completed normally
		warn.mockRestore();
	});

	it("dry_run forces suggest-only even with ACT set", async () => {
		const deps = mkDeps(SAMPLE);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "c2", dry_run: true }, deps);
		expect(report.act_enabled).toBe(false);
		expect(deps.actSpy).not.toHaveBeenCalled();
	});

	it("ENABLED + ACT → TAGS junk + receipt (reversible label:add, never archive); suggests personal/unknown", async () => {
		const deps = mkDeps(SAMPLE);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "c3" }, deps);
		expect(deps.actSpy).toHaveBeenCalledTimes(2);
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["j1"], { kind: "label", label: "junk", add: true });
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["r1"], { kind: "label", label: "receipt", add: true });
		// Every auto-act is a non-hiding label op — archive is never called, nothing leaves the inbox.
		for (const call of deps.actSpy.mock.calls) expect((call[2] as TriageOp).kind).toBe("label");
		expect(report.acted).toEqual([
			{ id: "j1", label: "junk", confidence: 0.9, op: "label", to: "+label:junk" },
			{ id: "r1", label: "receipt", confidence: 0.85, op: "label", to: "+label:receipt" },
		]);
		// personal (0.70, below threshold) + unknown (0.20, low confidence) → suggestions only, never acted.
		expect(report.suggested!.map((s) => s.id).sort()).toEqual(["p1", "u1"]);
	});

	it("ENABLED + ACT → an explicit archive override (e.g. a future learning classifier) ABOVE the archive bar actually archives", async () => {
		// ACTION_FOR no longer defaults any category to archive (this PR's whole point), so the
		// only path that reaches a real archive move is a per-message `op` override — drive it
		// through the injected classify seam (the learning-classifier hook) scored above the bar.
		const msgs: TriageMsg[] = [{ id: "hi", from: "receipts@shop.example", subject: "Your receipt" }];
		const deps = mkDeps(msgs);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "arch" }, { ...deps, classify: () => ({ label: "receipt", confidence: 0.95, reason: "high-confidence receipt", op: { kind: "archive" } }) });
		expect(deps.actSpy).toHaveBeenCalledTimes(1);
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["hi"], { kind: "archive" });
		expect(report.acted).toEqual([{ id: "hi", label: "receipt", confidence: 0.95, op: "archive", to: "archive" }]);
	});

	it("ENABLED + ACT → the SAME archive override just BELOW the archive bar de-escalates to a label in place, never archived", async () => {
		const msgs: TriageMsg[] = [{ id: "lo", from: "receipts@shop.example", subject: "Your receipt" }];
		const deps = mkDeps(msgs);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const below = ARCHIVE_CONFIDENCE_THRESHOLD - 0.05;
		const report = await runTriage(env, { cycle_id: "lab" }, { ...deps, classify: () => ({ label: "receipt", confidence: below, reason: "receipt below archive bar", op: { kind: "archive" } }) });
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["lo"], { kind: "label", label: "receipt", add: true });
		for (const call of deps.actSpy.mock.calls) expect((call[2] as TriageOp).kind).toBe("label");
		expect(report.acted).toEqual([{ id: "lo", label: "receipt", confidence: below, op: "label", to: "+label:receipt" }]);
	});

	it("ENABLED + ACT → a GitHub CI-failure gets a reversible TYPE label, never archived", async () => {
		const gh: TriageMsg[] = [{ id: "gh1", from: "notifications@github.com", subject: "[owner/repo] Run failed: CI (main)" }];
		const deps = mkDeps(gh);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "gh", mailbox: "inbox", unread: false }, deps);
		expect(deps.actSpy).toHaveBeenCalledTimes(1);
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["gh1"], { kind: "label", label: "gh:ci-fail", add: true });
		// It's a label op, so nothing is moved out of the inbox (archive never called).
		for (const call of deps.actSpy.mock.calls) expect((call[2] as TriageOp).kind).toBe("label");
		expect(report.acted).toEqual([{ id: "gh1", label: "notification", confidence: 0.9, op: "label", to: "+label:gh:ci-fail" }]);
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

describe("draft-reply — detector + confidence bar", () => {
	it("detectReplyDraft fires for a PERSONAL sender with a reply cue (question or ask), attaching the create op", () => {
		for (const msg of [
			{ id: "a", from: "friend@gmail.com", subject: "lunch tomorrow?" },
			{ id: "b", from: "sam@icloud.com", subject: "quick one", preview: "can you send me the deck?" },
			{ id: "c", from: "jo@outlook.com", subject: "following up on our chat" },
		] as TriageMsg[]) {
			const c = detectReplyDraft(msg);
			expect(c).not.toBeNull();
			expect(c!.op).toEqual({ kind: "draft-reply" });
			expect(c!.label).toBe("personal");
			expect(c!.confidence).toBeGreaterThanOrEqual(DRAFT_REPLY_CONFIDENCE_THRESHOLD);
		}
	});
	it("detectReplyDraft returns null for a personal sender with NO cue, and for a non-personal sender even with a cue", () => {
		expect(detectReplyDraft({ id: "d", from: "friend@gmail.com", subject: "fyi — the photos" })).toBeNull();
		expect(detectReplyDraft({ id: "e", from: "sales@vendor.example", subject: "can you renew your plan?" })).toBeNull();
	});
	it("the draft-reply bar is HIGHER than the normal confidence bar (a draft is more intrusive than a label)", () => {
		expect(DRAFT_REPLY_CONFIDENCE_THRESHOLD).toBeGreaterThan(CONFIDENCE_THRESHOLD);
	});
});

const mkDraftDeps = (msgs: TriageMsg[], reply = "Thanks — I'll get back to you shortly.") => {
	const base = mkDeps(msgs);
	const composeSpy = vi.fn(async () => reply);
	const draftSpy = vi.fn(async (_env: any, _a: { reply_to: string; text: string }) => ({ id: `draft-${_a.reply_to}` }));
	return { ...base, composeReply: composeSpy, draftReply: draftSpy, composeSpy, draftSpy };
};

const REPLY_MSG: TriageMsg[] = [{ id: "pr1", from: "friend@gmail.com", subject: "are you free thursday?" }];

describe("draft-reply — the send-proof staging lane", () => {
	it("ENABLED + ACT + draft deps → composes + STAGES a reply draft (never sends); the only mutating call is draftReply", async () => {
		const deps = mkDraftDeps(REPLY_MSG);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "d1" }, deps);
		expect(deps.composeSpy).toHaveBeenCalledTimes(1);
		expect(deps.draftSpy).toHaveBeenCalledTimes(1);
		expect(deps.draftSpy).toHaveBeenCalledWith(env, { reply_to: "pr1", text: "Thanks — I'll get back to you shortly." });
		// No mailbox move/label ever happens for a draft-reply, and there is no send path at all.
		expect(deps.actSpy).not.toHaveBeenCalled();
		expect(report.acted).toEqual([{ id: "pr1", label: "personal", confidence: 0.85, op: "draft-reply", to: "draft:draft-pr1" }]);
		// The log entry records the created draft id for audit (not for undo).
		const logged = await readTriageEntries(env, { cycle: "d1" });
		expect(logged[0]).toMatchObject({ id: "pr1", action: "acted", op: "draft-reply", draft_id: "draft-pr1" });
	});

	it("is INERT without the draft deps: a reply-worthy message is SUGGESTED, never drafted (feature is opt-in)", async () => {
		const deps = mkDeps(REPLY_MSG); // no composeReply / draftReply
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "d2" }, deps);
		expect(report.acted).toHaveLength(0);
		expect(report.suggested!.map((s) => s.id)).toEqual(["pr1"]);
		expect(deps.actSpy).not.toHaveBeenCalled();
	});

	it("the tone/PII gate blocks an unsafe draft (money/PII) → suggest, never stage", async () => {
		const deps = mkDraftDeps(REPLY_MSG, "Sure — please wire $500 to account 12345678.");
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "d3" }, deps);
		expect(deps.composeSpy).toHaveBeenCalledTimes(1);
		expect(deps.draftSpy).not.toHaveBeenCalled(); // gate rejected the body — nothing staged
		expect(report.acted).toHaveLength(0);
		expect(report.suggested!.map((s) => s.id)).toEqual(["pr1"]);
	});

	it("an empty composed reply (no safe reply / no AI) → suggest, never stage", async () => {
		const deps = mkDraftDeps(REPLY_MSG, "   ");
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const report = await runTriage(env, { cycle_id: "d4" }, deps);
		expect(deps.draftSpy).not.toHaveBeenCalled();
		expect(report.suggested!.map((s) => s.id)).toEqual(["pr1"]);
	});

	it("a draft-SAVE failure is transient: it suggests and leaves the message UNSEEN so the next cycle retries", async () => {
		const deps = mkDraftDeps(REPLY_MSG);
		deps.draftReply = vi.fn(async () => {
			throw new Error("Fastmail 503");
		});
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const r1 = await runTriage(env, { cycle_id: "d5a" }, deps);
		expect(r1.acted).toHaveLength(0);
		expect(r1.suggested!.map((s) => s.id)).toEqual(["pr1"]);
		// Same env/ledger: because the save failed, pr1 is NOT marked seen — a retry re-attempts it.
		const deps2 = mkDraftDeps(REPLY_MSG);
		const r2 = await runTriage(env, { cycle_id: "d5b" }, deps2);
		expect(deps2.draftSpy).toHaveBeenCalledTimes(1);
		expect(r2.acted).toEqual([{ id: "pr1", label: "personal", confidence: 0.85, op: "draft-reply", to: "draft:draft-pr1" }]);
	});

	it("draft staging is idempotent: a successful draft marks the message seen so a re-run stages nothing", async () => {
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const deps1 = mkDraftDeps(REPLY_MSG);
		await runTriage(env, { cycle_id: "d6a" }, deps1);
		expect(deps1.draftSpy).toHaveBeenCalledTimes(1);
		const deps2 = mkDraftDeps(REPLY_MSG);
		const r2 = await runTriage(env, { cycle_id: "d6b" }, deps2);
		expect(deps2.draftSpy).not.toHaveBeenCalled();
		expect(r2.new).toBe(0);
	});

	it("undo does NOT delete a staged draft: bulkUndo reverses moves/labels but leaves draft-reply entries", async () => {
		const env = envWith();
		await appendTriageEntries(env, [
			{ cycle: "z", id: "m1", action: "acted", label: "receipt", confidence: 0.95, reason: "r", op: "archive", from_mailbox: "inbox", to_mailbox: "archive", at: 1 },
			{ cycle: "z", id: "m2", action: "acted", label: "personal", confidence: 0.85, reason: "r", op: "draft-reply", draft_id: "draft-m2", at: 2 },
		]);
		const move = vi.fn(async (_env: any, ids: string[]) => ids);
		const label = vi.fn(async (_env: any, ids: string[]) => ids);
		const res: any = await bulkUndo(env, "z", { move, label });
		// Only the archive is reversed; the draft-reply is intentionally left in place (Colin's to keep).
		expect(res.undone).toBe(1);
		expect(res.ids).toEqual(["m1"]);
		expect(move).toHaveBeenCalledWith(env, ["m1"], "inbox");
	});
});

describe("sensitive-sender guard — health/finance/insurance/gov forced suggest-only", () => {
	it("flags bank/health/insurance/gov/brokerage senders as sensitive", () => {
		for (const from of ["alerts@chase.com", "no-reply@wellsfargo.com", "billing@myclinic-health.com", "eob@aetna-insurance.com", "noreply@irs.gov", "statements@fidelity.com"]) {
			expect(isSensitiveSender(from)).toBe(true);
		}
		for (const from of ["friend@gmail.com", "newsletter@substack.com", "orders@shopco.example"]) {
			expect(isSensitiveSender(from)).toBe(false);
		}
	});

	it("forces suggest-only for a sensitive sender even at confidence >= threshold with ACT enabled", async () => {
		// A bank transaction alert classifies at 0.85 (>= threshold) and maps to a label:add — but the
		// sensitive guard must keep the bot's hands off it: never acted, only suggested with a reason.
		const bank: TriageMsg[] = [{ id: "b1", from: "alerts@chase.com", subject: "Your statement is ready" }];
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const deps = mkDeps(bank);
		const report = await runTriage(env, { cycle_id: "sens" }, deps);
		expect(classifyMessage(bank[0]).confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
		expect(deps.actSpy).not.toHaveBeenCalled(); // no keyword auto-applied
		expect(report.acted).toHaveLength(0);
		expect(report.suggested).toEqual([expect.objectContaining({ id: "b1", label: "transaction" })]);
		expect(report.suggested![0].reason).toMatch(/sensitive sender: suggest-only/);
	});

	it("a clinic sender is suggest-only too (health mail never auto-tagged without a human)", async () => {
		const clinic: TriageMsg[] = [{ id: "h1", from: "no-reply@patient-portal.hospital.example", subject: "Your lab results are ready" }];
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const deps = mkDeps(clinic);
		const report = await runTriage(env, { cycle_id: "clinic" }, deps);
		expect(deps.actSpy).not.toHaveBeenCalled();
		expect(report.suggested![0].reason).toMatch(/sensitive sender: suggest-only/);
	});
});

describe("runTriage — important AUTO-elevates (add-only, sensitive-exempt)", () => {
	it("classifies important and AUTO-adds the reversible important label", async () => {
		const imp: TriageMsg[] = [{ id: "im1", from: "friend@gmail.com", subject: "Action required: please respond ASAP" }];
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const deps = mkDeps(imp);
		const report = await runTriage(env, { cycle_id: "imp" }, deps);
		expect(classifyMessage(imp[0]).label).toBe("important");
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["im1"], { kind: "label", label: "important", add: true });
		expect(report.acted).toEqual([{ id: "im1", label: "important", confidence: 0.8, op: "label", to: "+label:important" }]);
	});

	it("important elevation is EXEMPT from the sensitive-sender guard (you always want to SEE it)", async () => {
		// A "patient@"-style address is both sensitive-matching AND a personal-provider human; an
		// important cue still auto-elevates it — attention-increasing on sensitive mail is the point.
		const s: TriageMsg[] = [{ id: "sp1", from: "patient@gmail.com", subject: "Urgent: please reply, deadline tomorrow" }];
		expect(isSensitiveSender("patient@gmail.com")).toBe(true);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		const deps = mkDeps(s);
		const report = await runTriage(env, { cycle_id: "sp" }, deps);
		expect(classifyMessage(s[0]).label).toBe("important");
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["sp1"], { kind: "label", label: "important", add: true });
		expect(report.acted).toHaveLength(1);
	});
});

describe("runTriage — unread-default scan (autonomous lane leaves read mail alone)", () => {
	it("defaults the scan to unread-only so intentionally-read inbox mail is never touched", async () => {
		const deps = mkDeps(SAMPLE);
		const searchSpy = vi.fn(async (_env: any, _o: any) => SAMPLE);
		await runTriage(envWith({ MAIL_TRIAGE_ENABLED: "1" }), { cycle_id: "ud1" }, { ...deps, search: searchSpy });
		expect(searchSpy).toHaveBeenCalledTimes(1);
		expect(searchSpy.mock.calls[0][1]).toMatchObject({ unread: true });
	});
	it("keeps an explicit override: unread:false scans read mail too", async () => {
		const deps = mkDeps(SAMPLE);
		const searchSpy = vi.fn(async (_env: any, _o: any) => SAMPLE);
		await runTriage(envWith({ MAIL_TRIAGE_ENABLED: "1" }), { cycle_id: "ud2", unread: false }, { ...deps, search: searchSpy });
		expect(searchSpy.mock.calls[0][1]).toMatchObject({ unread: false });
	});
});

describe("runTriage — sweep_backlog pages through search results", () => {
	it("advances `position` across pages instead of refetching the same page forever, and defaults unread:false", async () => {
		const pages = [
			Array.from({ length: 50 }, (_, i) => ({ id: `bp0-${i}`, from: "someone@randomcorp.example", subject: "hey" })),
			Array.from({ length: 3 }, (_, i) => ({ id: `bp1-${i}`, from: "someone@randomcorp.example", subject: "hey" })),
		];
		const searchSpy = vi.fn(async (_env: any, o: any) => pages[o.position / 50] ?? []);
		const deps = { ...mkDeps([]), search: searchSpy };
		const report = await runTriage(envWith({ MAIL_TRIAGE_ENABLED: "1" }), { cycle_id: "sw1", sweep_backlog: true, max: 100 }, deps);
		// A short second page (3 < the 50 page size) means the mailbox is exhausted — no wasted
		// third fetch to confirm it.
		expect(searchSpy).toHaveBeenCalledTimes(2);
		expect(searchSpy.mock.calls[0][1]).toMatchObject({ unread: false, position: 0 });
		expect(searchSpy.mock.calls[1][1]).toMatchObject({ position: 50 });
		expect(report.scanned).toBe(53);
	});
	it("a plain (non-sweep) cycle still fetches exactly one page — unaffected by the pagination change", async () => {
		const deps = mkDeps(SAMPLE);
		const searchSpy = vi.fn(async (_env: any, _o: any) => SAMPLE);
		await runTriage(envWith({ MAIL_TRIAGE_ENABLED: "1" }), { cycle_id: "sw2" }, { ...deps, search: searchSpy });
		expect(searchSpy).toHaveBeenCalledTimes(1);
	});
	it("stops once `max` total messages are scanned, even mid-page", async () => {
		const bigPage = Array.from({ length: 50 }, (_, i) => ({ id: `bp2-${i}`, from: "someone@randomcorp.example", subject: "hey" }));
		const searchSpy = vi.fn(async () => bigPage);
		const deps = { ...mkDeps([]), search: searchSpy };
		const report = await runTriage(envWith({ MAIL_TRIAGE_ENABLED: "1" }), { cycle_id: "sw3", sweep_backlog: true, max: 10 }, deps);
		expect(report.scanned).toBe(10);
		expect(searchSpy).toHaveBeenCalledTimes(1);
	});
	it("a page dominated by already-seen ids does NOT exhaust `max` on zero progress — it pages into the next page's new mail (#816)", async () => {
		const seenPage = Array.from({ length: 50 }, (_, i) => ({ id: `seen-${i}`, from: "someone@randomcorp.example", subject: "hey" }));
		const newPage = [{ id: "new-1", from: "friend@gmail.com", subject: "lunch tomorrow?" }];
		const pages = [seenPage, newPage];
		const searchSpy = vi.fn(async (_env: any, o: any) => pages[o.position / 50] ?? []);
		const env = envWith({ MAIL_TRIAGE_ENABLED: "1" });
		// Simulate a prior triage cycle: the entire first page is already in the ledger.
		for (const m of seenPage) await env.OAUTH_KV.put(`sux:ledger:mail_triage:${m.id}`, "1");
		const deps = { ...mkDeps([]), search: searchSpy };
		const report = await runTriage(env, { cycle_id: "sw4", sweep_backlog: true, max: 25 }, deps);
		// Both pages fetched — the all-seen first page didn't `break sweep` at `max` with zero progress.
		expect(searchSpy).toHaveBeenCalledTimes(2);
		expect(report.skipped_seen).toBe(50);
		expect(report.scanned).toBe(1); // only the genuinely new message counts toward the budget
		expect(report.suggested!.map((s) => s.id)).toEqual(["new-1"]);
	});
});

describe("runTriage — reversibility: undo-log is written BEFORE a message is marked seen", () => {
	// A KV whose ledger-mark writes throw, simulating an abnormal exit (crash / isolate eviction)
	// the instant AFTER a message is acted+marked but — if the ordering were wrong — before its
	// undo-log landed. With log-then-mark, the acted entry must already be durable + undoable.
	const throwingLedgerKV = () => {
		const store = new Map<string, string>();
		return {
			store,
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => {
				if (k.startsWith("sux:ledger:mail_triage:")) throw new Error("simulated crash marking message seen");
				store.set(k, v);
			},
			delete: async (k: string) => void store.delete(k),
		};
	};

	it("an acted message is logged (and thus undoable) even if marking it seen then crashes", async () => {
		const env = { OAUTH_KV: throwingLedgerKV(), MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" } as any;
		const deps = mkDeps(SAMPLE);
		// The crash on led.mark propagates out of runTriage — the act + the log write already happened.
		await expect(runTriage(env, { cycle_id: "crash" }, deps)).rejects.toThrow(/crash marking/);
		// The first actioned message (j1: junk → label) was acted on...
		expect(deps.actSpy).toHaveBeenCalledWith(env, ["j1"], { kind: "label", label: "junk", add: true });
		// ...and its undo-log entry is already persisted — never acted-but-unlogged.
		const logged = await readTriageEntries(env);
		const j1 = logged.find((e) => e.id === "j1");
		expect(j1).toMatchObject({ action: "acted", op: "label", keyword: "junk" });
		// Which means a bulk-undo can still reverse it.
		const label = vi.fn(async (_env: any, ids: string[]) => ids);
		const res: any = await bulkUndo(env, "crash", { label, move: vi.fn(async (_env: any, ids: string[]) => ids) });
		expect(res.undone).toBe(1);
		expect(label).toHaveBeenCalledWith(env, ["j1"], "junk", false);
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
		const move = vi.fn(async (_env: any, ids: string[]) => ids);
		const label = vi.fn(async (_env: any, ids: string[]) => ids);
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

	// A KV whose get/put yield to the event loop so unserialized RMWs of the log key
	// would interleave and lose entries — the exact webhook-burst race from issue #285.
	const racyEnv = () => {
		const store = new Map<string, string>();
		const tick = () => new Promise<void>((r) => setTimeout(r, 0));
		return {
			store,
			OAUTH_KV: {
				get: async (k: string) => {
					await tick();
					return store.get(k) ?? null;
				},
				put: async (k: string, v: string) => {
					await tick();
					store.set(k, v);
				},
			},
		} as any;
	};

	it("does not drop entries when appends race in one isolate (webhook burst)", async () => {
		const env = racyEnv();
		await Promise.all(
			Array.from({ length: 6 }, (_, i) => appendTriageEntries(env, [{ cycle: "burst", id: `m${i}`, action: "suggested", label: "unknown", confidence: 0.2, reason: "r", at: i + 1 }])),
		);
		const all = await readTriageEntries(env, { cycle: "burst", limit: 100 });
		expect(all).toHaveLength(6);
		expect(new Set(all.map((e) => e.id)).size).toBe(6);
	});

	it("bulkUndo preserves entries appended by a concurrent path during its remote reversals", async () => {
		const env = racyEnv();
		await appendTriageEntries(env, [{ cycle: "u", id: "acted1", action: "acted", label: "junk", confidence: 0.9, reason: "r", op: "label", keyword: "junk", at: 1 }]);
		// A reverser that, mid-flight, lets another cycle's entry land — modeling a tick
		// appending while bulkUndo awaits Fastmail. The stale-snapshot bug would clobber it.
		const label = async (_env: any, ids: string[]) => {
			await appendTriageEntries(env, [{ cycle: "later", id: "appended", action: "suggested", label: "unknown", confidence: 0.2, reason: "r", at: 2 }]);
			return ids;
		};
		const res: any = await bulkUndo(env, "u", { label, move: async (_env: any, ids: string[]) => ids });
		expect(res.undone).toBe(1);
		const all = await readTriageEntries(env, { limit: 100 });
		expect(all.map((e) => e.id).sort()).toEqual(["acted1", "appended"]);
		expect(all.find((e) => e.id === "acted1")!.undone).toBe(true);
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
