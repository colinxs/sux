// Chunk 02 of the proactive-nudge split (#858 → #863 → this issue, #865). Scope here is ONLY
// the centroid-drift detector — pure arithmetic over #864's signal log, no ML training, no LLM
// call, no nudge write. Design: docs/design/archive/chunks/designs/proactive-nudge.design.md
// §1 "Centroid drift", §4 "First slice" (vault+mail emerging-topic, gated dormant).
import { cosine } from "./_embed";
import { hasInferArm, type InferDomain, type InferSignal, isInferKilled, readInferSignals } from "./_infer";
import type { RtEnv } from "../registry";

const DAY_MS = 24 * 60 * 60 * 1000;

export type DriftCandidate = { cluster: string; driftScore: number; evidenceIds: string[] };

export type DriftOptions = {
	/** Defaults to Date.now() — pass explicitly from tests/callers for determinism. */
	now?: number;
	/** Recent-window width in days (design doc §1: 14). */
	recentDays?: number;
	/** Trailing-baseline width in days, measured back from the start of the recent window (§1: 60). */
	baselineDays?: number;
	/** Minimum cosine distance between centroids to surface a candidate. */
	threshold?: number;
};

const DEFAULTS: Required<Omit<DriftOptions, "now">> = { recentDays: 14, baselineDays: 60, threshold: 0.15 };

/** Elementwise mean of a batch of equal-dimension vectors. Empty input ⇒ empty vector. */
function centroid(vecs: number[][]): number[] {
	if (!vecs.length) return [];
	const dim = vecs[0].length;
	const sum = new Array(dim).fill(0);
	for (const v of vecs) for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
	return sum.map((s) => s / vecs.length);
}

/**
 * Centroid-drift over one or more domains' signal logs, merged into one evidence pool (the
 * first slice's "vault+mail emerging-topic" scope reads both domains together). Gated the same
 * way appendInferSignal is: a kill halts everything; a domain with no arm contributes nothing,
 * and if NONE of the requested domains are armed this returns null without touching KV further
 * than the (harmless) unarmed-domain reads already performed by readInferSignals's callers.
 * Returns null when there isn't enough evidence in both windows, or drift doesn't clear
 * `threshold` — "no candidate" is the overwhelmingly common, correct result.
 */
export async function detectCentroidDrift(env: RtEnv, domains: InferDomain[], opts: DriftOptions = {}): Promise<DriftCandidate | null> {
	if (isInferKilled(env)) return null;
	const armed = domains.filter((d) => hasInferArm(env, d));
	if (!armed.length) return null;

	const { recentDays, baselineDays, threshold } = { ...DEFAULTS, ...opts };
	const now = opts.now ?? Date.now();
	const recentCutoff = now - recentDays * DAY_MS;
	const baselineCutoff = recentCutoff - baselineDays * DAY_MS;

	const signals: InferSignal[] = [];
	for (const d of armed) signals.push(...(await readInferSignals(env, d)));

	const recent = signals.filter((s) => s.ts >= recentCutoff && s.ts <= now);
	const baseline = signals.filter((s) => s.ts >= baselineCutoff && s.ts < recentCutoff);
	if (!recent.length || !baseline.length) return null;

	const recentCentroid = centroid(recent.map((s) => s.vec));
	const baselineCentroid = centroid(baseline.map((s) => s.vec));
	const driftScore = 1 - cosine(recentCentroid, baselineCentroid);
	if (driftScore < threshold) return null;

	return { cluster: armed.slice().sort().join("+"), driftScore, evidenceIds: recent.map((s) => s.id) };
}
