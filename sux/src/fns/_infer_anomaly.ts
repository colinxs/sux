// Second detector type named by the proactive-nudge design doc (#1144, sibling to
// _infer_drift.ts's centroid drift): design doc §1 "Trend / anomaly on scalars — rolling mean +
// EWMA/z-score over health rollups or per-cluster counts (e.g. resting-HR up over 2 weeks; '12
// emails about X in 14d vs 0 in the prior 60')". Centroid drift needs an embedding space to pull
// apart (fits vault+mail's emerging-topic shape); this one only needs a COUNT per day, so it fits
// a domain like purchases where the interesting signal is "a lot more of this than usual", not
// "a new topic showed up". Same arithmetic-not-ML posture: no training, one z-score threshold.
// Design: docs/design/archive/chunks/designs/proactive-nudge.design.md §1, §4.
import { hasInferArm, isInferKilled, readInferSignals, type InferDomain } from "./_infer";
import type { RtEnv } from "../registry";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Inference recipes are DATA, not code" (design doc §1) — a new scalar-anomaly life-event is a
 *  list entry, not new logic. Only "purchases" has a signal producer today (_agenda.ts's
 *  logPurchaseSignals, #1085); "files"/"calendar"/"health" stay unwired until they get their own
 *  producer (arming their INFER_ARM_* flag alone is a no-op — see _infer.ts's ARM_ENV_KEY note). */
export type AnomalyRecipe = { domain: InferDomain; label: string };

export const ANOMALY_RECIPES: AnomalyRecipe[] = [{ domain: "purchases", label: "spending" }];

export type AnomalyCandidate = {
	cluster: string;
	domain: InferDomain;
	label: string;
	zScore: number;
	recentCount: number;
	/** Mean/stddev count over a recentDays-wide window, estimated from the baseline history — the
	 *  "what's normal for a window this size" distribution the recent window is compared against. */
	baselineMean: number;
	baselineStd: number;
	evidenceIds: string[];
};

export type AnomalyOptions = {
	/** Defaults to Date.now() — pass explicitly from tests/callers for determinism. */
	now?: number;
	/** Recent-window width in days (mirrors _infer_drift.ts's default: 14). */
	recentDays?: number;
	/** Trailing-baseline width in days, measured back from the start of the recent window. */
	baselineDays?: number;
	/** Minimum z-score to surface a candidate. */
	threshold?: number;
};

const DEFAULTS: Required<Omit<AnomalyOptions, "now">> = { recentDays: 14, baselineDays: 60, threshold: 2 };

/** Population mean + stddev of a fixed-length count series. A flat/all-zero baseline (stddev 0)
 *  would blow up a naive z-score for even a tiny recent count, so callers floor the denominator
 *  rather than trusting this raw. */
function meanStd(counts: number[]): { mean: number; std: number } {
	const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
	const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
	return { mean, std: Math.sqrt(variance) };
}

/**
 * Scalar trend/anomaly over one recipe's signal-count time series — the design doc §1 example made
 * literal: chop the trailing baseline into `recentDays`-wide blocks (60d baseline / 14d recent ⇒ 4
 * blocks), and z-score the recent window's total count against those blocks' mean/stddev ("12
 * emails about X in 14d vs 0 in the prior 60" ⇒ 4 baseline blocks of 0, mean 0, z = 12/1). Blocks
 * (not daily buckets) because count data this sparse has near-zero *daily* variance regardless of
 * whether anything's actually anomalous — comparing at the same granularity as the recent window
 * keeps the z-score meaningful instead of swamped by the denominator floor. Gated the same way
 * detectCentroidDrift is: a kill halts everything; an unarmed recipe domain returns null without
 * reading anything further. Returns null when there isn't enough baseline to estimate a
 * distribution, or the recent count doesn't clear `threshold` — "no candidate" is the
 * overwhelmingly common, correct result.
 */
export async function detectScalarAnomaly(env: RtEnv, recipe: AnomalyRecipe, opts: AnomalyOptions = {}): Promise<AnomalyCandidate | null> {
	if (isInferKilled(env)) return null;
	if (!hasInferArm(env, recipe.domain)) return null;

	const { recentDays, baselineDays, threshold } = { ...DEFAULTS, ...opts };
	const numBlocks = Math.floor(baselineDays / recentDays);
	// Fewer than 2 baseline blocks can't estimate a spread at all — a structural property of the
	// window sizes, checked before touching any data.
	if (numBlocks < 2) return null;

	const now = opts.now ?? Date.now();
	const recentCutoff = now - recentDays * DAY_MS;
	const baselineCutoff = recentCutoff - baselineDays * DAY_MS;

	const signals = await readInferSignals(env, recipe.domain);
	const recent = signals.filter((s) => s.ts >= recentCutoff && s.ts <= now);
	const baseline = signals.filter((s) => s.ts >= baselineCutoff && s.ts < recentCutoff);
	// Need at least a couple of baseline signals to estimate a distribution at all — an empty/
	// near-empty baseline can't tell "anomaly" from "this domain just started".
	if (!recent.length || baseline.length < 2) return null;

	const blockSpanMs = recentDays * DAY_MS;
	const blockCounts = new Array(numBlocks).fill(0);
	for (const s of baseline) {
		const blockIndex = Math.floor((s.ts - baselineCutoff) / blockSpanMs);
		if (blockIndex >= 0 && blockIndex < numBlocks) blockCounts[blockIndex]++;
	}
	const { mean: baselineMean, std: baselineStd } = meanStd(blockCounts);

	// Floor the denominator at 1 — a near-zero-variance baseline (e.g. all-zero) would otherwise
	// turn any small recent count into an arbitrarily large z-score.
	const zScore = (recent.length - baselineMean) / Math.max(baselineStd, 1);
	if (zScore < threshold) return null;

	return {
		cluster: `${recipe.domain}:${recipe.label}`,
		domain: recipe.domain,
		label: recipe.label,
		zScore,
		recentCount: recent.length,
		baselineMean,
		baselineStd,
		evidenceIds: recent.map((s) => s.id),
	};
}
