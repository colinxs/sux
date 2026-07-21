import { describe, expect, it, vi } from "vitest";
import { appendInferSignal } from "./_infer";
import { detectScalarAnomaly, type AnomalyRecipe } from "./_infer_anomaly";

function fakeKv() {
	const store = new Map<string, string>();
	const get = vi.fn(async (k: string) => store.get(k) ?? null);
	const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
	return { get, put };
}

const baseEnv = (over: Record<string, string> = {}) => ({ OAUTH_KV: fakeKv(), ...over }) as any;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY_MS; // arbitrary fixed instant, far from epoch to keep windows positive

const RECIPE: AnomalyRecipe = { domain: "purchases", label: "spending" };

async function seed(env: any, ts: number) {
	await appendInferSignal(env, "purchases", { ts, vec: [0], redacted_snippet: "[redacted] merchant 9.99", source_tag: "purchases:x" });
}

describe("detectScalarAnomaly — gating", () => {
	it("killed ⇒ null even with the domain armed and plenty of evidence", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1", INFER_KILL: "1" });
		for (let d = 1; d <= 14; d++) await seed(env, NOW - d * DAY_MS);
		for (let d = 20; d <= 70; d++) await seed(env, NOW - d * DAY_MS);
		expect(await detectScalarAnomaly(env, RECIPE, { now: NOW })).toBeNull();
	});

	it("domain not armed ⇒ null", async () => {
		const env = baseEnv();
		expect(await detectScalarAnomaly(env, RECIPE, { now: NOW })).toBeNull();
	});

	it("no recent evidence ⇒ null", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1" });
		for (let d = 20; d <= 70; d++) await seed(env, NOW - d * DAY_MS);
		expect(await detectScalarAnomaly(env, RECIPE, { now: NOW })).toBeNull();
	});

	it("too little baseline evidence to estimate a distribution ⇒ null", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1" });
		await seed(env, NOW - 1 * DAY_MS);
		await seed(env, NOW - 30 * DAY_MS);
		expect(await detectScalarAnomaly(env, RECIPE, { now: NOW })).toBeNull();
	});
});

describe("detectScalarAnomaly — arithmetic", () => {
	it("a steady baseline rate that continues into the recent window ⇒ null (no anomaly)", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1" });
		// ~1 signal every 5 days across both windows — same rate throughout, nothing anomalous.
		for (let d = 1; d <= 74; d += 5) await seed(env, NOW - d * DAY_MS);
		expect(await detectScalarAnomaly(env, RECIPE, { now: NOW })).toBeNull();
	});

	it("a sharp recent spike against a quiet baseline clears the default z threshold", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1" });
		// Sparse, low-variance baseline: one signal every 10 days for 60 days.
		for (let d = 20; d <= 70; d += 10) await seed(env, NOW - d * DAY_MS);
		// Recent window: a signal every single day for 14 days — a clear spike.
		for (let d = 1; d <= 14; d++) await seed(env, NOW - d * DAY_MS);

		const candidate = await detectScalarAnomaly(env, RECIPE, { now: NOW });

		expect(candidate).not.toBeNull();
		expect(candidate!.cluster).toBe("purchases:spending");
		expect(candidate!.domain).toBe("purchases");
		expect(candidate!.recentCount).toBe(14);
		expect(candidate!.zScore).toBeGreaterThanOrEqual(2);
		expect(candidate!.evidenceIds.length).toBe(14);
	});

	it("a custom threshold can suppress an anomaly that would otherwise clear the default", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1" });
		for (let d = 20; d <= 70; d += 10) await seed(env, NOW - d * DAY_MS);
		for (let d = 1; d <= 14; d++) await seed(env, NOW - d * DAY_MS);
		expect(await detectScalarAnomaly(env, RECIPE, { now: NOW, threshold: 50 })).toBeNull();
	});

	it("block-binning tiles the FULL baseline window — a signal 15-18 days old (the tail a fixed recentDays-wide span would drop) still counts (#1151)", async () => {
		const env = baseEnv({ INFER_ARM_PURCHASES: "1" });
		// One signal per day for all 60 baseline days (14..74 days ago inclusive of the 15-18 tail
		// nearest the recent window) — a perfectly uniform baseline rate.
		for (let d = 15; d <= 74; d++) await seed(env, NOW - d * DAY_MS);
		// Recent window: two signals a day — a clear spike over the uniform 1/day baseline.
		for (let d = 1; d <= 14; d++) {
			await seed(env, NOW - d * DAY_MS);
			await seed(env, NOW - d * DAY_MS + 1);
		}

		const candidate = await detectScalarAnomaly(env, RECIPE, { now: NOW });

		expect(candidate).not.toBeNull();
		// 60 baseline signals evenly tiled across 4 blocks of 15 days ⇒ mean 15, stddev 0 (each
		// block has exactly 15). The old fixed-14d-wide binning would drop the 15-18-day-old tail,
		// undercounting to 56 signals / mean 14 with the same recent count.
		expect(candidate!.baselineMean).toBe(15);
		expect(candidate!.baselineStd).toBe(0);
	});
});
