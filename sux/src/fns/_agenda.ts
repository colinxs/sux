// The agenda loop — the "figure out what to do" engine (docs/design/personal-agent-
// roadmap.md, epic #228, W2). It is the SENSE→DECIDE→PROPOSE half of the personal
// agent: fan out (read-only) across the senses that already exist (mail + calendar +
// Monarch, W7), run cheap deterministic DETECTORS that spot a "drop about to happen" (a
// prescription lapsing, a payment failing, an unanswered personal note, a bill due, an
// unusual charge, a low balance), and for each one RECORD a
// proposal via the W1 kernel — a reversible Todoist task that catches the drop. Then
// compose ONE calm digest of what needs Colin and deliver it: appended to the Daily
// note, and (when armed) mailed to him. The email IS the interface — see the digest
// footer's reply syntax; inbound reply-parsing (approve/snooze/reject) is _agenda_reply.ts
// (W2.1), and every proposal is also directly approvable via the `proposals` verb.
//
// North star: catch the drops, cut the noise. The detectors are all rung-0 rules (the
// cost ladder) — no model sorts your mail; every drop becomes a reversible task, so a
// 50-item inbox collapses to a 3-line "here's what's about to slip."
//
// SAFETY (fail-closed, two-stage — the BRIEFING_ENABLED/STAGE precedent):
//   • AGENDA_ENABLED unset → the whole loop is a total no-op (dormant): reads nothing,
//     proposes nothing, mails nothing.
//   • AGENDA_ENABLED set → detect + PROPOSE (record only; the proposal kernel's own
//     locks mean nothing acts until Colin approves) + append the digest to the Daily
//     note. No email yet.
//   • AGENDA_EMAIL set (requires AGENDA_ENABLED) → ALSO mail the digest to Colin's own
//     primary address. A self-addressed digest is the one send this loop can do; there
//     is no third-party send, no move/delete, no auto-approve. Everything a proposal
//     would eventually DO is a reversible Todoist add, gated behind Colin's approval.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { propose } from "../proposals";
import type { ConsolidateFindings } from "./_consolidate";
import type { CrossSemanticFindings } from "./_cross_semantic";
import { classifyMessage } from "./_mail_triage";
import { hasImessage, imessage } from "./imessage";
import { hasLunchmoney, lunchmoney } from "./lunchmoney";
import { crossOrgAllergyGaps, crossOrgMedicationAllergyConflicts, mychartConfigured, orgLabel, summarizeMyChart } from "../mychart";
import { errMsg, vaultToday } from "./_util";
import { vaultDailyDir } from "./_vaultpaths";
import { embedOne } from "./_embed";
import { appendInferSignal, hasInferArm } from "./_infer";
import { redactPII } from "./redact";
import type { WatchFindings } from "./_watch_sweep";
import type { WeeklyRecallFindings } from "./_weekly_recall";
import { dueForReview, hasStudyReview, reviewIntervalDays, studyReviewCandidates, type DueReview, type StudiedTopicRef } from "./_study_review";
import { documentRadarArmed, listTrackedDocuments, type TrackedDocumentRef } from "./_document_radar";
import { hasAI } from "../ai";
import { hasCalDav } from "./_caldav";
import { notify } from "./_notify";

// ── Gates ────────────────────────────────────────────────────────────────────
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The detect→propose→digest loop may run at all. Unset → dormant (no-op). */
export const hasAgenda = (env: RtEnv): boolean => flagOn(env.AGENDA_ENABLED);

/** The digest may additionally be MAILED to Colin's own address. Requires AGENDA_ENABLED
 *  too, so a stray AGENDA_EMAIL without the master enable never sends (fail-closed). */
export const hasAgendaEmail = (env: RtEnv): boolean => hasAgenda(env) && flagOn(env.AGENDA_EMAIL);

/** The cross-org MyChart reconciliation detector (#1005) may run. Requires AGENDA_ENABLED
 *  too (same fail-closed shape as hasAgendaEmail) — a stray MYCHART_RECONCILE_ENABLED without
 *  the master enable never fires. Off by default: this is the first mychart_* detector that
 *  reads two orgs' PHI against each other rather than one org's redacted snapshot alone. */
export const hasMychartReconcile = (env: RtEnv): boolean => hasAgenda(env) && flagOn(env.MYCHART_RECONCILE_ENABLED);

// ── Types ──────────────────────────────────────────────────────────────────────
export type MailRef = { id: string; from?: string; subject?: string; preview?: string; date?: string };
export type EventRef = { summary?: string; start?: string; end?: string; all_day?: boolean; location?: string };

export type Urgency = "today" | "soon" | "fyi";

/** A detected drop: the situation, its urgency, a de-dupe key, and the REVERSIBLE action
 *  to propose (always a Todoist add for v1 — rung-0 cheap, fits Colin's existing workflow). */
export type Drop = {
	kind: string;
	urgency: Urgency;
	dedupe: string; // stable key so a drop isn't re-proposed on every tick
	title: string; // the one-line the digest shows
	emoji: string;
	action: { fn: string; args: Record<string, unknown> };
	evidence?: unknown;
};

const task = (content: string, due?: string): Drop["action"] => ({ fn: "todoist", args: { action: "add", content, ...(due ? { due_string: due } : {}) } });

const URGENCY_RANK: Record<Urgency, number> = { today: 0, soon: 1, fyi: 2 };
const sortByUrgency = (drops: Drop[]): Drop[] => [...drops].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);

/** sortByUrgency, but within each urgency tier a kind's learned weight (W8 — approve/
 *  reject history, see fns/_learning.ts) breaks ties: a repeatedly-approved kind sorts
 *  first, a repeatedly-rejected one sinks toward the bottom of its tier. Urgency stays
 *  the primary sort — this only reorders WITHIN "today"/"soon"/"fyi", never promotes a
 *  "soon" ahead of a "today". Never suppresses a kind entirely — the epic's hard
 *  no-self-arm constraint applies here too: this only ever reorders what's shown. */
export async function rankDropsLearned(env: RtEnv, drops: Drop[]): Promise<Drop[]> {
	if (!drops.length) return drops;
	const { getKindWeight } = await import("./_learning");
	const weighted = await Promise.all(drops.map(async (d) => ({ d, w: await getKindWeight(env, d.kind) })));
	weighted.sort((a, b) => URGENCY_RANK[a.d.urgency] - URGENCY_RANK[b.d.urgency] || b.w - a.w);
	return weighted.map((x) => x.d);
}

// ── Detectors (rung-0 rules over the mail + calendar stream) ─────────────────────
// Each is a pure function: (mail|events) → Drop[]. Ordered most-consequential first.
// Cues are deliberately tight (precision over recall) — a missed drop is caught next
// tick or by the human; a false drop is a junk task Colin one-taps away.
const RX_CUE = /\b(prescription|refill|\brx\b|pharmacy|ready (for|to) pick ?up|returns? to stock|medication is ready|your (medication|prescription))\b/i;
// A payment/charge word NEAR a failure word — order-independent within a clause, because
// real subjects read "payment to Anthropic, PBC was unsuccessful" (words in between), not
// "payment unsuccessful". Also the standalone strong signals. Bounded to one clause (no
// period/newline crossed) so a newsletter mentioning both far apart doesn't trip it.
const PAYMENT_PROBLEM_CUE = /\b(payment|autopay|charge|card|transaction)\b[^.\n]{0,50}\b(unsuccessful|failed|declined|could ?n'?t be|was not (processed|completed)|reversed|past due|overdue)\b|\b(unable to (charge|process)|failed to process|card (was )?declined)\b/i;
const MEDICAL_MSG_CUE = /\b(mychart|patient portal|secure message|new (test )?results?|new message from your (care team|doctor|provider)|lab results?|visit summary|after visit)\b/i;
const APPOINTMENT_CUE = /\b(appointment|appt|reschedul|canceled? (your|the) (visit|appointment|session)|your visit|upcoming visit|intake|consultation|follow-?up (visit|appointment))\b/i;
const BILL_CUE = /\b(bill|invoice|statement (is )?ready|amount (due|owed)|balance due|minimum payment|renew(al|s)?|premium|due (on|by|date))\b/i;

/** From→identity: a real person on a personal-provider domain, per the classifier's
 *  `personal` label — reused so the "unanswered note" detector matches human mail only. */
function isPersonal(m: MailRef): boolean {
	return classifyMessage({ id: m.id, from: m.from, subject: m.subject, preview: m.preview }).label === "personal";
}

const senderName = (from?: string): string => {
	const s = String(from ?? "").trim();
	const m = s.match(/^\s*"?([^"<]+?)"?\s*</);
	return (m?.[1] ?? s.split("@")[0] ?? "someone").trim() || "someone";
};

/** The bare address out of a `From` header, bracketed ("Name <a@b.com>") or bare
 *  ("a@b.com") — used to key mailRelationshipThreads' per-contact cadence below. */
const senderEmail = (from?: string): string | undefined => {
	const s = String(from ?? "").trim();
	const raw = s.match(/<([^<>]+)>/)?.[1] ?? s.match(/[^\s<>",]+@[^\s<>",]+/)?.[0];
	return raw?.toLowerCase();
};

/** Turn the gathered mail + events into a ranked list of drops. Idempotency and the
 *  actual propose() write happen in the loop; this stays a pure, unit-testable function. */
export function detectDrops(mail: MailRef[], events: EventRef[]): Drop[] {
	const drops: Drop[] = [];
	const hayOf = (m: MailRef) => `${m.subject ?? ""} ${m.preview ?? ""}`;

	for (const m of mail) {
		const hay = hayOf(m);
		const subj = (m.subject || m.preview || "(message)").slice(0, 120);
		if (RX_CUE.test(hay)) {
			drops.push({ kind: "rx_ready", urgency: "today", dedupe: `rx::${m.id}`, title: `Prescription: ${subj}`, emoji: "💊", action: task(`Pick up / handle prescription: ${subj}`, "today"), evidence: { id: m.id, from: m.from } });
			continue; // one drop per message — the most consequential cue wins
		}
		if (PAYMENT_PROBLEM_CUE.test(hay)) {
			drops.push({ kind: "payment_problem", urgency: "today", dedupe: `pay::${m.id}`, title: `Payment problem: ${subj}`, emoji: "💳", action: task(`Resolve payment problem: ${subj}`, "today"), evidence: { id: m.id, from: m.from } });
			continue;
		}
		if (MEDICAL_MSG_CUE.test(hay)) {
			drops.push({ kind: "medical_message", urgency: "soon", dedupe: `med::${m.id}`, title: `Medical message: ${subj}`, emoji: "🏥", action: task(`Check medical message: ${subj}`), evidence: { id: m.id, from: m.from } });
			continue;
		}
		if (APPOINTMENT_CUE.test(hay)) {
			drops.push({ kind: "appointment", urgency: "soon", dedupe: `appt::${m.id}`, title: `Appointment: ${subj}`, emoji: "📅", action: task(`Confirm / reschedule appointment: ${subj}`), evidence: { id: m.id, from: m.from } });
			continue;
		}
		if (BILL_CUE.test(hay)) {
			drops.push({ kind: "bill_due", urgency: "soon", dedupe: `bill::${m.id}`, title: `Bill / deadline: ${subj}`, emoji: "🧾", action: task(`Handle bill/deadline: ${subj}`), evidence: { id: m.id, from: m.from } });
			continue;
		}
		if (isPersonal(m)) {
			const who = senderName(m.from);
			drops.push({ kind: "unanswered", urgency: "fyi", dedupe: `reply::${m.id}`, title: `Reply to ${who}: ${subj}`, emoji: "✉️", action: task(`Reply to ${who} — ${subj}`), evidence: { id: m.id, from: m.from } });
		}
	}

	// Calendar: an event in the near window that reads like an appointment → a prep nudge.
	for (const e of events) {
		if (e.summary && APPOINTMENT_CUE.test(e.summary)) {
			drops.push({ kind: "appointment_cal", urgency: "soon", dedupe: `apptcal::${e.summary}::${e.start ?? ""}`, title: `Upcoming: ${e.summary}${e.start ? ` (${e.start})` : ""}`, emoji: "📅", action: task(`Prep for: ${e.summary}${e.start ? ` (${e.start})` : ""}`), evidence: { summary: e.summary, start: e.start } });
		}
	}

	return sortByUrgency(drops);
}

/** A recent iMessage thread's LAST message only (imessage.ts has no server-side search, so the
 *  loop can't scan full history the way mailSearch does) — enough for the unanswered_text
 *  detector below. `lastFromMe` undefined means "couldn't determine" (e.g. an unreadable
 *  thread), which the detector treats the same as "already answered": fail-closed, same as
 *  every other detector here. */
export type TextThreadRef = { id: string; contact?: string; name?: string; lastText?: string; lastFromMe?: boolean; lastAt?: string; lastMessageId?: string };

/** Placeholder imessage-service returns for a message with no decodable text (reactions/
 *  tapbacks, some rich attachments) — see imessage_server.py's _decode_text (#852). Not a real
 *  text asking for a reply, so it's skipped the same as an empty/missing lastText. */
const UNPARSEABLE_TEXT = "[unparsed rich message]";

