// Weekly recall digest — sux's first genuinely proactive behavior. Once a week it runs a
// fixed set of standing questions through recall's EXISTING cross-store fan-out+synthesis and
// WRITES the answers into the vault's Weekly note. It is never pushed, never emailed: the
// digest just appears in the vault, so it costs ZERO interrupt budget until Colin opens the
// note — ignorable-not-a-notification, high-signal by construction. It rides the SAME daily
// cron as mail_triage; a once-per-ISO-week ledger gate makes the daily tick a no-op six days
// out of seven.
//
// SAFETY (fail-closed): WEEKLY_RECALL_ENABLED unset ⇒ the whole cycle is a total no-op
// (dormant). recall is READ-only and the only write is a vault append (idempotent per ISO
// week) — no mailbox, no external surface, strictly LESS privileged than mail_triage. Reuses
// recall verbatim behind an injected dep so the fan-out/synthesis/injection-guarding is not
// re-implemented here; tests inject fakes instead of a live recall + vault.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { errMsg } from "./_util";

// A truthy toggle ("0"/"false"/"off"/empty ⇒ off), so an explicit WEEKLY_RECALL_ENABLED=0
// stays off rather than arming on mere presence — mirrors _mail_triage's flagOn.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The weekly recall cycle may run at all. Unset ⇒ the feature is dormant (no-op). */
export const hasWeeklyRecall = (env: RtEnv): boolean => flagOn(env.WEEKLY_RECALL_ENABLED);

/** The built-in standing questions when WEEKLY_RECALL_QUESTIONS is unset. Deliberately about
 *  open loops, upcoming time-sensitive items, and recent decisions — the things a weekly
 *  glance is for — phrased so recall can answer them from the vault/mail/files it fans across. */
export const DEFAULT_QUESTIONS = [
	"What open loops, promises, or follow-ups did I commit to recently that are still unresolved?",
	"What deadlines, appointments, or time-sensitive items are coming up in the next two weeks?",
	"What did I decide or learn recently that's worth remembering?",
];

/** At most this many standing questions per cycle — bounds the recall fan-out cost on the cron. */
export const MAX_QUESTIONS = 8;

/** The standing questions for this cycle: WEEKLY_RECALL_QUESTIONS (newline- or `;`-separated),
 *  else the built-in default set. Capped at MAX_QUESTIONS so a runaway override can't blow the
 *  cron budget. An override that parses to nothing falls back to the defaults. */
export function standingQuestions(env: RtEnv): string[] {
	const raw = String(env.WEEKLY_RECALL_QUESTIONS ?? "").trim();
	if (!raw) return DEFAULT_QUESTIONS;
	const qs = raw.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
	return qs.length ? qs.slice(0, MAX_QUESTIONS) : DEFAULT_QUESTIONS;
}

/** ISO-8601 week id ("2026-W28") for the vault owner's tz — the once-per-week ledger key AND
 *  the Weekly note filename. Thursday-anchored (ISO week-year), so late-December/early-January
 *  weeks land in the correct year. tz defaults to Pacific, matching vaultToday. */
