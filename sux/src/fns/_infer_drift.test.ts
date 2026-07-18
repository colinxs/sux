import { describe, expect, it, vi } from "vitest";
import { appendInferSignal, type InferSignal } from "./_infer";
import { centroidDrift, DEFAULT_DRIFT_THRESHOLDS, detectEmergingTopic } from "./_infer_drift";

function fakeKv() {
	const store = new Map<string, string>();
	const get = vi.fn(async (k: string) => store.get(k) ?? null);
	const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
	return { store, kv: { get, put } };
}

const baseEnv = (over: Record<string, string> = {}) => {
	const { kv } = fakeKv();
	return { OAUTH_KV: kv, ...over } as any;
};

const sig = (ts: number, vec: number[], tag = "mail:x"): InferSignal => ({ ts, vec, redacted_snippet: "[redacted]", source_tag: tag });

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY_MS;

describe("centroidDrift — pure arithmetic", () => {
	it("no candidate below the minimum recent count", () => {
		const recent = [sig(NOW, [1, 0])];
		const baseline = [sig(NOW - 20 * DAY_MS, [1, 0])];
		expect(centroidDrift(recent, baseline)).toBeNull();
	});

	it("no candidate with an empty baseline", () => {
		const recent = [sig(NOW, [1, 0]), sig(NOW, [1, 0]), sig(NOW, [1, 0])];
		expect(centroidDrift(recent, [])).toBeNull();
	});

	it("no candidate when recent and baseline centroids point the same way", () => {
		const recent = [sig(NOW, [1, 0]), sig(NOW, [1, 0]), sig(NOW, [1, 0])];
		const baseline = [sig(NOW - 20 * DAY_MS, [1, 0]), sig(NOW - 20 * DAY_MS, [1, 0])];
		expect(centroidDrift(recent, baseline)).toBeNull();
	});

	it("returns a candidate when the recent centroid has drifted from baseline", () => {
		const recent = [sig(NOW, [0, 1], "mail:a"), sig(NOW, [0, 1], "mail:b"), sig(NOW, [0, 1], "mail:c")];
		const baseline = [sig(NOW - 20 * DAY_MS, [1, 0]), sig(NOW - 20 * DAY_MS, [1, 0])];
		const candidate = centroidDrift(recent, baseline);
		expect(candidate).not.toBeNull();
		expect(candidate!.driftScore).toBeCloseTo(1, 5);
		expect(candidate!.evidenceIds).toEqual(["mail:a@" + NOW, "mail:b@" + NOW, "mail:c@" + NOW]);
	});

	it("respects a custom threshold", () => {
		const recent = [sig(NOW, [0.9, 0.436]), sig(NOW, [0.9, 0.436]), sig(NOW, [0.9, 0.436])];
		const baseline = [sig(NOW - 20 * DAY_MS, [1, 0]), sig(NOW - 20 * DAY_MS, [1, 0])];
		expect(centroidDrift(recent, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, minDriftScore: 0.99 })).toBeNull();
		expect(centroidDrift(recent, baseline, { ...DEFAULT_DRIFT_THRESHOLDS, minDriftScore: 0.01 })).not.toBeNull();
	});
});

describe("detectEmergingTopic — gated wrapper", () => {
	it("dormant when no domain is armed", async () => {
		const env = baseEnv();
		expect(await detectEmergingTopic(env, NOW)).toBeNull();
	});

	it("dormant when killed even if a domain is armed", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1", INFER_KILL: "1" });
		expect(await detectEmergingTopic(env, NOW)).toBeNull();
	});

	it("only reads armed domains — files signals ignored when only mail is armed", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferSignal(env, "mail", sig(NOW, [0, 1], "mail:a"));
		await appendInferSignal(env, "mail", sig(NOW, [0, 1], "mail:b"));
		await appendInferSignal(env, "mail", sig(NOW, [0, 1], "mail:c"));
		await appendInferSignal(env, "mail", sig(NOW - 20 * DAY_MS, [1, 0], "mail:d"));
		await appendInferSignal(env, "mail", sig(NOW - 20 * DAY_MS, [1, 0], "mail:e"));

		const candidate = await detectEmergingTopic(env, NOW);
		expect(candidate).not.toBeNull();
		expect(candidate!.evidenceIds).toHaveLength(3);
	});

	it("merges armed vault(files) + mail domains into one candidate", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_FILES: "1" });
		await appendInferSignal(env, "mail", sig(NOW, [0, 1], "mail:a"));
		await appendInferSignal(env, "files", sig(NOW, [0, 1], "vault:b"));
		await appendInferSignal(env, "files", sig(NOW, [0, 1], "vault:c"));
		await appendInferSignal(env, "mail", sig(NOW - 20 * DAY_MS, [1, 0], "mail:d"));
		await appendInferSignal(env, "files", sig(NOW - 20 * DAY_MS, [1, 0], "vault:e"));

		const candidate = await detectEmergingTopic(env, NOW);
		expect(candidate).not.toBeNull();
		expect(candidate!.evidenceIds.sort()).toEqual([`mail:a@${NOW}`, `vault:b@${NOW}`, `vault:c@${NOW}`].sort());
	});
});