/** Texts are mail, structurally (#849): the same "unanswered personal note" cue detectDrops
 *  applies to mail applies here — a thread whose last message was sent BY THE OTHER PERSON
 *  (lastFromMe === false) is a text still waiting on a reply. `lastFromMe` anything other than
 *  exactly `false` (undefined/true) is skipped — fail-closed, mirrors every other detector's
 *  precision-over-recall stance (a missed drop is caught next tick; a false one is a junk task
 *  one tap away). A last message that's a tapback/reaction rather than real text (#852) is
 *  skipped the same way — it isn't asking for a reply. */
export function detectTextDrops(threads: TextThreadRef[]): Drop[] {
	const drops: Drop[] = [];
	for (const t of threads) {
		if (t.lastFromMe !== false) continue;
		if (!t.lastText || t.lastText === UNPARSEABLE_TEXT) continue;
		const who = t.name || t.contact || "someone";
		const preview = (t.lastText || "(message)").slice(0, 120);
		const dedupeSuffix = t.lastMessageId ?? t.lastAt ?? "";
		drops.push({ kind: "unanswered_text", urgency: "fyi", dedupe: `reply_text::${t.id}::${dedupeSuffix}`, title: `Reply to ${who} (text): ${preview}`, emoji: "💬", action: task(`Reply to ${who} (text) — ${preview}`), evidence: { id: t.id, contact: t.contact } });
	}
	return sortByUrgency(drops);
}

// ── Relationship-decay detector ("Relationship Radar", #930) ────────────────────────
// Reuses the SAME TextThreadRef stream detectTextDrops already reads (iMessage threads,
// #849) as the tracked-people population, rather than fanning `contact.search` for
// "important/starred" people as the issue first sketched — Fastmail's ContactCard (see
// mail-mcp.ts's shapeContact) carries no starred/importance field to fan against, so "the
// people who matter" is approximated as "the people you actually text" (and, per #981
// below, "the people you actually email"). Calendar co-attendance is left for a future
// pass — EventRef carries no attendee list today, so wiring it in needs a calendar-read
// change this detector alone shouldn't drive.
const RELATIONSHIP_EWMA_ALPHA = 0.3;
// Current silence must clear BOTH: at least this many multiples of the contact's own
// baseline gap, AND at least this many absolute days — the floor keeps a daily-texting
// contact's sub-1-day baseline from firing after a single ordinary quiet day.
const RELATIONSHIP_SILENCE_MULTIPLIER = 2;
const RELATIONSHIP_MIN_SILENCE_DAYS = 5;
// Only the stalest few get a drafted opener (#1210, W6) — one AI call per relationship_drop
// would scale with however many contacts have gone quiet this cycle; the detector already
// sorts by urgency/silence (sortByUrgency), so top-N is "the ones that matter most" for free.
const RELATIONSHIP_OPENER_TOP_N = 3;

/** Per-thread cadence state: the last observed message time, the EWMA'd "typical days
 *  between contact" baseline, and how many real gaps have fed it — 0 means "no baseline
 *  yet" (seen at most once ever), so detectRelationshipDrops never fires on it. */
export type RelationshipBaseline = { lastAt: string; baselineDays: number; sampleCount: number };

/** Widens the tracked-people population beyond iMessage threads (#981): turns the personal-
 *  classified senders in an already-fetched mail batch into the SAME TextThreadRef shape
 *  detectRelationshipDrops reads, keyed by the sender's own address so each contact gets one
 *  entry (the latest personal message wins). `id` is prefixed `mail:` so a mail-tracked
 *  contact's KV baseline never collides with an iMessage thread id, even for someone tracked
 *  on both channels — cadence stays PER CHANNEL, not merged across them, since mail and
 *  iMessage have no shared identity to resolve against (Fastmail's ContactCard has no
 *  phone-number field to join on). Scans the SAME mail detectDrops already reads — no
 *  separate mailSearch fan-out, so this stays as cheap as the rest of the loop's mail read. */
export function mailRelationshipThreads(mail: MailRef[]): TextThreadRef[] {
	const latest = new Map<string, { name?: string; lastAt: string }>();
	for (const m of mail) {
		if (!m.date || !isPersonal(m)) continue;
		const email = senderEmail(m.from);
		if (!email) continue;
		const existing = latest.get(email);
		if (!existing || Date.parse(m.date) > Date.parse(existing.lastAt)) latest.set(email, { name: senderName(m.from), lastAt: m.date });
	}
	return Array.from(latest.entries(), ([email, v]) => ({ id: `mail:${email}`, contact: email, name: v.name, lastAt: v.lastAt }));
}

/** Update each thread's own cadence baseline and flag a drop only when CURRENT silence
 *  significantly exceeds THAT thread's own baseline — never a fixed global threshold
 *  (mirrors detectPortfolioDrops's per-ticker drift). A thread whose `lastAt` is unchanged
 *  since the prior cycle is genuinely silent, so its silence is checked against the
 *  baseline; one whose `lastAt` HAS moved just heard from that person — that gap refines
 *  the baseline instead (bootstrapped on the very first observed gap), never flagged the
 *  same cycle a message just landed. A thread with fewer than one real gap on record
 *  (sampleCount 0 — brand new to this tracker, or seen only once ever) has no established
 *  "normal" to compare against yet and never fires — same "no prior data, nothing to
 *  compare" stance as detectPortfolioDrops's null priorAllocation.
 *
 *  `now` and every `lastAt` are epoch ms; callers pass the agenda cycle's own `date` (not
 *  wall-clock Date.now()) so the whole detector stays deterministic/testable, same as
 *  every other detector in this file. */
export function detectRelationshipDrops(
	now: number,
	threads: TextThreadRef[],
	priorBaselines: Record<string, RelationshipBaseline>,
	opts?: { silenceMultiplier?: number; minSilenceDays?: number; alpha?: number },
): { drops: Drop[]; baselines: Record<string, RelationshipBaseline> } {
	const alpha = opts?.alpha ?? RELATIONSHIP_EWMA_ALPHA;
	const silenceMultiplier = opts?.silenceMultiplier ?? RELATIONSHIP_SILENCE_MULTIPLIER;
	const minSilenceDays = opts?.minSilenceDays ?? RELATIONSHIP_MIN_SILENCE_DAYS;
	const drops: Drop[] = [];
	const baselines: Record<string, RelationshipBaseline> = { ...priorBaselines };

	for (const t of threads) {
		if (!t.lastAt) continue;
		const lastAtMs = Date.parse(t.lastAt);
		if (!Number.isFinite(lastAtMs)) continue;
		const prior = priorBaselines[t.id];

		if (!prior) {
			baselines[t.id] = { lastAt: t.lastAt, baselineDays: 0, sampleCount: 0 };
			continue; // first time this thread's been tracked — nothing to compare yet
		}
		if (prior.lastAt !== t.lastAt) {
			const priorAtMs = Date.parse(prior.lastAt);
			const gapDays = Number.isFinite(priorAtMs) ? Math.max(0, (lastAtMs - priorAtMs) / 86_400_000) : 0;
			const baselineDays = prior.sampleCount > 0 ? alpha * gapDays + (1 - alpha) * prior.baselineDays : gapDays;
			baselines[t.id] = { lastAt: t.lastAt, baselineDays, sampleCount: prior.sampleCount + 1 };
			continue; // just heard from them — a fresh data point, never a drop this same cycle
		}

		baselines[t.id] = prior;
		if (prior.sampleCount < 1) continue; // no established cadence yet
		const silenceDays = (now - lastAtMs) / 86_400_000;
		if (silenceDays < Math.max(prior.baselineDays * silenceMultiplier, minSilenceDays)) continue;
		const who = t.name || t.contact || "someone";
		drops.push({
			kind: "relationship_drop",
			urgency: "fyi",
			// Bucketed by week (not by day, unlike e.g. portfolio_drift) so an ongoing silence
			// nudges roughly weekly instead of re-proposing a fresh Todoist task every tick.
			dedupe: `relationship::${t.id}::${Math.floor(silenceDays / 7)}`,
			title: `Gone quiet on ${who} — ${Math.round(silenceDays)}d since last contact (usually ~${Math.round(prior.baselineDays)}d)`,
			emoji: "🌙",
			action: task(`Check in with ${who} — ${Math.round(silenceDays)}d quiet, unusual for you two`),
			evidence: { id: t.id, contact: t.contact, who, silenceDays, baselineDays: prior.baselineDays },
		});
	}
	return { drops: sortByUrgency(drops), baselines };
}

/** Folds a drafted opener into the top-N stalest relationship_drop findings (#1210, W6) —
 *  called from runAgenda AFTER detectRelationshipDrops, never from inside it: that detector
 *  is pure/sync/deterministic by its own contract above, and an AI call is neither. Best-
 *  effort per drop: `deps.voiceRestyle` failing (or returning null) just leaves that drop's
 *  existing plain title/content untouched — this never throws and never blocks the rest of
 *  the agenda tick. Re-proposing weekly (not daily) already falls out of detectRelationshipDrops'
 *  own `relationship::<id>::<weekOfSilence>` dedupe bucketing, so drafting piggybacks on that
 *  existing cadence instead of adding a second one here. */
async function draftRelationshipOpeners(env: RtEnv, drops: Drop[], voiceRestyle: AgendaDeps["voiceRestyle"]): Promise<Drop[]> {
	if (!hasAI(env)) return drops;
	const relationshipDrops = drops.filter((d) => d.kind === "relationship_drop").slice(0, RELATIONSHIP_OPENER_TOP_N);
	if (!relationshipDrops.length) return drops;

	const openers = new Map<Drop, string>();
	await Promise.all(
		relationshipDrops.map(async (d) => {
			const ev = d.evidence as { who?: string; contact?: string; silenceDays?: number } | undefined;
			const who = ev?.who || ev?.contact || "them";
			const days = Number.isFinite(ev?.silenceDays) ? Math.round(ev!.silenceDays!) : undefined;
			const seed = `Hey ${who}, it's been a while${days ? ` (${days}d)` : ""} — thinking of you, how are you doing?`;
			try {
				const opener = await voiceRestyle(env, seed);
				if (opener?.trim()) openers.set(d, opener.trim());
			} catch {
				// best-effort — leave this drop's plain content as-is
			}
		}),
	);
	if (!openers.size) return drops;

	return drops.map((d) => {
		const opener = openers.get(d);
		if (!opener) return d;
		const ev = d.evidence as { who?: string; contact?: string; silenceDays?: number } | undefined;
		const who = ev?.who || ev?.contact || "them";
		const days = Math.round(ev?.silenceDays ?? 0);
		return {
			...d,
			action: { ...d.action, args: { ...d.action.args, content: `Check in with ${who} — ${days}d quiet. Drafted opener: "${opener}"` } },
			evidence: { ...(d.evidence as object), opener },
		};
	});
}

// ── Follow-up detector (#1217, split from #1203 W1(b)) ──────────────────────────────
// Sent-mail threads awaiting a reply — the inverse of detectTextDrops/mailRelationshipThreads'
// "they sent last, I haven't replied" check: here I SENT last and they haven't replied.
const FOLLOW_UP_MIN_DAYS = 4;
// Scans sent mail this far back (days) for candidate threads to check.
const FOLLOW_UP_LOOKBACK_DAYS = 30;
// Caps the worst-case mail_thread round trips per cycle, same posture as textThreads' 15-thread cap.
const FOLLOW_UP_SCAN_CAP = 15;

export type FollowUpThreadRef = { id: string; subject?: string; to?: string; lastAt?: string; lastFromMe?: boolean };

/** A sent-mail thread whose LAST message was sent by me (`lastFromMe === true`) and has sat
 *  unanswered for at least `minDays` is a follow-up worth nudging on — mirrors detectTextDrops'
 *  fail-closed posture (anything other than exactly `true` is skipped: undefined "couldn't
 *  resolve who sent last" is treated the same as "they already replied"). */
export function detectFollowUpDrops(now: number, threads: FollowUpThreadRef[], opts?: { minDays?: number }): Drop[] {
	const minDays = opts?.minDays ?? FOLLOW_UP_MIN_DAYS;
	const drops: Drop[] = [];
	for (const t of threads) {
		if (t.lastFromMe !== true) continue;
		if (!t.lastAt) continue;
		const lastAtMs = Date.parse(t.lastAt);
		if (!Number.isFinite(lastAtMs)) continue;
		const days = (now - lastAtMs) / 86_400_000;
		if (days < minDays) continue;
		const who = t.to || "someone";
		const subj = t.subject || "(no subject)";
		drops.push({
			kind: "follow_up",
			urgency: "fyi",
			// Bucketed by week (mirrors relationship_drop) so an ongoing wait nudges roughly weekly
			// instead of re-proposing a fresh Todoist task every tick.
			dedupe: `follow_up::${t.id}::${Math.floor(days / 7)}`,
			title: `Follow up with ${who} — no reply in ${Math.round(days)}d: ${subj}`,
			emoji: "📮",
			action: task(`Follow up with ${who} — sent ${Math.round(days)}d ago, no reply: ${subj}`),
			evidence: { id: t.id, to: t.to, subject: subj, days },
		});
	}
	return sortByUrgency(drops);
}

/** A short, stable content fingerprint (FNV-1a) over a finding set — used to keep the agenda
 *  dedupe key sensitive to WHICH findings were proposed, not just which ISO week (#782): a
 *  forced consolidate re-run mid-week can overwrite the cache with a different slice of the
 *  vault, and a week-only key would silently swallow those fresh findings. */