export function isoWeek(tz?: string, now: Date = new Date()): string {
	const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
	const [y, m, d] = ymd.split("-").map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	const dow = (dt.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
	dt.setUTCDate(dt.getUTCDate() - dow + 3); // to the Thursday of this ISO week
	const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
	firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
	const week = 1 + Math.round((dt.getTime() - firstThu.getTime()) / (7 * 24 * 3600 * 1000));
	return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WeeklyRecallDeps = {
	recall: (env: RtEnv, question: string) => Promise<{ answer: string; citations: string[] }>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
};

export type WeeklyRecallOpts = { week?: string; force?: boolean };

export type WeeklyRecallSection = { question: string; answer: string; citations: string[] };

export type WeeklyRecallReport = {
	week?: string;
	dormant?: boolean;
	skipped?: boolean;
	questions?: number;
	digest_written?: boolean;
	note?: string;
};

/** Build the markdown block appended to the Weekly note: one section per standing question,
 *  its cited recall answer beneath. Read-only content — no undo handle, because nothing was
 *  mutated anywhere but the vault (and a vault edit is git-reversible like any note). */
function buildDigest(week: string, sections: WeeklyRecallSection[]): string {
	const lines: string[] = [`\n## Weekly recall — ${week} (${new Date().toISOString()})`];
	lines.push(`_${sections.length} standing question(s) · recall fan-out across your vault, files, mail, web, learned_`);
	for (const s of sections) {
		lines.push(`\n### ${s.question}`);
		lines.push(s.answer || "(no answer)");
		if (s.citations.length) lines.push(`\n_sources: ${s.citations.join(", ")}_`);
	}
	return `${lines.join("\n")}\n`;
}

/** Run one weekly-recall cycle. Fail-closed: a dormant no-op unless WEEKLY_RECALL_ENABLED.
 *  Idempotent per ISO week via the `weekly_recall` ledger — the daily cron re-fires this every
 *  day, but it does real work (recall fan-out + vault append) at most once per week and skips
 *  otherwise. The ledger is marked ONLY after a successful append, so a vault-append failure
 *  leaves the week unmarked and the next daily tick retries (never a silently-lost week). */
export async function runWeeklyRecall(env: RtEnv, opts: WeeklyRecallOpts, deps: WeeklyRecallDeps): Promise<WeeklyRecallReport> {
	if (!hasWeeklyRecall(env)) {
		return { dormant: true, note: "weekly_recall is disabled — set WEEKLY_RECALL_ENABLED to run the standing questions through recall once per ISO week and write the digest to the vault Weekly note. Fail-closed: nothing runs until the flag is set." };
	}
	const week = String(opts.week ?? isoWeek(env.VAULT_TZ));
	const led = ledger(env, "weekly_recall");
	const key = `week::${week}`;
	if (!opts.force && (await led.seen(key))) return { week, skipped: true, note: "already ran this ISO week" };

	const questions = standingQuestions(env);
	// Each recall is the full cross-store fan-out + LLM synthesis — one of the heaviest ops here.
	// Run the (independent) standing questions concurrently so the cron tick doesn't serialize up
	// to MAX_QUESTIONS multi-second calls, keeping per-question failure isolated inside the map.
	const sections: WeeklyRecallSection[] = await Promise.all(
		questions.map(async (q) => {
			try {
				const r = await deps.recall(env, q);
				return { question: q, answer: r.answer, citations: r.citations };
			} catch (e) {
				// One failing question must not sink the digest — record the failure inline and move on.
				return { question: q, answer: `(recall failed: ${errMsg(e)})`, citations: [] };
			}
		}),
	);

	try {
		await deps.digestAppend(env, `Weekly/${week}.md`, buildDigest(week, sections));
		await led.mark(key); // mark AFTER a successful write so a failed append retries next tick
		return { week, questions: questions.length, digest_written: true };
	} catch (e) {
		return { week, questions: questions.length, digest_written: false, note: `vault append failed: ${errMsg(e)}` };
	}
}

/** The real deps: recall (cross-store fan-out+synthesis) and the git-backed vault append
 *  (obsidian fn). Dynamically imported to keep the cron path from pulling these in when the
 *  feature is dormant, mirroring _mail_triage.defaultDeps. Tests inject fakes instead. */
export async function defaultDeps(): Promise<WeeklyRecallDeps> {
	const { recall } = await import("./recall");
	const { obsidian } = await import("./obsidian");
	return {
		recall: async (env, question) => {
			const r = await recall.run(env, { question });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "recall failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return { answer: String(parsed?.answer ?? ""), citations: Array.isArray(parsed?.citations) ? parsed.citations.map(String) : [] };
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
	};
}
