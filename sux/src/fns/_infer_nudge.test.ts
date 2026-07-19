import { describe, expect, it, vi } from "vitest";
import type { InferNudgeDeps } from "./_infer_nudge";
import { readInferNudgeWarmupLog, runInferNudge } from "./_infer_nudge";
import type { DriftCandidate } from "./_infer_drift";
import { readInferInferences, type InferSignal } from "./_infer";

function fakeKv() {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (k: string) => store.get(k) ?? null),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
	};
}

const baseEnv = (over: Record<string, string> = {}) => ({ OAUTH_KV: fakeKv(), VAULT_TZ: "UTC", INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1", ...over }) as any;

const CANDIDATE: DriftCandidate = { cluster: "mail+vault", driftScore: 0.4, evidenceIds: ["s1", "s2"] };

const SIGNALS: Record<string, InferSignal[]> = {
	mail: [{ id: "s1", ts: 1, vec: [1, 0], redacted_snippet: "[redacted] a lot about kayaking", source_tag: "mail:thread-1" }],
	vault: [{ id: "s2", ts: 2, vec: [0, 1], redacted_snippet: "[redacted] kayak trip notes", source_tag: "vault:note-1" }],
};

function deps(over: Partial<InferNudgeDeps> = {}): InferNudgeDeps {
	return {
		detectDrift: vi.fn(async () => CANDIDATE),
		signalsFor: vi.fn(async (_e, d) => SIGNALS[d] ?? []),
		phrase: vi.fn(async () => "I noticed a lot about kayaking lately — want me to start a note for it?"),
		digestAppend: vi.fn(async () => {}),
		...over,
	};
}

describe("runInferNudge — gating", () => {
	it("is dormant when INFER_KILL is set, even with domains armed", async () => {
		const env = baseEnv({ INFER_KILL: "1" });
		const d = deps();
		const r = await runInferNudge(env, {}, d);
		expect(r.dormant).toBe(true);
		expect(d.detectDrift).not.toHaveBeenCalled();
	});

	it("is dormant when no first-slice domain is armed", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "", INFER_ARM_VAULT: "" });
		const d = deps();
		const r = await runInferNudge(env, {}, d);
		expect(r.dormant).toBe(true);
		expect(d.detectDrift).not.toHaveBeenCalled();
	});

	it("no candidate ⇒ suppressed, no write", async () => {
		const env = baseEnv();
		const d = deps({ detectDrift: vi.fn(async () => null) });
		const r = await runInferNudge(env, {}, d);
		expect(r.suppressed).toBe("no_candidate");
		expect(d.digestAppend).not.toHaveBeenCalled();
	});

	it("below the confidence floor ⇒ suppressed, no write", async () => {
		const env = baseEnv({ INFER_NUDGE_MIN_CONFIDENCE: "0.9" });
		const d = deps();
		const r = await runInferNudge(env, {}, d);
		expect(r.suppressed).toBe("below_floor");
		expect(d.digestAppend).not.toHaveBeenCalled();
	});
});

// Warm-up is off (0 required cycles) in tests that aren't about warm-up itself, so they
// exercise the rate/dedupe/digest-write behavior directly, same as before #868.
const NO_WARMUP = { INFER_NUDGE_WARMUP_CYCLES: "0" };

describe("runInferNudge — caps", () => {
	it("fires once and writes the digest", async () => {
		const env = baseEnv(NO_WARMUP);
		const d = deps();
		const r = await runInferNudge(env, {}, d);
		expect(r.fired).toBe(true);
		expect(r.cluster).toBe("mail+vault");
		expect(d.digestAppend).toHaveBeenCalledTimes(1);
	});

	it("rate-caps a second nudge for the same cluster within 24h, even with different evidence", async () => {
		const env = baseEnv(NO_WARMUP);
		const d = deps();
		await runInferNudge(env, {}, d);
		const d2 = deps({ detectDrift: vi.fn(async () => ({ cluster: "mail+vault", driftScore: 0.9, evidenceIds: ["s3", "s4"] })) });
		// Same KV-backed env, so the rate ledger persists across the two calls.
		const r2 = await runInferNudge(env, {}, { ...d2, digestAppend: d.digestAppend });
		expect(r2.suppressed).toBe("rate_capped");
		expect(d.digestAppend).toHaveBeenCalledTimes(1);
	});

	it("dedupes the same evidence set across cooldown-window re-detections", async () => {
		const env = baseEnv({ INFER_NUDGE_COOLDOWN_DAYS: "7", ...NO_WARMUP });
		const digestAppend = vi.fn(async () => {});
		await runInferNudge(env, {}, deps({ digestAppend }));

		// Simulate the rate cap having already expired (a later day) by clearing just that
		// ledger key, so this second call reaches the dedupe check with identical evidence.
		await env.OAUTH_KV.delete("sux:ledger:infer_nudge_rate:mail+vault");
		const r2 = await runInferNudge(env, {}, deps({ digestAppend }));
		expect(r2.suppressed).toBe("deduped");
		expect(digestAppend).toHaveBeenCalledTimes(1);
	});

	it("a distinct evidence set is NOT deduped once the rate cap has cleared", async () => {
		const env = baseEnv(NO_WARMUP);
		const digestAppend = vi.fn(async () => {});
		await runInferNudge(env, {}, deps({ digestAppend }));

		await env.OAUTH_KV.delete("sux:ledger:infer_nudge_rate:mail+vault");
		const distinct = deps({ digestAppend, detectDrift: vi.fn(async () => ({ cluster: "mail+vault", driftScore: 0.5, evidenceIds: ["s9", "s10"] })) });
		const r2 = await runInferNudge(env, {}, distinct);
		expect(r2.fired).toBe(true);
		expect(digestAppend).toHaveBeenCalledTimes(2);
	});
});

