// study_review — the spaced-repetition half of `study` (#1092). study.ts + the learning-
// folder cron already distill studied material into whitelisted oracle KBs, but nothing
// ever reinforces it: the pipeline stops at "synthesized into a KB" and never nudges Colin
// to go quiz himself on it again. This is detection only — a pure interval check over each
// whitelisted topic's `learned_at` provenance timestamp (already stamped by study.ts, no
// new state to track) — that feeds _agenda.ts's existing propose/digest loop the same way
// every other sense already does. No model call: the scheduling decision is arithmetic.
//
// SAFETY (fail-closed, same nested-flag shape as _imessage_reply.ts's hasImessageReply):
// STUDY_REVIEW_ENABLED unset ⇒ total no-op (dormant), and it only ever fires when
// AGENDA_ENABLED is also set (the loop it feeds). Read-only: it only lists the already-
// whitelisted topics (study.ts's own listWhitelisted) and never touches a KB.
import type { RtEnv } from "../registry";
import { listWhitelisted } from "./study";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

export const hasStudyReview = (env: RtEnv): boolean => flagOn(env.STUDY_REVIEW_ENABLED) && flagOn(env.AGENDA_ENABLED);

/** Days between review nudges for a given topic, absent a real spaced-repetition schedule
 *  to graduate against (v1 is a flat cadence, not SM-2). Overridable via
 *  STUDY_REVIEW_INTERVAL_DAYS, clamped to a sane [1,180] range. */
export const DEFAULT_REVIEW_INTERVAL_DAYS = 14;
export function reviewIntervalDays(env: RtEnv): number {
	const n = Number(env.STUDY_REVIEW_INTERVAL_DAYS);
	return Number.isFinite(n) && n > 0 ? Math.min(180, Math.floor(n)) : DEFAULT_REVIEW_INTERVAL_DAYS;
}

export type StudiedTopicRef = { topic: string; title?: string; learned_at: number };

/** A topic due for another look, plus which review CYCLE this is (floor(daysSince /
 *  interval)) — the dedupe key downstream mixes this in so the same topic fires again
 *  next interval instead of being permanently swallowed after its first nudge. */
export type DueReview = { topic: string; title?: string; learned_at: number; cycle: number };

/** Pure interval check: which studied topics are due for another look right now. A topic
 *  with no usable `learned_at` (never really whitelisted, or corrupt provenance) is
 *  skipped rather than treated as perpetually due. */
export function dueForReview(topics: StudiedTopicRef[], now: number, intervalDays: number): DueReview[] {
	const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
	if (intervalMs <= 0) return [];
	const out: DueReview[] = [];
	for (const t of topics) {
		if (!Number.isFinite(t.learned_at) || t.learned_at <= 0) continue;
		const elapsed = now - t.learned_at;
		if (elapsed < intervalMs) continue;
		out.push({ topic: t.topic, title: t.title, learned_at: t.learned_at, cycle: Math.floor(elapsed / intervalMs) });
	}
	return out;
}

/** Every whitelisted topic, reduced to what dueForReview needs — study.ts's own audit
 *  view (`action:"list"`), never a fresh distill. */
export async function studyReviewCandidates(env: RtEnv): Promise<StudiedTopicRef[]> {
	const topics = await listWhitelisted(env);
	return topics.map((t) => ({ topic: t.topic, title: t.whitelist?.title, learned_at: t.whitelist?.learned_at }));
}