function fingerprint(parts: string[]): string {
	const joined = parts.join("");
	let h = 2166136261;
	for (let i = 0; i < joined.length; i++) {
		h ^= joined.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

/** Turn consolidate's + weekly_recall's cached findings (W5) into drops — the same
 *  read-only-sense/reversible-propose contract as the mail+calendar detectors above, just
 *  fed from the two knowledge loops' last completed cycle instead of a live fan-out. Each
 *  loop already runs at most once per ISO week, but `force:true` can re-run it mid-week with
 *  different findings — so the dedupe key mixes in a content fingerprint (#782), not just the
 *  week, and the displayed/proposed count reads the sweep's real total (`_count`), not the
 *  cached-and-truncated array's `.length` (#781). */
export function detectKnowledgeDrops(consolidate: ConsolidateFindings | null, weeklyRecall: WeeklyRecallFindings | null): Drop[] {
	const drops: Drop[] = [];
	if (consolidate) {
		const staleCount = consolidate.stale_count ?? consolidate.stale.length;
		if (staleCount) {
			drops.push({
				kind: "consolidate_stale",
				urgency: "fyi",
				dedupe: `consolidate::stale::${consolidate.week}::${fingerprint([...consolidate.stale.map((s) => s.path), String(staleCount)])}`,
				title: `${staleCount} stale vault note(s) need review`,
				emoji: "🗂️",
				action: task(`Review ${staleCount} stale vault note(s) — see _meta/consolidation/${consolidate.week}.md`),
				evidence: { week: consolidate.week, paths: consolidate.stale.map((s) => s.path) },
			});
		}
		const duplicateCount = consolidate.duplicate_count ?? consolidate.duplicate_candidates.length;
		if (duplicateCount) {
			drops.push({
				kind: "consolidate_dupes",
				urgency: "fyi",
				dedupe: `consolidate::dupes::${consolidate.week}::${fingerprint([...consolidate.duplicate_candidates.map((d) => `${d.a}|${d.b}`), String(duplicateCount)])}`,
				title: `${duplicateCount} possible duplicate vault note(s)`,
				emoji: "🗂️",
				action: task(`Review ${duplicateCount} possible duplicate vault note(s) — see _meta/consolidation/${consolidate.week}.md`),
				evidence: { week: consolidate.week, pairs: consolidate.duplicate_candidates },
			});
		}
	}
	if (weeklyRecall && weeklyRecall.questions > 0) {
		drops.push({
			kind: "weekly_recall_ready",
			urgency: "fyi",
			dedupe: `weekly_recall::${weeklyRecall.week}::${weeklyRecall.content_hash}`,
			title: `Weekly recall digest ready (${weeklyRecall.questions} question${weeklyRecall.questions === 1 ? "" : "s"})`,
			emoji: "🧠",
			action: task(`Read this week's recall digest — see Weekly/${weeklyRecall.week}.md`),
			evidence: { week: weeklyRecall.week },
		});
	}
	return drops;
}

/** Turn the cross-domain-link sweep's cached findings (#785/#948) into a drop — same
 *  read-only-sense/reversible-propose contract as detectKnowledgeDrops, just fed from
 *  _cross_semantic.ts's weekly rank instead of a live cross-domain fan-out. The action is a
 *  nudge, not an apply: the sweep only ranks and caches, so acting on a candidate still
 *  needs a manual `vault_cross_link_plan` call (the durable, human-approved write). The
 *  dedupe key mixes in a content fingerprint (mirrors detectKnowledgeDrops' #782 fix), not
 *  just the week, so a forced re-rank with a different batch isn't silently swallowed. */
export function detectCrossSemanticDrops(findings: CrossSemanticFindings | null): Drop[] {
	if (!findings || findings.count <= 0) return [];
	const count = findings.count;
	return [
		{
			kind: "cross_semantic_ready",
			urgency: "fyi",
			dedupe: `cross_semantic::${findings.week}::${fingerprint([...findings.links.map((l) => `${l.vaultPath}|${l.domain}|${l.key}`), String(count)])}`,
			title: `${count} cross-domain link candidate${count === 1 ? "" : "s"} found`,
			emoji: "🔗",
			action: task(`Review ${count} cross-domain link candidate${count === 1 ? "" : "s"} — run vault_cross_link_plan to approve`),
			evidence: { week: findings.week, links: findings.links },
		},
	];
}

/** Turn the watch sweep's last cycle findings (#899) into drops — same read-only-sense/
 *  reversible-propose contract as detectKnowledgeDrops, just fed from _watch_sweep's cache
 *  instead of a live re-check. The dedupe key mixes in the new hash, not just the url/label,
 *  so a page that changes again after being proposed once produces a fresh proposal instead
 *  of being silently swallowed by the ledger. */
export function detectWatchDrops(findings: WatchFindings | null): Drop[] {
	if (!findings) return [];
	const drops: Drop[] = [];
	for (const c of findings.changed) {
		const label = c.label ? ` (${c.label})` : "";
		const hasDelta = c.numeric_value !== undefined && c.previous_numeric_value !== undefined;
		const delta = hasDelta ? ` (${c.previous_numeric_value} → ${c.numeric_value})` : "";
		drops.push({
			kind: "watch_changed",
			urgency: "fyi",
			dedupe: `watch::${c.url}::${c.label ?? ""}::${c.hash}`,
			title: `Watched page changed${label}${delta}: ${c.url}`,
			emoji: "👀",
			action: task(`Check watched page — changed${label}${delta}: ${c.url}`),
			evidence: { url: c.url, label: c.label, hash: c.hash, previous_hash: c.previous_hash, numeric_value: c.numeric_value, previous_numeric_value: c.previous_numeric_value },
		});
	}
	return sortByUrgency(drops);
}

/** Turn the studied topics due for another look (#1092) into drops — same read-only-sense/
 *  reversible-propose contract as the other detectors here, just fed from study.ts's own
 *  whitelisted-topic list instead of a live fan-out. The dedupe key mixes in the review
 *  `cycle`, not just the topic, so a topic due again next interval gets a fresh proposal
 *  instead of being silently swallowed by the ledger after its first nudge. */
export function detectStudyReviewDrops(due: DueReview[]): Drop[] {
	const drops: Drop[] = [];
	for (const d of due) {
		const label = d.title ? ` — ${d.title}` : "";
		drops.push({
			kind: "study_review_due",
			urgency: "fyi",
			dedupe: `study_review::${d.topic}::${d.cycle}`,
			title: `Review due: ${d.topic}${label}`,
			emoji: "📚",
			action: task(`Review studied material — ${d.topic}${label} (quiz yourself with oracle({problem, topic:"${d.topic}"}))`),
			evidence: { topic: d.topic, title: d.title, learned_at: d.learned_at, cycle: d.cycle },
		});
	}
	return sortByUrgency(drops);
}

/** The read-only financial-signal refs the detectors below consume (W7/W7.1), trimmed to what
 *  they need. The `Monarch*` names are retained as the internal module vocabulary, but the live
 *  data source is now Lunch Money (fns/lunchmoney.ts) — Monarch was retired. accounts/
 *  transactions/budgets are fed live; holdings/cashflow have no Lunch Money equivalent and are
 *  dormant (see defaultDeps), so the portfolio + savings-rate detectors currently stay quiet. */
export type MonarchAccountRef = { id: string; name?: string; balance?: number; type?: string; subtype?: string };
export type MonarchTxnRef = { id: string; amount?: number; date?: string; merchant?: string };
export type MonarchBudgetRef = { category?: string; categoryId?: string; remaining?: number };
export type MonarchHoldingRef = { ticker?: string; name?: string; value?: number; quantity?: number };
export type MonarchCashflowRef = { sumIncome?: number; sumExpense?: number; savings?: number; savingsRate?: number };

// A bill-like budget category, so "rent remaining $900 with 3 days left in the month" reads
// as a bill_due drop and a plain discretionary category (dining, shopping) does not.
const BILL_GROUP_CUE = /\b(bills?|utilit\w*|subscriptions?|insurance|loans?|rent|mortgage)\b/i;
// Flag a bill only once it's genuinely close — avoids a month-long "rent due" nag.
const BILL_DUE_WINDOW_DAYS = 7;
// Recent-transactions window scanned for the unusual-charge detector (days back from `date`).
const UNUSUAL_CHARGE_WINDOW_DAYS = 3;
// Recent-threads window scanned for the unanswered_text detector — imessage.ts's `threads` has
// no unread concept (unlike mailSearch's `unread:true`), so recency is the only cheap bound.
const TEXT_LOOKBACK_DAYS = 3;
// Recent-mail window scanned for the mail half of Relationship Radar (#1133) — deliberately NOT
// unread-gated (unlike detectDrops/mailSearch's inbox scan), so a contact's cadence keeps updating
// after their message is read instead of freezing the moment it's marked read. A bounded window is
// still a membership test, not a true "ever contacted" scan — too narrow and a slow-cadence contact
// falls out of it before detectRelationshipDrops' own silenceDays threshold ever fires, same freeze
// bug one step removed. 90d (matching AGENDA_RELATIONSHIP_MIN_SILENCE_DAYS' own max) comfortably
// covers the default-config drop threshold (baselineDays*2) up to a ~45d cadence; widening costs
// nothing extra server-side (mail_search's `after` filter is cheap — the `limit:50` cap below is
// what actually bounds cost, not the window width).
const RELATIONSHIP_MAIL_LOOKBACK_DAYS = 90;
// Trailing window (NOT calendar-month-to-date) for the cashflow-derived savings-rate detector —
// a fixed calendar-month window reads sharply negative for the first few days of a month before
// income posts (a biweekly/monthly paycheck lags the 1st), a pure timing artifact rather than a
// real trend (#806). A rolling window sidesteps that entirely.
const CASHFLOW_WINDOW_DAYS = 30;
// Portfolio-drift thresholds (W7.1, #803): a single ticker/security at or above this share of
// total holdings value is a concentration worth a heads-up; a swing of at least this many
// percentage points since the last check (the cached Monarch snapshot below) is a drift worth a
// heads-up. Both fyi-only — sux never trades, so every finding is a look-at-this proposal.
const PORTFOLIO_CONCENTRATION_THRESHOLD = 0.35;
const PORTFOLIO_DRIFT_THRESHOLD = 0.1;
// A savings rate this many percentage points below the last checked cycle reads as a real drop,
// not day-to-day noise in a rolling window.
const SAVINGS_RATE_DROP_THRESHOLD = 0.15;
// Subscription-creep detector (#1059, W7): needs several months of transaction history to spot
// a recurring pattern at all — far wider than unusual_charge's 3-day recency window, so the
// transactions fetch itself is widened to this and unusual_charge re-filters down to its own
// window (see detectMonarchDrops).
const SUBSCRIPTION_LOOKBACK_DAYS = 90;
// A merchant needs at least this many charges within the lookback window before its pattern is
// trusted as "recurring" rather than coincidence.
const SUBSCRIPTION_MIN_OCCURRENCES = 3;
// A recurring charge growing at least this fraction above its first-seen amount reads as creep
// (a price hike, plan upgrade, or add-on quietly stacked on) — small billing noise (tax/FX
// rounding) stays under this.
const SUBSCRIPTION_GROWTH_THRESHOLD = 0.2;
// Recurring charges above this read as a bill (rent, insurance) already covered by bill_due,
// not a subscription.
const SUBSCRIPTION_MAX_CHARGE = 200;
// defaultDeps.monarchTransactions fetch cap (financial seam now sourced from Lunch Money): its
// read-only transactions op returns one windowed page (no offset in the surface), so a single call
// over the SUBSCRIPTION_LOOKBACK_DAYS window feeds the unusual-charge + subscription-creep
// detectors. MAX bounds what one cycle ingests — a sane ceiling, not a truncation anyone should hit
// at a ~90-day window (and the fn itself caps a page at 500).
const LUNCHMONEY_TRANSACTIONS_MAX = 500;

const daysLeftInMonth = (date: string): number => {
	const d = new Date(`${date}T00:00:00Z`);
	const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	return lastDay - d.getUTCDate();
};

const PURCHASE_SIGNAL_SNIPPET_MAX = 1000;

/** Best-effort feed into the infer signal log (#864's substrate) — a no-op unless
 *  INFER_ARM_PURCHASES is set, checked first so a dormant domain costs zero embed/ledger
 *  calls (#1085: arming INFER_ARM_PURCHASES previously had zero observable effect, since
 *  nothing ever called appendInferSignal for this domain). Never throws into the caller: a
 *  failed embed/append must not affect the agenda cycle. Dedupes per transaction id via a
 *  ledger — monarchTransactions re-fetches a rolling SUBSCRIPTION_LOOKBACK_DAYS-wide window
 *  every cycle, so without a seen-set the same transaction would re-embed and re-append on
 *  every single cycle it stays inside that window. */
async function logPurchaseSignals(env: RtEnv, transactions: MonarchTxnRef[]): Promise<void> {
	if (!hasInferArm(env, "purchases")) return;
	const led = ledger(env, "agenda_infer_purchases");
	for (const t of transactions) {
		if (!(await led.markIfNew(t.id))) continue;
		try {
			const raw = `${t.merchant || "unknown merchant"} ${typeof t.amount === "number" ? t.amount.toFixed(2) : ""} ${t.date ?? ""}`.trim();
			const { redacted } = redactPII(raw);
			const snippet = redacted.slice(0, PURCHASE_SIGNAL_SNIPPET_MAX);
			const vec = await embedOne(env, snippet);
			await appendInferSignal(env, "purchases", { ts: Date.now(), vec, redacted_snippet: snippet, source_tag: `purchases:${t.id}` });
		} catch (e) {
			console.warn(`infer: purchases signal log failed for ${t.id} — ${errMsg(e)}`);
		}
	}
}

/** Turn Monarch's read-only accounts/transactions/budgets into drops (W7) — same
 *  read-only-sense/reversible-propose contract as every other detector here. Bill-due,
 *  unusual-charge, and low-balance are rung-0 threshold rules, not a model: sux never
 *  moves money, so every finding surfaces as a proposal, never an action. */
export function detectMonarchDrops(date: string, accounts: MonarchAccountRef[], transactions: MonarchTxnRef[], budgets: MonarchBudgetRef[], opts?: { lowBalanceThreshold?: number; unusualChargeThreshold?: number }): Drop[] {
	const drops: Drop[] = [];
	const lowBalanceThreshold = opts?.lowBalanceThreshold ?? 100;
	const unusualChargeThreshold = opts?.unusualChargeThreshold ?? 500;

	for (const a of accounts) {
		// Depository (checking/savings) only — a liability account (credit card, loan,
		// mortgage) reading a low balance is the opposite of a cash-crunch risk (#901).
		if (a.type !== "depository") continue;
		if (typeof a.balance !== "number" || a.balance >= lowBalanceThreshold) continue;
		const name = a.name || "account";
		drops.push({
			kind: "low_balance",
			urgency: "today",
			dedupe: `monarch::low_balance::${a.id}::${date}`,
			title: `Low balance: ${name} ($${a.balance.toFixed(2)})`,
			emoji: "🪫",
			action: task(`Check low balance on ${name} ($${a.balance.toFixed(2)})`, "today"),
			evidence: { id: a.id, balance: a.balance },
		});
	}

	// unusual_charge only cares about the recent window even though `transactions` may span the
	// wider SUBSCRIPTION_LOOKBACK_DAYS fetched for the subscription-creep scan below (#1059).
	const unusualChargeSince = addDays(date, -UNUSUAL_CHARGE_WINDOW_DAYS);
	for (const t of transactions) {
		if (typeof t.amount !== "number" || t.amount >= 0 || Math.abs(t.amount) < unusualChargeThreshold) continue;
		if (t.date && t.date < unusualChargeSince) continue;
		const who = t.merchant || "a transaction";
		const amt = Math.abs(t.amount).toFixed(2);
		drops.push({
			kind: "unusual_charge",
			urgency: "soon",
			dedupe: `monarch::unusual_charge::${t.id}`,
			title: `Unusual charge: ${who} ($${amt})`,
			emoji: "❗",
			action: task(`Review unusual charge: ${who} ($${amt})${t.date ? ` on ${t.date}` : ""}`),
			evidence: { id: t.id, amount: t.amount, merchant: t.merchant },
		});
	}

	if (daysLeftInMonth(date) <= BILL_DUE_WINDOW_DAYS) {
		const month = date.slice(0, 7);
		for (const b of budgets) {
			if (!b.category || !BILL_GROUP_CUE.test(b.category) || typeof b.remaining !== "number" || b.remaining <= 0) continue;
			const remaining = b.remaining.toFixed(2);
			drops.push({
				kind: "bill_due",
				urgency: "soon",
				dedupe: `monarch::bill_due::${b.categoryId || b.category}::${month}::${Math.round(b.remaining)}`,
				title: `Bill due soon: ${b.category} ($${remaining} remaining)`,
				emoji: "🧾",
				action: task(`Pay/handle ${b.category} — $${remaining} remaining this month`),
				evidence: { category: b.category, remaining: b.remaining, month },
			});
		}
	}

	// Subscription creep: group negative-amount charges by merchant across the whole window
	// (unlike unusual_charge above, which only cares about a single outsized transaction),
	// and flag a merchant whose charge amount has grown since its first-seen occurrence.
	const byMerchant = new Map<string, MonarchTxnRef[]>();
	for (const t of transactions) {
		if (typeof t.amount !== "number" || t.amount >= 0) continue;
		const amt = Math.abs(t.amount);
		if (amt > SUBSCRIPTION_MAX_CHARGE) continue;
		const merchant = t.merchant?.trim();
		if (!merchant) continue;
		const list = byMerchant.get(merchant) ?? [];
		list.push(t);
		byMerchant.set(merchant, list);
	}
	for (const [merchant, txns] of byMerchant) {
		if (txns.length < SUBSCRIPTION_MIN_OCCURRENCES) continue;
		const sorted = [...txns].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
		const first = Math.abs(sorted[0].amount as number);
		const latest = sorted[sorted.length - 1];
		const latestAmount = Math.abs(latest.amount as number);
		if (first <= 0 || latestAmount < first * (1 + SUBSCRIPTION_GROWTH_THRESHOLD)) continue;
		drops.push({
			kind: "subscription_creep",
			urgency: "fyi",
			dedupe: `monarch::subscription_creep::${merchant}::${Math.round(latestAmount * 100)}`,
			title: `Subscription creep: ${merchant} rose from $${first.toFixed(2)} to $${latestAmount.toFixed(2)}`,
			emoji: "📈",
			action: task(`Review recurring charge growth: ${merchant} ($${first.toFixed(2)} → $${latestAmount.toFixed(2)})`),
			evidence: { merchant, firstAmount: first, latestAmount, occurrences: sorted.length },
		});
	}

	return sortByUrgency(drops);
}

/** Per-ticker/security share of total holdings value (0..1). A holding missing a value or a
 *  ticker/name is skipped; an all-skipped or zero-value portfolio allocates nothing (an empty
 *  snapshot compares as "no prior data" next cycle, never a false 100%-drift). */
export function computePortfolioAllocation(holdings: MonarchHoldingRef[]): Record<string, number> {
	const total = holdings.reduce((sum, h) => sum + (typeof h.value === "number" ? h.value : 0), 0);
	const allocation: Record<string, number> = {};
	if (total <= 0) return allocation;
	for (const h of holdings) {
		const key = h.ticker || h.name;
		if (!key || typeof h.value !== "number") continue;
		allocation[key] = (allocation[key] ?? 0) + h.value / total;
	}
	return allocation;
}

/** Turn Monarch's read-only holdings (W7.1, #803) into concentration/drift drops — same
 *  rung-0-threshold, reversible-proposal contract as detectMonarchDrops. Concentration only
 *  needs the current snapshot; drift compares against `priorAllocation` (the last cycle's
 *  cached snapshot — see lastMonarchSnapshot/saveMonarchSnapshot below). A ticker with no prior
 *  entry (newly bought) or that dropped out of the current one (sold off) still compares
 *  against 0, so a full buy/sell reads as drift too, not just a rebalance between two holdings. */
export function detectPortfolioDrops(date: string, holdings: MonarchHoldingRef[], priorAllocation: Record<string, number> | null, opts?: { concentrationThreshold?: number; driftThreshold?: number }): Drop[] {
	const drops: Drop[] = [];
	if (!holdings.length) return drops;
	const concentrationThreshold = opts?.concentrationThreshold ?? PORTFOLIO_CONCENTRATION_THRESHOLD;
	const driftThreshold = opts?.driftThreshold ?? PORTFOLIO_DRIFT_THRESHOLD;
	const allocation = computePortfolioAllocation(holdings);
	const keys = new Set([...Object.keys(allocation), ...Object.keys(priorAllocation ?? {})]);

	for (const key of keys) {
		const pct = allocation[key] ?? 0;
		if (pct >= concentrationThreshold) {
			drops.push({
				kind: "portfolio_concentration",
				urgency: "fyi",
				dedupe: `monarch::portfolio_concentration::${key}::${date}`,
				title: `Portfolio concentration: ${key} is ${(pct * 100).toFixed(0)}% of holdings`,
				emoji: "📊",
				action: task(`Review portfolio concentration — ${key} is ${(pct * 100).toFixed(0)}% of holdings`),
				evidence: { key, pct },
			});
		}
		if (priorAllocation) {
			const priorPct = priorAllocation[key] ?? 0;
			const delta = pct - priorPct;
			if (Math.abs(delta) >= driftThreshold) {
				const dir = delta > 0 ? "up" : "down";
				drops.push({
					kind: "portfolio_drift",
					urgency: "fyi",
					dedupe: `monarch::portfolio_drift::${key}::${date}`,
					title: `Portfolio drift: ${key} ${dir} ${(Math.abs(delta) * 100).toFixed(0)}pt since last check`,
					emoji: "📈",
					action: task(`Review portfolio drift — ${key} moved ${dir} ${(Math.abs(delta) * 100).toFixed(0)}pt since last check`),
					evidence: { key, pct, priorPct, delta },
				});
			}
		}
	}
	return sortByUrgency(drops);
}

/** Monarch's raw cashflow `savingsRate` field's scale (fraction like 0.23, vs a whole
 *  percentage like 23) is undocumented anywhere in the repo or Monarch's unofficial schema
 *  (#807) — derive a self-consistent fraction from sumIncome/savings whenever both are present,
 *  and only fall back to the raw field when income is missing. Any future cashflow consumer
 *  doing percentage math should do the same rather than trust the raw field's scale directly. */
export function computeSavingsRate(cf: MonarchCashflowRef | null | undefined): number | undefined {
	if (!cf) return undefined;
	if (typeof cf.sumIncome === "number" && cf.sumIncome !== 0 && typeof cf.savings === "number") return cf.savings / cf.sumIncome;
	return typeof cf.savingsRate === "number" ? cf.savingsRate : undefined;
}

/** Turn a savings-rate reading (already derived over a trailing CASHFLOW_WINDOW_DAYS window,
 *  never calendar-month-to-date — see CASHFLOW_WINDOW_DAYS's note, #806) into a drop. A
 *  negative rate always flags — spending more than earning over the trailing window is worth a
 *  look regardless of history, and the rolling window means it's never just a start-of-month
 *  timing artifact. A rate that's dropped sharply from the last checked cycle flags too, once a
 *  prior snapshot exists. */
export function detectSavingsRateDrop(date: string, rate: number | undefined, priorRate: number | null, opts?: { dropThreshold?: number }): Drop[] {
	if (typeof rate !== "number" || !Number.isFinite(rate)) return [];
	const dropThreshold = opts?.dropThreshold ?? SAVINGS_RATE_DROP_THRESHOLD;
	const month = date.slice(0, 7);
	const pct = (rate * 100).toFixed(0);
	if (rate < 0) {
		return [
			{
				kind: "savings_rate_negative",
				urgency: "soon",
				dedupe: `monarch::savings_rate_negative::${month}::${Math.round(rate * 100)}`,
				title: `Savings rate negative this cycle (${pct}%)`,
				emoji: "📉",
				action: task(`Review spending — savings rate is negative this cycle (${pct}%)`),
				evidence: { rate, priorRate },
			},
		];
	}
	if (typeof priorRate === "number" && priorRate - rate >= dropThreshold) {
		return [
			{
				kind: "savings_rate_drop",
				urgency: "fyi",
				dedupe: `monarch::savings_rate_drop::${month}::${Math.round(rate * 100)}`,
				title: `Savings rate dropped to ${pct}% (was ${(priorRate * 100).toFixed(0)}%)`,
				emoji: "📉",
				action: task(`Review savings rate drop — now ${pct}%, was ${(priorRate * 100).toFixed(0)}%`),
				evidence: { rate, priorRate },
			},
		];
	}
	return [];
}

/** The ledger key holding the last cycle's Monarch snapshot (portfolio allocation + savings
 *  rate) — the "since the last check" baseline detectPortfolioDrops/detectSavingsRateDrop
 *  compare against. Same bounded-single-entry ledger-cache shape as consolidate/weekly_recall's
 *  cross-loop wiring (patterns-and-conventions.md §5c), just self-referential: this loop caches
 *  its own prior reading instead of consuming another loop's findings. */
const MONARCH_SNAPSHOT_KEY = "last-snapshot";

export type MonarchSnapshot = { date: string; allocation: Record<string, number>; savingsRate?: number };

async function lastMonarchSnapshot(env: RtEnv): Promise<MonarchSnapshot | null> {
	const raw = await ledger(env, "agenda_monarch").get(MONARCH_SNAPSHOT_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.date !== "string" || !parsed.allocation || typeof parsed.allocation !== "object") return null;
		return { date: parsed.date, allocation: parsed.allocation, savingsRate: typeof parsed.savingsRate === "number" ? parsed.savingsRate : undefined };
	} catch {
		return null;
	}
}

async function saveMonarchSnapshot(env: RtEnv, snapshot: MonarchSnapshot): Promise<void> {
	await ledger(env, "agenda_monarch").mark(MONARCH_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

/** MyChart's last-pull summary (W6), trimmed to what the detector below needs — see
 *  mychart.ts's summarizeMyChart for the full (already-redacted) shape. */
export type MyChartLabFlagRef = { id: string; category: string; direction: string };
export type MyChartRefillDueRef = { id: string; name?: string; dueDate?: string };
export type MyChartEntryRef = { id: string; docType?: string };
export type MyChartConflictRef = { medOrg: string; medId: string; medName: string; allergyOrg: string; allergyId: string; allergySubstance: string };
export type MyChartAllergyGapRef = { org: string; allergyId: string; allergySubstance: string; missingOrg: string };

/** Turn MyChart's redacted last-pull summary (mychart.ts's summarizeMyChart — never raw lab
 *  values or diagnosis names, see its docstring) into drops — same read-only-sense/reversible-
 *  propose contract as every other detector here. Every drop just says "go check MyChart"; sux
 *  never surfaces the clinical specifics itself, only enough to prompt action (a direction, a
 *  medication name + due date, a generic document type). Dedupe is purely by FHIR resource id (no
 *  date), so — like detectMonarchDrops's unusual_charge — each flagged result/condition/document/
 *  refill proposes ONCE ever. That's what makes this "new since last check" without a separate
 *  cursor: a resource id only ever shows up as a fresh drop the first cycle it's seen. */
export function detectMyChartDrops(labFlags: MyChartLabFlagRef[], refillsDue: MyChartRefillDueRef[], newConditions: MyChartEntryRef[], newDocuments: MyChartEntryRef[]): Drop[] {
	const drops: Drop[] = [];
	for (const f of labFlags) {
		const label = f.category === "vital-signs" ? "Vital sign" : "Lab result";
		drops.push({
			kind: "mychart_lab_flag",
			urgency: "soon",
			dedupe: `mychart::lab_flag::${f.id}`,
			title: `${label} flagged ${f.direction} — check MyChart`,
			emoji: "🩺",
			action: task(`Review flagged ${label.toLowerCase()} in MyChart`),
			evidence: { id: f.id, category: f.category, direction: f.direction },
		});
	}
	for (const r of refillsDue) {
		const name = r.name || "medication";
		drops.push({
			kind: "mychart_refill_due",
			urgency: "soon",
			dedupe: `mychart::refill_due::${r.id}`,
			title: `Medication refill due soon: ${name}${r.dueDate ? ` (by ${r.dueDate})` : ""}`,
			emoji: "💊",
			action: task(`Request refill: ${name}`, r.dueDate),
			evidence: { id: r.id, dueDate: r.dueDate },
		});
	}
	for (const c of newConditions) {
		drops.push({
			kind: "mychart_new_condition",
			urgency: "soon",
			dedupe: `mychart::new_condition::${c.id}`,
			title: "New condition added to your chart — check MyChart",
			emoji: "🏥",
			action: task("Review new condition in MyChart"),
			evidence: { id: c.id },
		});
	}
	for (const d of newDocuments) {
		drops.push({
			kind: "mychart_new_document",
			urgency: "fyi",
			dedupe: `mychart::new_document::${d.id}`,
			title: `New document in your chart${d.docType ? `: ${d.docType}` : ""} — check MyChart`,
			emoji: "📄",
			action: task(`Review new document in MyChart${d.docType ? `: ${d.docType}` : ""}`),
			evidence: { id: d.id, docType: d.docType },
		});
	}
	return sortByUrgency(drops);
}

/** Cross-org medication/allergy overlap (#1005): mychart.ts's summarizeMyChart merges every
 *  connected org's redacted findings into one flat list, but never cross-references org A's
 *  data against org B's — the real continuity-of-care gap where org B's specialist has no
 *  idea org A's PCP started a medication that textually overlaps an allergy only org B's chart
 *  carries. mychart.ts's crossOrgMedicationAllergyConflicts does the deliberately conservative
 *  (name/substance-string only, never dosage/severity/diagnostic) matching; this only turns
 *  each hit into a drop at the same sensitivity level as the other mychart_* kinds (a
 *  medication name + a generic org label, never a diagnosis) — always phrased as "may overlap"
 *  / "verify with your provider", never a claim. Dedupe is the med+allergy resource-id pair, so
 *  — like every other mychart_* kind — a given pair proposes once ever. */
export function detectMychartConflictDrops(conflicts: MyChartConflictRef[]): Drop[] {
	return sortByUrgency(
		conflicts.map((c) => ({
			kind: "mychart_conflict",
			urgency: "today" as const,
			dedupe: `mychart::conflict::${c.medOrg}:${c.medId}::${c.allergyOrg}:${c.allergyId}`,
			title: `Medication "${c.medName}" (${orgLabel(c.medOrg)}) may overlap an allergy on file at ${orgLabel(c.allergyOrg)} — verify with your provider`,
			emoji: "⚠️",
			action: task(`Ask your provider: does ${c.medName} conflict with the allergy on file at ${orgLabel(c.allergyOrg)}?`),
			evidence: { medOrg: c.medOrg, medId: c.medId, allergyOrg: c.allergyOrg, allergyId: c.allergyId },
		})),
	);
}

/** One-sided allergy continuity gap (#1009): mychart.ts's crossOrgAllergyGaps flags an allergy
 *  on file at one org with NO matching record at all at another connected org — distinct from
 *  detectMychartConflictDrops's med↔allergy overlap, and arguably higher continuity-of-care value
 *  (a provider with zero visibility into a known allergy, not just a textual overlap to verify).
 *  Same sensitivity level as the other mychart_* kinds (a generic org label, never the allergy's
 *  clinical detail beyond the substance name already on file at the SOURCE org). Dedupe is the
 *  allergy+missing-org pair, so — like mychart_conflict — a given pair proposes once ever. */
export function detectMychartAllergyGapDrops(gaps: MyChartAllergyGapRef[]): Drop[] {
	return sortByUrgency(
		gaps.map((g) => ({
			kind: "mychart_allergy_gap",
			urgency: "today" as const,
			dedupe: `mychart::allergy_gap::${g.org}:${g.allergyId}::${g.missingOrg}`,
			title: `Allergy "${g.allergySubstance}" on file at ${orgLabel(g.org)} has no record at ${orgLabel(g.missingOrg)} — let them know`,
			emoji: "⚠️",
			action: task(`Tell ${orgLabel(g.missingOrg)} about your ${g.allergySubstance} allergy (on file at ${orgLabel(g.org)}, not there)`),
			evidence: { org: g.org, allergyId: g.allergyId, missingOrg: g.missingOrg },
		})),
	);
}

const DOC_RADAR_DAY_MS = 24 * 60 * 60 * 1000;
const DOCUMENT_RADAR_WARN_DAYS = 30;

/** Silently-expiring personal legal/ID documents (passport, driver's license, insurance card,
 *  warranty, registration — #1148), the same "drop about to happen" shape as MyChart's Rx
 *  refills and Monarch's bills, but sourced from _document_radar.ts's tracked-document vault
 *  notes (written by that sweep, or by hand) instead of a live API. Dedupe includes the expiry
 *  date itself so a renewed document (new expiry_date in its note) proposes again, same as
 *  every other date-keyed dedupe in this file. */
export function detectDocumentExpiryDrops(today: string, docs: TrackedDocumentRef[], opts?: { warnDays?: number }): Drop[] {
	const warnDays = opts?.warnDays ?? DOCUMENT_RADAR_WARN_DAYS;
	const todayMs = Date.parse(`${today}T00:00:00Z`);
	const drops: Drop[] = [];
	for (const doc of docs) {
		if (!doc.expiryDate) continue;
		const expiryMs = Date.parse(`${doc.expiryDate}T00:00:00Z`);
		if (!Number.isFinite(expiryMs)) continue;
		const daysLeft = Math.round((expiryMs - todayMs) / DOC_RADAR_DAY_MS);
		if (daysLeft > warnDays) continue;
		const label = doc.label || doc.docType || "document";
		const urgency: Urgency = daysLeft <= 7 ? "today" : "soon";
		const title = daysLeft < 0 ? `${label} expired ${-daysLeft}d ago — renew it` : `${label} expires in ${daysLeft}d (${doc.expiryDate}) — renew it`;
		drops.push({
			kind: "document_expiry",
			urgency,
			dedupe: `document_radar::expiry::${doc.path}::${doc.expiryDate}`,
			title,
			emoji: "🪪",
			action: task(`Renew ${label}`, doc.expiryDate),
			evidence: { path: doc.path, docType: doc.docType, expiryDate: doc.expiryDate, daysLeft },
		});
	}
	return sortByUrgency(drops);
}

// ── Task-deadline detector (split from #1203's "(a) deadline extraction" — the follow-up
// detector (b) and ask-me-by-email (d) are tracked separately in #1217; (c) last-contacted
// staleness already shipped via #930/#981's detectRelationshipDrops) ─────────────────────
// A CalDAV VTODO's own `due` date is already-structured — no text-extraction needed, unlike
// BILL_CUE's regex-over-mail-subject heuristic above. The agenda loop's calEvents dep already
// EXCLUDES task calendars (`!c.isTasks`, see defaultDeps), so a task's due date has never once
// been surfaced here; this closes that gap the same "date about to slip" shape
// detectDocumentExpiryDrops uses for tracked documents.
export type TaskRef = { uid?: string; summary?: string; due?: string; status?: string; href?: string };

const TASK_DEADLINE_WARN_DAYS_DEFAULT = 3;

/** Tasks (VTODO) whose `due` lands within `warnDays` (default 3) or is already overdue.
 *  A completed task (status === "COMPLETED", case-insensitive) never fires — its deadline
 *  already landed. A task with no `due` or no `uid` is skipped (nothing to dedupe against). */
export function detectTaskDeadlineDrops(today: string, tasks: TaskRef[], opts?: { warnDays?: number }): Drop[] {
	const warnDays = opts?.warnDays ?? TASK_DEADLINE_WARN_DAYS_DEFAULT;
	const todayMs = Date.parse(`${today}T00:00:00Z`);
	const drops: Drop[] = [];
	for (const t of tasks) {
		if (!t.uid || !t.due) continue;
		if (String(t.status ?? "").toUpperCase() === "COMPLETED") continue;
		const dueMs = Date.parse(t.due);
		if (!Number.isFinite(dueMs)) continue;
		const daysLeft = Math.round((dueMs - todayMs) / DOC_RADAR_DAY_MS);
		if (daysLeft > warnDays) continue;
		const summary = t.summary || "(untitled task)";
		const urgency: Urgency = daysLeft <= 1 ? "today" : "soon";
		const title = daysLeft < 0 ? `Task overdue ${-daysLeft}d: ${summary}` : daysLeft === 0 ? `Task due today: ${summary}` : `Task due in ${daysLeft}d: ${summary}`;
		drops.push({
			kind: "task_deadline",
			urgency,
			dedupe: `task_deadline::${t.uid}::${t.due}`,
			title,
			emoji: "⏰",
			action: task(`Handle task: ${summary}`, t.due),
			evidence: { uid: t.uid, due: t.due, daysLeft },
		});
	}
	return sortByUrgency(drops);
}

/** Load each tracked thread's cached cadence baseline — one KV key per thread id, unlike
 *  Monarch's single combined snapshot, since there's no fixed shape to bound one key's size
 *  against. A missing or unparseable entry is simply absent, same as lastMonarchSnapshot
 *  returning null for a thread detectRelationshipDrops hasn't seen (enough of) before. */
async function loadRelationshipBaselines(env: RtEnv, ids: string[]): Promise<Record<string, RelationshipBaseline>> {
	const led = ledger(env, "agenda_relationship");
	const out: Record<string, RelationshipBaseline> = {};
	for (const id of ids) {
		const raw = await led.get(id);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed.lastAt === "string" && typeof parsed.baselineDays === "number" && typeof parsed.sampleCount === "number") out[id] = parsed;
		} catch {
			// skip an unparseable entry rather than fail the whole load
		}
	}
	return out;
}

async function saveRelationshipBaselines(env: RtEnv, baselines: Record<string, RelationshipBaseline>): Promise<void> {
	const led = ledger(env, "agenda_relationship");
	for (const [id, b] of Object.entries(baselines)) await led.mark(id, JSON.stringify(b));
}

// ── Digest (the email interface) ─────────────────────────────────────────────────
export type ProposedDrop = { proposalId: string; drop: Drop };

/** Compose the digest Colin reads — grouped by urgency, each line a short proposal id he
 *  can act on. The reply-syntax footer is the email interface; until the inbound parser
 *  (W2.1) lands, `proposals approve <id>` does the same. A short id (first 8 of the uuid)
 *  keeps it phone-thumb-friendly. */
export function composeDigest(date: string, proposed: ProposedDrop[]): { subject: string; body: string } {
	const shortId = (id: string) => id.slice(0, 8);
	if (!proposed.length) {
		return { subject: `sux · nothing pressing (${date})`, body: `Good morning — nothing's about to slip. Enjoy the quiet.\n\n— sux` };
	}
	const groups: Array<[Urgency, string]> = [
		["today", "Needs you today"],
		["soon", "Soon"],
		["fyi", "When you can"],
	];
	const lines: string[] = [`Good morning. Here's what's about to slip — ${proposed.length} thing${proposed.length === 1 ? "" : "s"}.`, ""];
	for (const [urg, label] of groups) {
		const items = proposed.filter((p) => p.drop.urgency === urg);
		if (!items.length) continue;
		lines.push(`**${label}**`);
		for (const p of items) lines.push(`- ${p.drop.emoji} ${p.drop.title}  \`${shortId(p.proposalId)}\``);
		lines.push("");
	}
	lines.push("—");
	lines.push("Reply to act (or just handle them yourself — this is only a reminder):");
	lines.push("`approve <id> [<id>…]` · `snooze <id> 3d` · `reject <id>`");
	lines.push(`(e.g. reply: approve ${shortId(proposed[0].proposalId)})`);
	lines.push("\n— sux");
	const subject = `sux · ${proposed.length} thing${proposed.length === 1 ? "" : "s"} need${proposed.length === 1 ? "s" : ""} you (${date})`;
	return { subject, body: lines.join("\n") };
}

function buildDigestBlock(date: string, cycle: string, emailed: boolean, d: { subject: string; body: string }): string {
	return `\n## Agenda — ${date}\n_cycle \`${cycle}\` · ${emailed ? "digest emailed" : "digest (vault only)"}_\n\n${d.body.trim()}\n`;
}

// ── Deps (injectable side-effect surface) ────────────────────────────────────────
export type AgendaDeps = {
	mailSearch: (env: RtEnv, opts: { limit: number }) => Promise<MailRef[]>;
	/** Mail feeding mailRelationshipThreads' per-contact cadence (#1133) — a recent-window scan
	 *  regardless of read state, NOT `mailSearch`'s unread-only inbox scan, so a contact's cadence
	 *  keeps updating after their message is read instead of freezing forever the moment it is. */
	mailRelationshipSearch: (env: RtEnv, opts: { since: string }) => Promise<MailRef[]>;
	calEvents: (env: RtEnv, opts: { start: string; end: string }) => Promise<EventRef[]>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
	/** Send the digest to Colin's own primary address (the one send this loop can do), and
	 *  best-effort resolve its own RFC5322 Message-ID (undefined if the lookup fails) so
	 *  runAgenda can ledger it — _agenda_reply.ts's inbound auth binds a reply to this exact
	 *  sent digest instead of trusting a guessable subject prefix alone (#937). */
	sendDigest: (env: RtEnv, subject: string, body: string) => Promise<{ messageId?: string } | void>;
	/** The vault-consolidation loop's most recent findings (W5) — a ledger-cache read, never a
	 *  fresh vault scan. */
	consolidateFindings: (env: RtEnv) => Promise<ConsolidateFindings | null>;
	/** The weekly-recall loop's most recent findings (W5) — a ledger-cache read, never a fresh
	 *  recall fan-out. */
	weeklyRecallFindings: (env: RtEnv) => Promise<WeeklyRecallFindings | null>;
	/** The watch sweep's most recent findings (#899) — a ledger-cache read, never a fresh
	 *  page re-check. */
	watchFindings: (env: RtEnv) => Promise<WatchFindings | null>;
	/** Every whitelisted `study` topic (#1092) — a KV list read, never a fresh distill. Only
	 *  called when hasStudyReview(env). */
	studyTopics: (env: RtEnv) => Promise<StudiedTopicRef[]>;
	/** The cross-domain-link sweep's most recent findings (#785/#948) — a ledger-cache
	 *  read, never a fresh cross-domain rank. */
	crossSemanticFindings: (env: RtEnv) => Promise<CrossSemanticFindings | null>;
	/** Monarch account balances (W7) — only called when hasLunchmoney(env). */
	monarchAccounts: (env: RtEnv) => Promise<MonarchAccountRef[]>;
	/** Monarch transactions in a window (W7) — only called when hasLunchmoney(env). */
	monarchTransactions: (env: RtEnv, opts: { start: string; end: string }) => Promise<MonarchTxnRef[]>;
	/** Monarch per-category budget for a month (W7) — only called when hasLunchmoney(env). */
	monarchBudgets: (env: RtEnv, opts: { month: string }) => Promise<MonarchBudgetRef[]>;
	/** Monarch cashflow income/expense/savings summary over a window (W7.1, #803) — only called
	 *  when hasLunchmoney(env). Null when Monarch has no summary for the window. */
	monarchCashflow: (env: RtEnv, opts: { start: string; end: string }) => Promise<MonarchCashflowRef | null>;
	/** Monarch investment holdings (W7.1, #803) — only called when hasLunchmoney(env). */
	monarchHoldings: (env: RtEnv) => Promise<MonarchHoldingRef[]>;
	/** Recent iMessage threads' last message, one per thread (#849) — only called when
	 *  hasImessage(env). */
	textThreads: (env: RtEnv, opts: { since: string }) => Promise<TextThreadRef[]>;
	/** MyChart's last-pulled FHIR snapshot (W6), already redacted by mychart.ts's
	 *  summarizeMyChart — only called when mychartConfigured(env). Null when never connected
	 *  (no grant) or never pulled. */
	mychartSummary: (env: RtEnv, opts: { now: string; refillWindowDays: number }) => Promise<{ labFlags: MyChartLabFlagRef[]; refillsDue: MyChartRefillDueRef[]; newConditions: MyChartEntryRef[]; newDocuments: MyChartEntryRef[] } | null>;
	/** Cross-org medication/allergy overlaps (#1005) — only called when hasMychartReconcile(env)
	 *  && mychartConfigured(env). [] when fewer than 2 orgs have ever pulled. */
	mychartConflicts: (env: RtEnv) => Promise<MyChartConflictRef[]>;
	/** Cross-org one-sided allergy gaps (#1009) — only called when hasMychartReconcile(env)
	 *  && mychartConfigured(env). [] when fewer than 2 orgs have ever pulled. */
	mychartAllergyGaps: (env: RtEnv) => Promise<MyChartAllergyGapRef[]>;
	/** Tracked-document vault notes (passport/license/insurance/warranty/registration, #1148) —
	 *  a vault scan, never a live API. Only called when documentRadarArmed(env). */
	trackedDocuments: (env: RtEnv) => Promise<TrackedDocumentRef[]>;
	/** Restyle a drafted-opener seed through the `voice` fn's default house voice (W6, #1210)
	 *  — null on any failure (AI not configured, upstream error) so the caller degrades to
	 *  the plain title/content it already had. Only ever called when hasAI(env); injected so
	 *  tests can stub it without a real Workers AI binding. */
	voiceRestyle: (env: RtEnv, text: string) => Promise<string | null>;
	/** Sent-mail threads awaiting a reply (#1217, split from #1203 W1(b)) — always called, same
	 *  as mailSearch/mailRelationshipSearch (mail is core, no feature flag gates it). */
	followUpThreads: (env: RtEnv, opts: { since: string }) => Promise<FollowUpThreadRef[]>;
	/** Every incomplete VTODO across every task-list calendar (split from #1203's "(a) deadline
	 *  extraction") — mirrors calEvents' cal_list fan-out, but over the isTasks calendars
	 *  calEvents itself deliberately excludes. Only called when hasCalDav(env). */
	taskList: (env: RtEnv) => Promise<TaskRef[]>;
};

export type AgendaOpts = { date?: string; max_mail?: number; horizon_days?: number; dry_run?: boolean; cycle_id?: string };

export type AgendaReport = {
	cycle: string;
	date: string;
	dormant?: boolean;
	dry_run?: boolean;
	email_enabled?: boolean;
	sources: Record<string, string>;
	drops_detected?: number;
	proposed?: number;
	proposals?: Array<{ id: string; kind: string; title: string; urgency: Urgency }>;
	digest?: string;
	digest_written?: boolean;
	emailed?: boolean;
	note?: string;
};

const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));
/** Like numClamp but preserves fractional values — the portfolio/savings-rate thresholds are
 *  0..1 fractions, not whole-dollar amounts, and numClamp's Math.floor would zero them out. */
const floatClamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function addDays(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

// ── The loop ─────────────────────────────────────────────────────────────────────
/** Run one agenda cycle. Fail-closed: dormant no-op unless AGENDA_ENABLED. Detects drops,
 *  proposes each NEW one (idempotent via the ledger — a drop already proposed this cycle-
 *  window is skipped), composes the digest, appends it to the Daily note, and (when
 *  AGENDA_EMAIL is armed) mails it to Colin. dry_run detects + composes but records/sends
 *  nothing. */
export async function runAgenda(env: RtEnv, opts: AgendaOpts, deps: AgendaDeps): Promise<AgendaReport> {
	const date = String(opts.date ?? vaultToday(env.VAULT_TZ));
	const cycle = String(opts.cycle_id ?? `agenda::${date}`);
	if (!hasAgenda(env)) {
		return {
			cycle,
			date,
			dormant: true,
			sources: {},
			note: "agenda is disabled — set AGENDA_ENABLED to detect life 'drops' (Rx lapsing, payment failing, unanswered mail…), record a reversible Todoist-task proposal for each, and append a digest to the Daily note; also set AGENDA_EMAIL to mail the digest to yourself. Fail-closed: nothing runs until the flag is set. Nothing ACTS until you approve a proposal.",
		};
	}
	const maxMail = numClamp(opts.max_mail, 1, 50, 25);
	const horizon = numClamp(opts.horizon_days, 0, 14, 2);
	const dryRun = opts.dry_run === true;

	// Gather (read-only, degrade-independently).
	const status: Record<string, string> = {};
	let mail: MailRef[] = [];
	let relationshipMail: MailRef[] = [];
	let events: EventRef[] = [];
	let consolidateFindings: ConsolidateFindings | null = null;
	let weeklyRecallFindings: WeeklyRecallFindings | null = null;
	let watchFindings: WatchFindings | null = null;
	let studyTopics: StudiedTopicRef[] = [];
	let crossSemanticFindings: CrossSemanticFindings | null = null;
	let monarchAccounts: MonarchAccountRef[] = [];
	let monarchTransactions: MonarchTxnRef[] = [];
	let monarchBudgets: MonarchBudgetRef[] = [];
	let monarchCashflow: MonarchCashflowRef | null = null;
	let monarchHoldings: MonarchHoldingRef[] = [];
	let monarchOk = false;
	let textThreads: TextThreadRef[] = [];
	let mychartLabFlags: MyChartLabFlagRef[] = [];
	let mychartRefillsDue: MyChartRefillDueRef[] = [];
	let mychartNewConditions: MyChartEntryRef[] = [];
	let mychartNewDocuments: MyChartEntryRef[] = [];
	let mychartConflicts: MyChartConflictRef[] = [];
	let mychartAllergyGaps: MyChartAllergyGapRef[] = [];
	let trackedDocuments: TrackedDocumentRef[] = [];
	let followUpThreads: FollowUpThreadRef[] = [];
	let taskList: TaskRef[] = [];
	await Promise.all([
		(async () => {
			mail = await deps.mailSearch(env, { limit: maxMail });
			status.mail = `${mail.length} scanned`;
		})().catch((e) => {
			status.mail = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			relationshipMail = await deps.mailRelationshipSearch(env, { since: addDays(date, -RELATIONSHIP_MAIL_LOOKBACK_DAYS) });
			status.relationship_mail = `${relationshipMail.length} scanned`;
		})().catch((e) => {
			status.relationship_mail = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			events = await deps.calEvents(env, { start: `${date}T00:00:00`, end: `${addDays(date, horizon)}T23:59:59` });
			status.calendar = `${events.length} event(s)`;
		})().catch((e) => {
			status.calendar = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			consolidateFindings = await deps.consolidateFindings(env);
			status.consolidate = consolidateFindings ? `week ${consolidateFindings.week}` : "no findings yet";
		})().catch((e) => {
			status.consolidate = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			weeklyRecallFindings = await deps.weeklyRecallFindings(env);
			status.weekly_recall = weeklyRecallFindings ? `week ${weeklyRecallFindings.week}` : "no findings yet";
		})().catch((e) => {
			status.weekly_recall = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			watchFindings = await deps.watchFindings(env);
			status.watch = watchFindings ? `${watchFindings.changed_count} changed as of ${watchFindings.checked_at}` : "no findings yet";
		})().catch((e) => {
			status.watch = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!hasStudyReview(env)) {
				status.study_review = "disabled";
				return;
			}
			studyTopics = await deps.studyTopics(env);
			status.study_review = `${studyTopics.length} whitelisted topic(s)`;
		})().catch((e) => {
			status.study_review = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			crossSemanticFindings = await deps.crossSemanticFindings(env);
			status.cross_semantic = crossSemanticFindings ? `week ${crossSemanticFindings.week}` : "no findings yet";
		})().catch((e) => {
			status.cross_semantic = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!hasLunchmoney(env)) {
				status.lunchmoney = "not_configured";
				return;
			}
			const windowStart = addDays(date, -SUBSCRIPTION_LOOKBACK_DAYS);
			const [accts, txns, budgetRows, cashflow, holdings] = await Promise.all([
				deps.monarchAccounts(env),
				deps.monarchTransactions(env, { start: windowStart, end: date }),
				deps.monarchBudgets(env, { month: date.slice(0, 7) }),
				deps.monarchCashflow(env, { start: addDays(date, -CASHFLOW_WINDOW_DAYS), end: date }),
				deps.monarchHoldings(env),
			]);
			monarchAccounts = accts;
			monarchTransactions = txns;
			monarchBudgets = budgetRows;
			monarchCashflow = cashflow;
			monarchHoldings = holdings;
			monarchOk = true;
			status.lunchmoney = `${accts.length} account(s), ${txns.length} txn(s)`;
		})().catch((e) => {
			status.lunchmoney = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!hasImessage(env)) {
				status.imessage = "not_configured";
				return;
			}
			textThreads = await deps.textThreads(env, { since: addDays(date, -TEXT_LOOKBACK_DAYS) });
			status.imessage = `${textThreads.length} thread(s)`;
		})().catch((e) => {
			status.imessage = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!mychartConfigured(env)) {
				status.mychart = "not_configured";
				return;
			}
			const refillWindowDays = numClamp(env.MYCHART_REFILL_WINDOW_DAYS, 0, 90, 14);
			const summary = await deps.mychartSummary(env, { now: date, refillWindowDays });
			if (!summary) {
				status.mychart = "not_connected";
				return;
			}
			mychartLabFlags = summary.labFlags;
			mychartRefillsDue = summary.refillsDue;
			mychartNewConditions = summary.newConditions;
			mychartNewDocuments = summary.newDocuments;
			status.mychart = `${summary.labFlags.length} lab flag(s), ${summary.refillsDue.length} refill(s) due, ${summary.newConditions.length + summary.newDocuments.length} new entr${summary.newConditions.length + summary.newDocuments.length === 1 ? "y" : "ies"}`;
		})().catch((e) => {
			status.mychart = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!hasMychartReconcile(env) || !mychartConfigured(env)) {
				status.mychart_reconcile = hasMychartReconcile(env) ? "not_configured" : "disabled";
				return;
			}
			[mychartConflicts, mychartAllergyGaps] = await Promise.all([deps.mychartConflicts(env), deps.mychartAllergyGaps(env)]);
			status.mychart_reconcile = `${mychartConflicts.length} cross-org conflict(s), ${mychartAllergyGaps.length} allergy gap(s)`;
		})().catch((e) => {
			status.mychart_reconcile = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!documentRadarArmed(env)) {
				status.document_radar = "disabled";
				return;
			}
			trackedDocuments = await deps.trackedDocuments(env);
			status.document_radar = `${trackedDocuments.length} tracked document(s)`;
		})().catch((e) => {
			status.document_radar = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			followUpThreads = await deps.followUpThreads(env, { since: addDays(date, -FOLLOW_UP_LOOKBACK_DAYS) });
			status.follow_up = `${followUpThreads.length} thread(s) scanned`;
		})().catch((e) => {
			status.follow_up = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
		(async () => {
			if (!hasCalDav(env)) {
				status.tasks = "not_configured";
				return;
			}
			taskList = await deps.taskList(env);
			status.tasks = `${taskList.length} task(s)`;
		})().catch((e) => {
			status.tasks = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
	]);

	const lowBalanceThreshold = numClamp(env.MONARCH_LOW_BALANCE_THRESHOLD, 0, 1_000_000, 100);
	const unusualChargeThreshold = numClamp(env.MONARCH_UNUSUAL_CHARGE_THRESHOLD, 0, 1_000_000, 500);
	const portfolioConcentrationThreshold = floatClamp(env.MONARCH_PORTFOLIO_CONCENTRATION_THRESHOLD, 0, 1, PORTFOLIO_CONCENTRATION_THRESHOLD);
	const portfolioDriftThreshold = floatClamp(env.MONARCH_PORTFOLIO_DRIFT_THRESHOLD, 0, 1, PORTFOLIO_DRIFT_THRESHOLD);
	const savingsRateDropThreshold = floatClamp(env.MONARCH_SAVINGS_RATE_DROP_THRESHOLD, 0, 1, SAVINGS_RATE_DROP_THRESHOLD);
	const priorMonarchSnapshot = monarchOk ? await lastMonarchSnapshot(env) : null;
	const currentSavingsRate = computeSavingsRate(monarchCashflow);
	const relationshipSilenceMultiplier = floatClamp(env.AGENDA_RELATIONSHIP_SILENCE_MULTIPLIER, 1, 20, RELATIONSHIP_SILENCE_MULTIPLIER);
	const relationshipMinSilenceDays = numClamp(env.AGENDA_RELATIONSHIP_MIN_SILENCE_DAYS, 1, 90, RELATIONSHIP_MIN_SILENCE_DAYS);
	const relationshipThreads = [...textThreads, ...mailRelationshipThreads(relationshipMail)];
	const priorRelationshipBaselines = relationshipThreads.length ? await loadRelationshipBaselines(env, relationshipThreads.map((t) => t.id)) : {};
	const relationshipResult = detectRelationshipDrops(Date.parse(`${date}T00:00:00Z`), relationshipThreads, priorRelationshipBaselines, {
		silenceMultiplier: relationshipSilenceMultiplier,
		minSilenceDays: relationshipMinSilenceDays,
	});
	// AI-gated, best-effort (#1210, W6) — runs OUTSIDE detectRelationshipDrops itself so that
	// detector stays pure/sync; a no-op (returns relationshipResult.drops unchanged) when
	// Workers AI isn't bound, so this never becomes a new required capability for the loop.
	const relationshipDropsWithOpeners = await draftRelationshipOpeners(env, relationshipResult.drops, deps.voiceRestyle);
	const studyReviewDue = hasStudyReview(env) ? dueForReview(studyTopics, Date.parse(`${date}T00:00:00Z`), reviewIntervalDays(env)) : [];
	const drops = await rankDropsLearned(env, [
		...detectDrops(mail, events),
		...detectTextDrops(textThreads),
		...relationshipDropsWithOpeners,
		...detectFollowUpDrops(Date.parse(`${date}T00:00:00Z`), followUpThreads),
		...detectKnowledgeDrops(consolidateFindings, weeklyRecallFindings),
		...detectWatchDrops(watchFindings),
		...detectStudyReviewDrops(studyReviewDue),
		...detectCrossSemanticDrops(crossSemanticFindings),
		...detectMonarchDrops(date, monarchAccounts, monarchTransactions, monarchBudgets, { lowBalanceThreshold, unusualChargeThreshold }),
		...detectPortfolioDrops(date, monarchHoldings, priorMonarchSnapshot?.allocation ?? null, { concentrationThreshold: portfolioConcentrationThreshold, driftThreshold: portfolioDriftThreshold }),
		...detectSavingsRateDrop(date, currentSavingsRate, priorMonarchSnapshot?.savingsRate ?? null, { dropThreshold: savingsRateDropThreshold }),
		...detectMyChartDrops(mychartLabFlags, mychartRefillsDue, mychartNewConditions, mychartNewDocuments),
		...detectMychartConflictDrops(mychartConflicts),
		...detectMychartAllergyGapDrops(mychartAllergyGaps),
		...detectDocumentExpiryDrops(date, trackedDocuments),
		...detectTaskDeadlineDrops(date, taskList),
	]);

	// Advance the "since last check" baseline every successful Monarch fetch, regardless of
	// whether anything crossed a threshold this cycle — dry_run must never persist state.
	if (!dryRun && monarchOk) {
		// A transient/incomplete cashflow response yields an undefined currentSavingsRate for
		// this cycle only — fall back to the prior snapshot's rate so one bad cycle doesn't
		// clobber the known-good baseline detectSavingsRateDrop compares against (#874).
		await saveMonarchSnapshot(env, { date, allocation: computePortfolioAllocation(monarchHoldings), savingsRate: currentSavingsRate ?? priorMonarchSnapshot?.savingsRate });
		// Feed the infer signal log (#864 substrate) with this cycle's Monarch transactions —
		// dormant no-op unless INFER_ARM_PURCHASES is set (#1085). Same dry_run-never-persists
		// contract as the snapshot save above.
		await logPurchaseSignals(env, monarchTransactions);
	}
	// Same dry_run-never-persists contract as the Monarch snapshot above.
	if (!dryRun && relationshipThreads.length) await saveRelationshipBaselines(env, relationshipResult.baselines);

	// Propose each NEW drop (idempotent per dedupe key). dry_run records nothing.
	const led = ledger(env, "agenda_drop");
	const proposed: ProposedDrop[] = [];
	if (!dryRun) {
		for (const drop of drops) {
			if (await led.seen(drop.dedupe)) continue;
			try {
				const p = await propose(env, { source: "agenda", kind: drop.kind, intent: drop.title, payload: drop.action, reversible: true, stakes: "low", evidence: drop.evidence });
				proposed.push({ proposalId: p.id, drop });
				await led.mark(drop.dedupe);
			} catch {
				// A propose() failure (e.g. transient KV) leaves the drop un-marked → retried next tick.
			}
		}
	} else {
		// Dry run: show what WOULD be proposed, with placeholder ids.
		for (const drop of drops) proposed.push({ proposalId: `dryrun-${drop.dedupe}`, drop });
	}

	// agenda_drop's mark above is permanent — once propose() succeeds a drop never resurfaces
	// via `drops`/`proposed` again, so it can't be the thing a failed digest/email retries.
	// This queue is what actually carries an undelivered drop's content into the NEXT cycle,
	// independent of agenda_drop; cleared only once a write actually lands (#996).
	const pending = ledger(env, "agenda_pending");
	const PENDING_KEY = "queue";
	let carried: ProposedDrop[] = [];
	if (!dryRun) {
		const raw = await pending.get(PENDING_KEY);
		if (raw) {
			try {
				carried = JSON.parse(raw) as ProposedDrop[];
			} catch {
				// corrupt entry — better to drop it than throw the whole cycle.
			}
		}
	}
	// Guard against unbounded growth across a sustained mail+vault outage (#1134) — KV values cap
	// at 25MB and a growing `evidence` payload (Monarch/MyChart drops aren't small) could otherwise
	// push a `put` over that limit. Stay well under it, mirroring _capped_kv_log.ts's byte cap.
	// Trims `carried` (the OLDEST, already-carried-over entries) FIRST, on its own, so this
	// cycle's fresh `proposed` entries are never touched while carried still has slack to shed.
	// Only once carried is fully exhausted and the combined set STILL doesn't fit does the loop
	// fall through to trimming `toDeliver` itself (now proposed-only) — logged separately since
	// that genuinely means this cycle's own proposals alone blew the budget (#1140), the opposite
	// of dropping already-carried leftovers.
	const MAX_PENDING_BYTES = 1024 * 1024;
	const byteLen = (arr: ProposedDrop[]) => new TextEncoder().encode(JSON.stringify(arr)).length;
	while (carried.length && byteLen([...carried, ...proposed]) > MAX_PENDING_BYTES) carried.shift();
	const toDeliver = [...carried, ...proposed];
	if (byteLen(toDeliver) > MAX_PENDING_BYTES) {
		console.warn(`agenda: pending digest still over ${MAX_PENDING_BYTES} bytes after dropping every carried-over entry — trimming this cycle's own fresh proposals`);
		while (toDeliver.length > 1 && byteLen(toDeliver) > MAX_PENDING_BYTES) toDeliver.shift();
	}

	const digest = composeDigest(date, toDeliver);

	// Push escalation (#1367): a "needs you today" drop is exactly the case notify() exists for
	// — the digest/email may sit unread for hours, this reaches Colin's phone right away.
	// Fire-and-forget via ctx.waitUntil (the ingest.ts backgroundAssimilate precedent); notify()
	// itself never throws, and NTFY_URL unset makes this a complete no-op either way.
	const todayCount = toDeliver.filter((p) => p.drop.urgency === "today").length;
	if (!dryRun && todayCount) {
		const task = notify(env, "agenda", digest.subject, `${todayCount} thing${todayCount === 1 ? "" : "s"} need${todayCount === 1 ? "s" : ""} you today.`, "high");
		const pushCtx = env._egress?.ctx;
		if (pushCtx && typeof pushCtx.waitUntil === "function") pushCtx.waitUntil(task);
	}

	let digestWritten = false;
	let emailed = false;
	if (!dryRun && toDeliver.length) {
		const dled = ledger(env, "agenda_digest");
		const digKey = `digest::${cycle}`;
		const alreadyDelivered = await dled.seen(digKey);
		if (!alreadyDelivered) {
			// Attempt the send BEFORE the vault append so the append's "digest emailed" text
			// reflects the true outcome, not the config flag (#1089) — a send failure here must
			// still never fail the cycle (the vault digest lands below regardless).
			if (hasAgendaEmail(env)) {
				try {
					const sent = await deps.sendDigest(env, digest.subject, digest.body);
					emailed = true;
					// Ledger the sent digest's Message-ID (30d TTL, matches the ledger default) so
					// _agenda_reply.ts can bind an inbound reply to THIS digest via In-Reply-To/
					// References, instead of trusting the guessable `sux · ` subject prefix alone.
					if (sent?.messageId) await ledger(env, "agenda_digest_msgid").mark(sent.messageId);
				} catch {
					/* an email failure must never fail the cycle — the proposals are already recorded */
				}
			}
			try {
				await deps.digestAppend(env, `${vaultDailyDir(env)}/${vaultToday(env.VAULT_TZ)}.md`, buildDigestBlock(date, cycle, emailed, digest));
				digestWritten = true;
			} catch {
				/* a vault-append failure must never fail the cycle */
			}
			// Mark AFTER a successful write on EITHER channel — vault append or email — so a cycle
			// where only one channel is down doesn't re-send/re-append an ever-growing digest to the
			// channel that's working (#1058); a failed channel still retries next tick since only ITS
			// own flag stayed false, not the shared ledger mark.
			if (digestWritten || emailed) await dled.mark(digKey);
		}
		// Clear once EITHER channel actually delivers (this call, or an earlier call this same
		// cycle already delivered it); otherwise re-queue everything still undelivered —
		// including this cycle's own new proposals — for the next attempt (#1041, #1058).
		try {
			await pending.mark(PENDING_KEY, digestWritten || emailed || alreadyDelivered ? "[]" : JSON.stringify(toDeliver));
		} catch {
			/* a pending-queue write failure must never fail the cycle (#1134) — the proposals are
			 * already recorded; worst case this cycle's undelivered drops aren't re-queued for the
			 * next attempt, same as a corrupt-entry read above. */
		}
	}

	return {
		cycle,
		date,
		dry_run: dryRun,
		email_enabled: hasAgendaEmail(env),
		sources: status,
		drops_detected: drops.length,
		proposed: proposed.length,
		proposals: toDeliver.map((p) => ({ id: p.proposalId, kind: p.drop.kind, title: p.drop.title, urgency: p.drop.urgency })),
		digest: digest.body,
		digest_written: digestWritten,
		emailed,
	};
}

// ── Real deps ─────────────────────────────────────────────────────────────────────
/** Production surface: mail_search (unread inbox) + cal_events (non-task calendars) for
 *  gathering, the git-backed vault append, and a self-addressed mail_send for the digest.
 *  Dynamically imported to break the fns→mail-mcp→index cycle (mirrors _briefing). */
export async function defaultDeps(): Promise<AgendaDeps> {
	const mail = await import("../mail-mcp");
	const { obsidian } = await import("./obsidian");
	const { lastConsolidateFindings } = await import("./_consolidate");
	const { lastWeeklyRecallFindings } = await import("./_weekly_recall");
	const { lastWatchFindings } = await import("./_watch_sweep");
	const { lastCrossSemanticFindings } = await import("./_cross_semantic");
	const { voice } = await import("./voice");
	const tool = (name: string) => mail.MAIL_TOOLS.find((t) => t.name === name);

	return {
		mailSearch: async (env, o) => {
			const t = tool("mail_search");
			if (!t) throw new Error("mail_search tool not found");
			const r = await t.run(env, { mailbox: "inbox", unread: true, limit: o.limit });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail_search failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.emails ?? []).map((e: any) => ({ id: String(e?.id ?? ""), from: e?.from, subject: e?.subject, preview: e?.preview, date: e?.receivedAt }));
		},
		mailRelationshipSearch: async (env, o) => {
			// Deliberately NOT `unread: true` (#1133) — mailSearch's inbox scan above drops a
			// contact the moment their message is read, freezing detectRelationshipDrops' cadence
			// baseline forever. This scans the same inbox by recency instead, so a read message
			// still keeps the contact's cadence updating.
			const t = tool("mail_search");
			if (!t) throw new Error("mail_search tool not found");
			const r = await t.run(env, { mailbox: "inbox", after: o.since, limit: 50 });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail_search failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.emails ?? []).map((e: any) => ({ id: String(e?.id ?? ""), from: e?.from, subject: e?.subject, preview: e?.preview, date: e?.receivedAt }));
		},
		calEvents: async (env, o) => {
			const listTool = tool("cal_list");
			const evTool = tool("cal_events");
			if (!listTool || !evTool) throw new Error("cal tools not found");
			const lr = await listTool.run(env, {});
			if (lr.isError) throw new Error(lr.content?.[0]?.text ?? "cal_list failed");
			const cals = (JSON.parse(lr.content?.[0]?.text ?? "{}").calendars ?? []) as Array<{ href: string; isTasks?: boolean }>;
			const out: EventRef[] = [];
			for (const c of cals.filter((c) => !c.isTasks)) {
				try {
					const er = await evTool.run(env, { calendar: c.href, start: o.start, end: o.end });
					if (er.isError) continue;
					for (const e of (JSON.parse(er.content?.[0]?.text ?? "{}").events ?? []) as any[]) out.push({ summary: e?.summary, start: e?.start, end: e?.end, all_day: e?.all_day, location: e?.location });
				} catch {
					/* skip a single unreadable calendar */
				}
			}
			return out;
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
		sendDigest: async (env, subject, body) => {
			// Resolve Colin's own primary identity and send the digest to himself. force:true
			// skips the stage gate (this loop is the deliberate, armed sender); it is the ONE
			// send here and it is self-addressed — never a third party.
			const idTool = tool("mail_identities");
			const sendTool = tool("mail_send");
			if (!idTool || !sendTool) throw new Error("mail tools not found");
			const ir = await idTool.run(env, {});
			if (ir.isError) throw new Error(ir.content?.[0]?.text ?? "mail_identities failed");
			const identities = (JSON.parse(ir.content?.[0]?.text ?? "{}").identities ?? []) as Array<{ email?: string }>;
			const self = identities[0]?.email;
			if (!self) throw new Error("no primary identity to send the digest to");
			const sr = await sendTool.run(env, { to: [self], subject, text: body, force: true });
			if (sr.isError) throw new Error(sr.content?.[0]?.text ?? "mail_send failed");
			// mail_send only returns {sent, submissionId, to} — no email id or Message-ID. Best-effort
			// resolve the just-filed Sent copy by its (unique-enough, dated) subject, then the raw jmap
			// escape hatch for the messageId property it doesn't otherwise expose. Never fails the
			// send itself — a lookup miss just means _agenda_reply.ts's thread-match gate has nothing
			// to bind to for this cycle's digest.
			try {
				const searchTool = tool("mail_search");
				const jmapTool = tool("jmap");
				if (!searchTool || !jmapTool) return {};
				const found = await searchTool.run(env, { mailbox: "sent", subject, limit: 1 });
				if (found.isError) return {};
				const sentMsg = JSON.parse(found.content?.[0]?.text ?? "{}").emails?.[0];
				if (!sentMsg?.id) return {};
				const got = await jmapTool.run(env, { method: "Email/get", args: { ids: [sentMsg.id], properties: ["messageId"] } });
				if (got.isError) return {};
				const mrs = JSON.parse(got.content?.[0]?.text ?? "{}").methodResponses ?? [];
				const list = mrs.find((mr: any) => mr[0] === "Email/get")?.[1]?.list ?? [];
				const messageId = list[0]?.messageId?.[0];
				return messageId ? { messageId: String(messageId) } : {};
			} catch {
				return {};
			}
		},
		consolidateFindings: lastConsolidateFindings,
		weeklyRecallFindings: lastWeeklyRecallFindings,
		watchFindings: lastWatchFindings,
		studyTopics: studyReviewCandidates,
		crossSemanticFindings: lastCrossSemanticFindings,
		monarchAccounts: async (env) => {
			const r = await lunchmoney.run(env, { op: "accounts" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "lunchmoney accounts failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			// Flatten manually-managed /assets + Plaid-linked /plaid_accounts into balance refs.
			// The low-balance detector keys on type === "depository" (Plaid checking/savings), so a
			// liability's positive magnitude never reads as a cash-crunch.
			const rows = [...(parsed.assets ?? []), ...(parsed.plaid_accounts ?? [])];
			return rows.map((a: any) => ({ id: String(a?.id ?? ""), name: a?.name, balance: typeof a?.balance === "number" ? a.balance : undefined, type: a?.type, subtype: a?.subtype }));
		},
		monarchTransactions: async (env, o) => {
			// Lunch Money's read-only transactions op returns one windowed page (no offset), so a
			// single call over the window feeds the unusual-charge + subscription-creep detectors.
			// debit_as_negative (set by the fn) makes expenses negative — the sign they expect; payee
			// is the merchant.
			const r = await lunchmoney.run(env, { op: "transactions", since: o.start, until: o.end, limit: LUNCHMONEY_TRANSACTIONS_MAX });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "lunchmoney transactions failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.transactions ?? []).map((t: any) => ({ id: String(t?.id ?? ""), amount: typeof t?.amount === "number" ? t.amount : undefined, date: t?.date, merchant: t?.payee }));
		},
		monarchBudgets: async (env, o) => {
			// o.month is YYYY-MM; ask Lunch Money for that whole month and read `remaining` as
			// budgeted − spending from the month-keyed data so the bill-due detector still fires.
			const [y, mo] = o.month.split("-").map(Number);
			const start = `${o.month}-01`;
			const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
			const r = await lunchmoney.run(env, { op: "budgets", since: start, until: end });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "lunchmoney budgets failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.budgets ?? []).map((b: any) => {
				const m: any = b?.months?.[start] ?? Object.values(b?.months ?? {})[0] ?? {};
				const budgeted = typeof m?.budgeted === "number" ? m.budgeted : undefined;
				const spending = typeof m?.spending === "number" ? m.spending : undefined;
				return { category: b?.category, categoryId: b?.categoryId, remaining: budgeted === undefined ? undefined : budgeted - (spending ?? 0) };
			});
		},
		// Lunch Money's developer API exposes no cash-flow aggregate and no investment holdings, so
		// the W7.1 savings-rate + portfolio detectors have no live feed here — dormant, returning
		// null/[] so those detectors simply produce nothing. Wiring them would need deriving cash flow
		// from the transaction stream and a holdings source Lunch Money doesn't currently provide.
		monarchCashflow: async () => null,
		monarchHoldings: async () => [],
		textThreads: async (env, o) => {
			const tr = await imessage.run(env, { action: "threads", since: o.since });
			if (tr.isError) throw new Error(tr.content?.[0]?.text ?? "imessage threads failed");
			const threads = (JSON.parse(tr.content?.[0]?.text ?? "{}").threads ?? []) as Array<{ id?: number | string; contact?: string; name?: string }>;
			const out: TextThreadRef[] = [];
			for (const t of threads.slice(0, 15)) {
				if (t?.id === undefined || t?.id === null) continue;
				try {
					const mr = await imessage.run(env, { action: "messages", thread: String(t.id), limit: 1 });
					if (mr.isError) continue;
					const msgs = (JSON.parse(mr.content?.[0]?.text ?? "{}").messages ?? []) as any[];
					const last = msgs[msgs.length - 1];
					if (!last) continue;
					out.push({ id: String(t.id), contact: t.contact, name: t.name ?? undefined, lastText: last?.text, lastFromMe: Boolean(last?.from_me), lastAt: last?.at, lastMessageId: last?.id !== undefined && last?.id !== null ? String(last.id) : undefined });
				} catch {
					/* skip a single unreadable thread */
				}
			}
			return out;
		},
		mychartSummary: async (env, o) => summarizeMyChart(env, { now: o.now, refillWindowDays: o.refillWindowDays }),
		mychartConflicts: async (env) => crossOrgMedicationAllergyConflicts(env),
		mychartAllergyGaps: async (env) => crossOrgAllergyGaps(env),
		trackedDocuments: async (env) => listTrackedDocuments(env),
		voiceRestyle: async (env, text) => {
			// No style/framework (#1210) — deliberately the plain default house voice, since
			// #1207's `framework` param may or may not have landed yet in this same batch.
			const r = await voice.run(env, { text });
			if (r.isError) return null;
			return r.content?.[0]?.text ?? null;
		},
		followUpThreads: async (env, o) => {
			const searchTool = tool("mail_search");
			const threadTool = tool("mail_thread");
			const idTool = tool("mail_identities");
			if (!searchTool || !threadTool || !idTool) throw new Error("mail tools not found");
			const ir = await idTool.run(env, {});
			if (ir.isError) throw new Error(ir.content?.[0]?.text ?? "mail_identities failed");
			const myEmails = new Set(((JSON.parse(ir.content?.[0]?.text ?? "{}").identities ?? []) as Array<{ email?: string }>).map((i) => i?.email?.toLowerCase()).filter(Boolean));
			const sr = await searchTool.run(env, { mailbox: "sent", after: o.since, limit: 50 });
			if (sr.isError) throw new Error(sr.content?.[0]?.text ?? "mail_search failed");
			const sent = (JSON.parse(sr.content?.[0]?.text ?? "{}").emails ?? []) as Array<{ threadId?: string; to?: string; subject?: string }>;
			const seenThreads = new Set<string>();
			const out: FollowUpThreadRef[] = [];
			for (const s of sent) {
				if (!s.threadId || seenThreads.has(s.threadId) || out.length >= FOLLOW_UP_SCAN_CAP) continue;
				seenThreads.add(s.threadId);
				try {
					const tr = await threadTool.run(env, { threadId: s.threadId });
					if (tr.isError) continue;
					const messages = (JSON.parse(tr.content?.[0]?.text ?? "{}").messages ?? []) as Array<{ from?: string; subject?: string; receivedAt?: string; to?: string }>;
					const last = messages[messages.length - 1];
					if (!last) continue;
					const lastFromMe = myEmails.has(String(last.from ?? "").toLowerCase());
					out.push({ id: s.threadId, subject: last.subject ?? s.subject, to: last.to ?? s.to, lastAt: last.receivedAt, lastFromMe });
				} catch {
					/* skip a single unreadable thread */
				}
			}
			return out;
		},
		taskList: async (env) => {
			const listTool = tool("cal_list");
			const taskTool = tool("task_list");
			if (!listTool || !taskTool) throw new Error("task tools not found");
			const lr = await listTool.run(env, {});
			if (lr.isError) throw new Error(lr.content?.[0]?.text ?? "cal_list failed");
			const cals = (JSON.parse(lr.content?.[0]?.text ?? "{}").calendars ?? []) as Array<{ href: string; isTasks?: boolean }>;
			const out: TaskRef[] = [];
			for (const c of cals.filter((c) => c.isTasks)) {
				try {
					const tr = await taskTool.run(env, { calendar: c.href });
					if (tr.isError) continue;
					for (const t of (JSON.parse(tr.content?.[0]?.text ?? "{}").tasks ?? []) as any[]) out.push({ uid: t?.uid, summary: t?.summary, due: t?.due ?? undefined, status: t?.status ?? undefined, href: t?.href });
				} catch {
					/* skip a single unreadable task list */
				}
			}
			return out;
		},
	};
}