describe("runInferNudge — digest block", () => {
	it("carries the why-trail, phrasing, and all four inline controls", async () => {
		const env = baseEnv(NO_WARMUP);
		const digestAppend = vi.fn(async () => {});
		const r = await runInferNudge(env, {}, deps({ digestAppend }));

		expect(digestAppend).toHaveBeenCalledTimes(1);
		const [calledEnv, path, content] = (digestAppend as any).mock.calls[0];
		expect(calledEnv).toBe(env);
		expect(path).toBe("Daily/2026-07-19.md");
		expect(content).toContain("**suggests:** I noticed a lot about kayaking lately");
		expect(content).toContain("[mail:thread-1] [redacted] a lot about kayaking");
		expect(content).toContain("[vault:note-1] [redacted] kayak trip notes");
		expect(content).toContain(`yes ${r.inferenceId!.slice(0, 8)}`);
		expect(content).toContain(`dismiss ${r.inferenceId!.slice(0, 8)}`);
		expect(content).toContain(`not-useful ${r.inferenceId!.slice(0, 8)}`);
		expect(content).toContain("never-for-this mail+vault");
	});

	it("a failed vault append surfaces an error and never marks the caps", async () => {
		const env = baseEnv(NO_WARMUP);
		const digestAppend = vi.fn(async () => {
			throw new Error("bad vault token");
		});
		const r = await runInferNudge(env, {}, deps({ digestAppend }));
		expect(r.error).toContain("vault append failed");

		// The inference record appended before the failed write must not be left orphaned —
		// it was never surfaced (no Daily-note append), so it shouldn't outlive the failed
		// cycle in the inference log either (#961).
		expect(await readInferInferences(env, "mail")).toEqual([]);
		expect(await readInferInferences(env, "vault")).toEqual([]);

		// The failed write must not have consumed the rate cap — a retry should still fire.
		const r2 = await runInferNudge(env, {}, deps({ digestAppend: vi.fn(async () => {}) }));
		expect(r2.fired).toBe(true);

		// And the retry's fresh inference record must survive (not deleted by a stale id).
		expect((await readInferInferences(env, "mail")).length + (await readInferInferences(env, "vault")).length).toBe(1);
	});
});

describe("runInferNudge — suggest-only warm-up (#868)", () => {
	it("a fresh cluster starts in warm-up: zero Daily-note writes, logged to the audit trail instead", async () => {
		const env = baseEnv();
		const digestAppend = vi.fn(async () => {});
		const r = await runInferNudge(env, {}, deps({ digestAppend }));

		expect(r.warmup).toBe(true);
		expect(r.fired).toBeUndefined();
		expect(r.cyclesRemaining).toBe(2);
		expect(digestAppend).not.toHaveBeenCalled();

		const log = await readInferNudgeWarmupLog(env, "mail+vault");
		expect(log).toHaveLength(1);
		expect(log[0].phrasing).toContain("kayaking");
		expect(log[0].wouldWriteDigest).toContain("**suggests:** I noticed a lot about kayaking lately");
		expect(log[0].evidenceIds).toEqual(["s1", "s2"]);
	});

	it("flips to a live write only once the cluster clears its warm-up threshold", async () => {
		const env = baseEnv({ INFER_NUDGE_WARMUP_CYCLES: "2" });
		const digestAppend = vi.fn(async () => {});
		const distinctCandidate = (n: number) => ({ cluster: "mail+vault", driftScore: 0.4, evidenceIds: [`s${n}`, `s${n + 1}`] });

		// Each cycle needs to clear the rate cap and evidence dedupe, so use distinct evidence
		// and clear the per-day rate ledger between cycles (mirroring the caps tests above).
		const r1 = await runInferNudge(env, {}, deps({ digestAppend, detectDrift: vi.fn(async () => distinctCandidate(1)) }));
		expect(r1.warmup).toBe(true);
		expect(r1.cyclesRemaining).toBe(1);

		await env.OAUTH_KV.delete("sux:ledger:infer_nudge_rate:mail+vault");
		const r2 = await runInferNudge(env, {}, deps({ digestAppend, detectDrift: vi.fn(async () => distinctCandidate(3)) }));
		expect(r2.warmup).toBe(true);
		expect(r2.cyclesRemaining).toBe(0);
		expect(digestAppend).not.toHaveBeenCalled();

		await env.OAUTH_KV.delete("sux:ledger:infer_nudge_rate:mail+vault");
		const r3 = await runInferNudge(env, {}, deps({ digestAppend, detectDrift: vi.fn(async () => distinctCandidate(5)) }));
		expect(r3.fired).toBe(true);
		expect(digestAppend).toHaveBeenCalledTimes(1);

		expect(await readInferNudgeWarmupLog(env, "mail+vault")).toHaveLength(2);
	});

	it("a would-fire warm-up cycle still consumes the rate cap for that cluster", async () => {
		const env = baseEnv();
		const digestAppend = vi.fn(async () => {});
		await runInferNudge(env, {}, deps({ digestAppend }));

		const r2 = await runInferNudge(env, {}, deps({ digestAppend, detectDrift: vi.fn(async () => ({ cluster: "mail+vault", driftScore: 0.9, evidenceIds: ["s7", "s8"] })) }));
		expect(r2.suppressed).toBe("rate_capped");
	});
});
