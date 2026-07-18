// Part 2/5 of the proactive-nudge split (#858 → #863), the centroid-drift detector on top of
// #864's signal-log substrate. Design: docs/design/archive/chunks/designs/proactive-nudge.design.md
// §1 "Centroid drift", §4 "First slice" (vault+mail emerging-topic only).
//
// Pure arithmetic, no ML training, no LLM call here — the design doc's "rules-then-LLM ladder"
// puts the phrasing-only model call in the (later) nudge-write issue, not this one. This module
// only produces candidates; nothing here writes to the daily note or any other outward surface.
//
// Domain note: the design doc's first slice is "vault+mail", but #864's InferDomain (the
// per-domain CONSENT arm) only covers the five guardrail domains (mail/purchases/calendar/
// files/health) — vault isn't one of them. Vault content is signal-logged under the `files`
// domain's arm (tagged via `source_tag`, e.g. `vault:<path>`), so the first slice reads BOTH
// `mail` and `files` and merges whichever domains are actually armed — arming one does not
// require the other, matching #864's "each domain arms independently" gate.
import { cosine } from "./_embed";
import { hasInferArm, inferSignalId, readInferSignals, type InferDomain, type InferSignal } from "./_infer";
import type { RtEnv } from "../registry";

export const EMERGING_TOPIC_DOMAINS: InferDomain[] = ["mail", "files"];

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 14 * DAY_MS;
const BASELINE_WINDOW_MS = 60 * DAY_MS;

export type DriftThresholds = {
	/** Minimum recent-window signal count before a drift score is even computed — guards against a
	 * single stray signal reading as a 100% drift from an empty/near-empty baseline. */
	minRecentCount: number;
	/** Cosine-distance floor (1 - cosine similarity) a cluster must clear to count as "emerging". */
	minDriftScore: number;
};

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = { minRecentCount: 3, minDriftScore: 0.15 };

export type DriftCandidate = {
	cluster: string;
	driftScore: number;
	evidenceIds: string[];
};

function centroid(vecs: number[][]): number[] | null {
	if (vecs.length === 0) return null;
	const dim = vecs[0].length;
	const sum = new Array<number>(dim).fill(0);
	for (const v of vecs) for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
	return sum.map((x) => x / vecs.length);
}

/**
 * Pure centroid-drift arithmetic: cosine distance between the recent-window centroid and the
 * trailing baseline centroid. Takes already-partitioned signal windows so it's testable without
 * any KV/env — the gated wrapper (`detectEmergingTopic`) does the partitioning + arm check.
 */
export function centroidDrift(recent: InferSignal[], baseline: InferSignal[], thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS): DriftCandidate | null {
	if (recent.length < thresholds.minRecentCount || baseline.length === 0) return null;
	const recentCentroid = centroid(recent.map((s) => s.vec));
	const baselineCentroid = centroid(baseline.map((s) => s.vec));
	if (!recentCentroid || !baselineCentroid) return null;
	const driftScore = 1 - cosine(recentCentroid, baselineCentroid);
	if (!Number.isFinite(driftScore) || driftScore < thresholds.minDriftScore) return null;
	return { cluster: "emerging-topic", driftScore, evidenceIds: recent.map(inferSignalId) };
}

/**
 * Gated end-to-end detector for the first slice (vault+mail): reads whichever of
 * `EMERGING_TOPIC_DOMAINS` are armed, merges their signal logs, partitions into the 14d
 * recent / 60d baseline windows, and runs `centroidDrift`. Fail-closed like the rest of
 * `_infer.ts` — killed or fully-unarmed returns `null`, never throws.
 */
export async function detectEmergingTopic(
	env: RtEnv,
	now: number,
	domains: InferDomain[] = EMERGING_TOPIC_DOMAINS,
	thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): Promise<DriftCandidate | null> {
	const armed = domains.filter((d) => hasInferArm(env, d));
	if (armed.length === 0) return null;

	const allSignals = (await Promise.all(armed.map((d) => readInferSignals(env, d)))).flat();
	const recentCutoff = now - RECENT_WINDOW_MS;
	const baselineCutoff = now - BASELINE_WINDOW_MS;
	const recent = allSignals.filter((s) => s.ts >= recentCutoff);
	const baseline = allSignals.filter((s) => s.ts >= baselineCutoff && s.ts < recentCutoff);
	return centroidDrift(recent, baseline, thresholds);
}
