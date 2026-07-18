import type { RtEnv } from "../registry";

// The approval→learning loop (epic #228, W8). Every approve/reject that flows through
// the W1 kernel (`proposals.ts`) is a signal about which proposal KINDS Colin actually
// wants surfaced — this module turns that history into a per-kind ranking weight that
// nudges (never gates) how future proposals of the same kind are ordered.
//
// Hard constraint carried over unchanged from the epic: this ONLY reorders how
// proposals are shown. It never arms a sense, never auto-approves, never suppresses a
// kind entirely — `autonomy_status` (elsewhere) is the only thing that may ever suggest
// arming a loop, and it still never self-arms. A rejected kind still gets proposed;
// it just sorts lower within its urgency tier.

const PREFIX = "sux:learn:kind:";

export type KindStats = { approved: number; rejected: number };

async function readStats(env: RtEnv, kind: string): Promise<KindStats> {
	try {
		const raw = await env.OAUTH_KV?.get(PREFIX + kind);
		return raw ? (JSON.parse(raw) as KindStats) : { approved: 0, rejected: 0 };
	} catch {
		return { approved: 0, rejected: 0 };
	}
}

async function writeStats(env: RtEnv, kind: string, stats: KindStats): Promise<void> {
	try {
		await env.OAUTH_KV?.put(PREFIX + kind, JSON.stringify(stats));
	} catch {
		/* best-effort — a learning-signal write must never break the approve/reject it rides on */
	}
}

/** Record one approve/reject outcome for a proposal kind. Never throws — a KV hiccup
 *  here must not break the approve/reject flow it's called from. */
export async function recordOutcome(env: RtEnv, kind: string, outcome: "approved" | "rejected"): Promise<void> {
	if (!kind) return;
	const stats = await readStats(env, kind);
	if (outcome === "approved") stats.approved += 1;
	else stats.rejected += 1;
	await writeStats(env, kind, stats);
}

const WEIGHT_MIN = 0.25;
const WEIGHT_MAX = 2.5;
const NEUTRAL_WEIGHT = 1;

/** A kind's learned ranking weight: 1.0 (neutral) with no history, nudged up by
 *  approvals and down by rejections, clamped so one noisy streak can't zero out or
 *  runaway a kind's visibility. */
export async function getKindWeight(env: RtEnv, kind: string): Promise<number> {
	const { approved, rejected } = await readStats(env, kind);
	if (approved === 0 && rejected === 0) return NEUTRAL_WEIGHT;
	const raw = NEUTRAL_WEIGHT + 0.15 * approved - 0.3 * rejected;
	return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, raw));
}

/** All recorded per-kind stats + weights, for a `proposals {action:'insights'}` view. */
export async function listKindWeights(env: RtEnv, kinds: string[]): Promise<Array<{ kind: string; approved: number; rejected: number; weight: number }>> {
	const uniq = Array.from(new Set(kinds.filter(Boolean)));
	const out: Array<{ kind: string; approved: number; rejected: number; weight: number }> = [];
	for (const kind of uniq) {
		const stats = await readStats(env, kind);
		out.push({ kind, ...stats, weight: await getKindWeight(env, kind) });
	}
	return out;
}
