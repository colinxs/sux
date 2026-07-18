// The agenda loop — the "figure out what to do" engine (docs/design/personal-agent-
// roadmap.md, epic #228, W2). It is the SENSE→DECIDE→PROPOSE half of the personal
// agent: fan out (read-only) across the senses that already exist (mail + calendar +
// Monarch, W7/W7.1), run cheap deterministic DETECTORS that spot a "drop about to happen"
// (a prescription lapsing, a payment failing, an unanswered personal note, a bill due, an
// unusual charge, a low balance, a portfolio allocation drifting, a savings rate sliding),
// and for each one RECORD a
// proposal via the W1 kernel — a reversible Todoist task that catches the drop. Then
// compose ONE calm digest of what needs Colin and deliver it: appended to the Daily
// note, and (when armed) mailed to him. The email IS the interface — see the digest
// footer's reply syntax; inbound reply-parsing (approve/snooze/reject) is the next
// increment (W2.1), and every proposal is already approvable now via the `proposals`
// verb.
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
import { classifyMessage } from "./_mail_triage";
import { hasMonarch, monarch } from "./monarch";
import { errMsg, vaultToday } from "./_util";
import type { WeeklyRecallFindings } from "./_weekly_recall";

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

/** Turn consolidate's + weekly_recall's cached findings (W5) into drops — the same
 *  read-only-sense/reversible-propose contract as the mail+calendar detectors above, just
 *  fed from the two knowledge loops' last completed cycle instead of a live fan-out. Each
 *  loop already runs at most once per ISO week; the dedupe key includes that week so a
 *  finding surfaces as exactly one proposal per week, not once per daily agenda tick. */
export function detectKnowledgeDrops(consolidate: ConsolidateFindings | null, weeklyRecall: WeeklyRecallFindings | null): Drop[] {
	const drops: Drop[] = [];
	if (consolidate) {
		if (consolidate.stale.length) {
			drops.push({
				kind: "consolidate_stale",
				urgency: "fyi",
				dedupe: `consolidate::stale::${consolidate.week}`,
				title: `${consolidate.stale.length} stale vault note(s) need review`,
				emoji: "🗂️",
				action: task(`Review ${consolidate.stale.length} stale vault note(s) — see Consolidation/${consolidate.week}.md`),
				evidence: { week: consolidate.week, paths: consolidate.stale.map((s) => s.path) },
			});
		}
		if (consolidate.duplicate_candidates.length) {
			drops.push({
				kind: "consolidate_dupes",
				urgency: "fyi",
				dedupe: `consolidate::dupes::${consolidate.week}`,
				title: `${consolidate.duplicate_candidates.length} possible duplicate vault note(s)`,
				emoji: "🗂️",
				action: task(`Review ${consolidate.duplicate_candidates.length} possible duplicate vault note(s) — see Consolidation/${consolidate.week}.md`),
				evidence: { week: consolidate.week, pairs: consolidate.duplicate_candidates },
			});
		}
	}
	if (weeklyRecall && weeklyRecall.questions > 0) {
		drops.push({
			kind: "weekly_recall_ready",
			urgency: "fyi",
			dedupe: `weekly_recall::${weeklyRecall.week}`,
			title: `Weekly recall digest ready (${weeklyRecall.questions} question${weeklyRecall.questions === 1 ? "" : "s"})`,
			emoji: "🧠",
			action: task(`Read this week's recall digest — see Weekly/${weeklyRecall.week}.md`),
			evidence: { week: weeklyRecall.week },
		});
	}
	return drops;
}

/** Monarch's read-only accounts/transactions/budgets ops (W7), trimmed to what the
 *  detectors below need — see fns/monarch.ts for the full shapes. */
export type MonarchAccountRef = { id: string; name?: string; balance?: number };
export type MonarchTxnRef = { id: string; amount?: number; date?: string; merchant?: string };
export type MonarchBudgetRef = { category?: string; categoryId?: string; remaining?: number };

// A bill-like budget category, so "rent remaining $900 with 3 days left in the month" reads
// as a bill_due drop and a plain discretionary category (dining, shopping) does not.
const BILL_GROUP_CUE = /\b(bills?|utilit\w*|subscriptions?|insurance|loans?|rent|mortgage)\b/i;
// Flag a bill only once it's genuinely close — avoids a month-long "rent due" nag.
const BILL_DUE_WINDOW_DAYS = 7;
// Recent-transactions window scanned for the unusual-charge detector (days back from `date`).
const UNUSUAL_CHARGE_WINDOW_DAYS = 3;

const daysLeftInMonth = (date: string): number => {
	const d = new Date(`${date}T00:00:00Z`);
	const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	return lastDay - d.getUTCDate();
};

/** Turn Monarch's read-only accounts/transactions/budgets into drops (W7) — same
 *  read-only-sense/reversible-propose contract as every other detector here. Bill-due,
 *  unusual-charge, and low-balance are rung-0 threshold rules, not a model: sux never
 *  moves money, so every finding surfaces as a proposal, never an action. */
export function detectMonarchDrops(date: string, accounts: MonarchAccountRef[], transactions: MonarchTxnRef[], budgets: MonarchBudgetRef[], opts?: { lowBalanceThreshold?: number; unusualChargeThreshold?: number }): Drop[] {
	const drops: Drop[] = [];
	const lowBalanceThreshold = opts?.lowBalanceThreshold ?? 100;
	const unusualChargeThreshold = opts?.unusualChargeThreshold ?? 500;

	for (const a of accounts) {
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

	for (const t of transactions) {
		// Monarch's amount is signed negative-is-expense (monarch.ts's module doc) — only
		// outgoing money is a "charge"; a large positive incoming deposit (paycheck, refund,
		// transfer-in) is never an unusual charge, no matter how large.
		if (typeof t.amount !== "number" || t.amount >= 0 || Math.abs(t.amount) < unusualChargeThreshold) continue;
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
				dedupe: `monarch::bill_due::${b.categoryId || b.category}::${month}`,
				title: `Bill due soon: ${b.category} ($${remaining} remaining)`,
				emoji: "🧾",
				action: task(`Pay/handle ${b.category} — $${remaining} remaining this month`),
				evidence: { category: b.category, remaining: b.remaining, month },
			});
		}
	}

	return sortByUrgency(drops);
}

/** Monarch's read-only holdings/cashflow ops (W7.1) — the two ops accounts/transactions/
 *  budgets left dormant when W7 landed (#803). See fns/monarch.ts for the full shapes. */
export type MonarchHoldingRef = { ticker?: string; name?: string; value?: number; quantity?: number };
export type MonarchCashflowSummary = { sumIncome?: number; sumExpense?: number; savings?: number; savingsRate?: number } | null;

/** Ticker (or name, when no ticker) -> fraction of total portfolio value. Empty when
 *  holdings carry no usable value. */
export type PortfolioWeights = Record<string, number>;

// A holding's allocation share moving by this many percentage points since the last cached
// snapshot is a meaningful drift, not day-to-day price noise.
const PORTFOLIO_DRIFT_THRESHOLD_PCT = 10;
// The savings rate falling this many percentage points below the last cached snapshot reads
// as a real trend, not one noisy month.
const SAVINGS_RATE_DROP_THRESHOLD_PCT = 15;

/** Pure allocation calc — no I/O, no caching. Groups by ticker (falling back to name), so
 *  multiple lots of the same security across accounts collapse into one weight. */
export function computePortfolioWeights(holdings: MonarchHoldingRef[]): PortfolioWeights {
	const total = holdings.reduce((sum, h) => sum + (typeof h.value === "number" ? h.value : 0), 0);
	const weights: PortfolioWeights = {};
	if (total <= 0) return weights;
	for (const h of holdings) {
		if (typeof h.value !== "number") continue;
		const key = h.ticker || h.name;
		if (!key) continue;
		weights[key] = (weights[key] ?? 0) + h.value / total;
	}
	return weights;
}

/** Derive a self-consistent savings rate (fraction, income - expense over income) directly
 *  from cashflow's raw sums when possible, rather than trusting Monarch's own `savingsRate`
 *  field's scale (undocumented — could be a fraction or a whole percentage). Falls back to
 *  the raw field only when income is missing/non-positive. Returns null when neither is
 *  usable. */
export function computeSavingsRate(cashflow: MonarchCashflowSummary): number | null {
	if (!cashflow) return null;
	if (typeof cashflow.sumIncome === "number" && cashflow.sumIncome > 0 && typeof cashflow.savings === "number") {
		return cashflow.savings / cashflow.sumIncome;
	}
	return typeof cashflow.savingsRate === "number" ? cashflow.savingsRate : null;
}

/** Portfolio-drift (W7.1): flag a holding whose share of the portfolio moved by more than
 *  the threshold since the last cached snapshot — a concentration building up, or a position
 *  sold off entirely. `priorWeights` null (no snapshot yet, e.g. the very first cycle) means
 *  there's nothing to compare against, so it detects nothing; the caller is responsible for
 *  caching `weights` as the next cycle's prior. */
export function detectPortfolioDrift(date: string, weights: PortfolioWeights, priorWeights: PortfolioWeights | null, opts?: { driftThresholdPct?: number }): Drop[] {
	if (!priorWeights || Object.keys(priorWeights).length === 0) return [];
	const threshold = (opts?.driftThresholdPct ?? PORTFOLIO_DRIFT_THRESHOLD_PCT) / 100;
	const drops: Drop[] = [];
	const tickers = new Set([...Object.keys(weights), ...Object.keys(priorWeights)]);
	for (const ticker of tickers) {
		const weight = weights[ticker] ?? 0;
		const prior = priorWeights[ticker] ?? 0;
		const delta = weight - prior;
		if (Math.abs(delta) < threshold) continue;
		const pct = (weight * 100).toFixed(1);
		const deltaPct = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pt`;
		drops.push({
			kind: "portfolio_drift",
			urgency: "fyi",
			dedupe: `monarch::portfolio_drift::${ticker}::${date}`,
			title: `Portfolio drift: ${ticker} now ${pct}% (${deltaPct})`,
			emoji: "📊",
			action: task(`Review portfolio allocation — ${ticker} shifted to ${pct}% of the portfolio (${deltaPct})`),
			evidence: { ticker, weight, priorWeight: prior },
		});
	}
	return sortByUrgency(drops);
}

/** Savings-rate trend (W7.1): flag a month trending toward a negative, or sharply lower,
 *  savings rate than the last cached snapshot. A negative rate always flags (even with no
 *  prior snapshot to compare against — spending more than earning needs no history to be
 *  worth a look); a sharp *drop* needs a prior rate to compare against. */
export function detectSavingsRateDrop(date: string, rate: number | null, priorRate: number | null, opts?: { dropThresholdPct?: number }): Drop[] {
	if (rate === null) return [];
	const dropThreshold = (opts?.dropThresholdPct ?? SAVINGS_RATE_DROP_THRESHOLD_PCT) / 100;
	const negative = rate < 0;
	const droppedSharply = priorRate !== null && priorRate - rate >= dropThreshold;
	if (!negative && !droppedSharply) return [];
	const month = date.slice(0, 7);
	const pct = (rate * 100).toFixed(1);
	const reason = negative ? `negative (${pct}%)` : `down to ${pct}% (from ${(priorRate! * 100).toFixed(1)}%)`;
	return [
		{
			kind: "savings_rate_drop",
			urgency: "soon",
			dedupe: `monarch::savings_rate::${month}`,
			title: `Savings rate ${reason}`,
			emoji: "📉",
			action: task(`Check cashflow this month — savings rate ${reason}`),
			evidence: { rate, priorRate, month },
		},
	];
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
	calEvents: (env: RtEnv, opts: { start: string; end: string }) => Promise<EventRef[]>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
	/** Send the digest to Colin's own primary address. The one send this loop can do. */
	sendDigest: (env: RtEnv, subject: string, body: string) => Promise<void>;
	/** The vault-consolidation loop's most recent findings (W5) — a ledger-cache read, never a
	 *  fresh vault scan. */
	consolidateFindings: (env: RtEnv) => Promise<ConsolidateFindings | null>;
	/** The weekly-recall loop's most recent findings (W5) — a ledger-cache read, never a fresh
	 *  recall fan-out. */
	weeklyRecallFindings: (env: RtEnv) => Promise<WeeklyRecallFindings | null>;
	/** Monarch account balances (W7) — only called when hasMonarch(env). */
	monarchAccounts: (env: RtEnv) => Promise<MonarchAccountRef[]>;
	/** Monarch transactions in a window (W7) — only called when hasMonarch(env). */
	monarchTransactions: (env: RtEnv, opts: { start: string; end: string }) => Promise<MonarchTxnRef[]>;
	/** Monarch per-category budget for a month (W7) — only called when hasMonarch(env). */
	monarchBudgets: (env: RtEnv, opts: { month: string }) => Promise<MonarchBudgetRef[]>;
	/** Monarch investment positions (W7.1) — only called when hasMonarch(env). */
	monarchHoldings: (env: RtEnv) => Promise<MonarchHoldingRef[]>;
	/** Monarch income/expense/savings summary for a window (W7.1) — only called when
	 *  hasMonarch(env). */
	monarchCashflow: (env: RtEnv, opts: { start: string; end: string }) => Promise<MonarchCashflowSummary>;
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
	let events: EventRef[] = [];
	let consolidateFindings: ConsolidateFindings | null = null;
	let weeklyRecallFindings: WeeklyRecallFindings | null = null;
	let monarchAccounts: MonarchAccountRef[] = [];
	let monarchTransactions: MonarchTxnRef[] = [];
	let monarchBudgets: MonarchBudgetRef[] = [];
	let monarchHoldings: MonarchHoldingRef[] = [];
	let monarchCashflow: MonarchCashflowSummary = null;
	await Promise.all([
		(async () => {
			mail = await deps.mailSearch(env, { limit: maxMail });
			status.mail = `${mail.length} scanned`;
		})().catch((e) => {
			status.mail = `unavailable (${errMsg(e).slice(0, 90)})`;
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
			if (!hasMonarch(env)) {
				status.monarch = "not_configured";
				return;
			}
			const windowStart = addDays(date, -UNUSUAL_CHARGE_WINDOW_DAYS);
			const monthStart = `${date.slice(0, 7)}-01`;
			const [accts, txns, budgetRows, holdingRows, cashflowRow] = await Promise.all([
				deps.monarchAccounts(env),
				deps.monarchTransactions(env, { start: windowStart, end: date }),
				deps.monarchBudgets(env, { month: date.slice(0, 7) }),
				deps.monarchHoldings(env),
				deps.monarchCashflow(env, { start: monthStart, end: date }),
			]);
			monarchAccounts = accts;
			monarchTransactions = txns;
			monarchBudgets = budgetRows;
			monarchHoldings = holdingRows;
			monarchCashflow = cashflowRow;
			status.monarch = `${accts.length} account(s), ${txns.length} txn(s)`;
		})().catch((e) => {
			status.monarch = `unavailable (${errMsg(e).slice(0, 90)})`;
		}),
	]);

	const lowBalanceThreshold = numClamp(env.MONARCH_LOW_BALANCE_THRESHOLD, 0, 1_000_000, 100);
	const unusualChargeThreshold = numClamp(env.MONARCH_UNUSUAL_CHARGE_THRESHOLD, 0, 1_000_000, 500);
	const driftThresholdPct = numClamp(env.MONARCH_PORTFOLIO_DRIFT_THRESHOLD_PCT, 0, 100, 10);
	const savingsDropThresholdPct = numClamp(env.MONARCH_SAVINGS_RATE_DROP_THRESHOLD_PCT, 0, 100, 15);

	// W7.1: portfolio-drift + savings-rate need a PRIOR cycle's snapshot to compare against —
	// read it (this loop's own ledger, never re-derived from another loop), compute this
	// cycle's values, then persist the new snapshot below for the next cycle to compare
	// against (5c's cross-loop cache shape, applied within one loop's own history instead).
	const monarchSnap = ledger(env, "agenda_monarch_snapshot");
	let priorWeights: PortfolioWeights | null = null;
	let priorSavingsRate: number | null = null;
	if (hasMonarch(env)) {
		try {
			const rawWeights = await monarchSnap.get("portfolio_weights");
			priorWeights = rawWeights ? JSON.parse(rawWeights) : null;
		} catch {
			priorWeights = null; // corrupt cache entry — treat as no snapshot yet
		}
		const rawRate = await monarchSnap.get("savings_rate");
		const parsedRate = rawRate === null ? NaN : Number(rawRate);
		priorSavingsRate = Number.isFinite(parsedRate) ? parsedRate : null;
	}
	const portfolioWeights = computePortfolioWeights(monarchHoldings);
	const savingsRate = computeSavingsRate(monarchCashflow);

	const drops = sortByUrgency([
		...detectDrops(mail, events),
		...detectKnowledgeDrops(consolidateFindings, weeklyRecallFindings),
		...detectMonarchDrops(date, monarchAccounts, monarchTransactions, monarchBudgets, { lowBalanceThreshold, unusualChargeThreshold }),
		...detectPortfolioDrift(date, portfolioWeights, priorWeights, { driftThresholdPct }),
		...detectSavingsRateDrop(date, savingsRate, priorSavingsRate, { dropThresholdPct: savingsDropThresholdPct }),
	]);

	// Persist this cycle's snapshot for the NEXT cycle's comparison — never on a dry run
	// (dry_run records/sends nothing) and only when there's something usable to cache.
	if (hasMonarch(env) && !dryRun) {
		if (Object.keys(portfolioWeights).length) await monarchSnap.mark("portfolio_weights", JSON.stringify(portfolioWeights));
		if (savingsRate !== null) await monarchSnap.mark("savings_rate", String(savingsRate));
	}

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

	const digest = composeDigest(date, proposed);

	let digestWritten = false;
	let emailed = false;
	if (!dryRun && proposed.length) {
		const dled = ledger(env, "agenda_digest");
		const digKey = `digest::${cycle}`;
		if (!(await dled.seen(digKey))) {
			try {
				await deps.digestAppend(env, `Daily/${vaultToday(env.VAULT_TZ)}.md`, buildDigestBlock(date, cycle, hasAgendaEmail(env), digest));
				digestWritten = true;
			} catch {
				/* a vault-append failure must never fail the cycle */
			}
			if (hasAgendaEmail(env)) {
				try {
					await deps.sendDigest(env, digest.subject, digest.body);
					emailed = true;
				} catch {
					/* an email failure must never fail the cycle — the proposals are already recorded */
				}
			}
			await dled.mark(digKey);
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
		proposals: proposed.map((p) => ({ id: p.proposalId, kind: p.drop.kind, title: p.drop.title, urgency: p.drop.urgency })),
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
		},
		consolidateFindings: lastConsolidateFindings,
		weeklyRecallFindings: lastWeeklyRecallFindings,
		monarchAccounts: async (env) => {
			const r = await monarch.run(env, { op: "accounts" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "monarch accounts failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.accounts ?? []).map((a: any) => ({ id: String(a?.id ?? ""), name: a?.name, balance: typeof a?.balance === "number" ? a.balance : undefined }));
		},
		monarchTransactions: async (env, o) => {
			const r = await monarch.run(env, { op: "transactions", start: o.start, end: o.end, limit: 100 });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "monarch transactions failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.transactions ?? []).map((t: any) => ({ id: String(t?.id ?? ""), amount: typeof t?.amount === "number" ? t.amount : undefined, date: t?.date, merchant: t?.merchant }));
		},
		monarchBudgets: async (env, o) => {
			const r = await monarch.run(env, { op: "budgets", month: o.month });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "monarch budgets failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.budgets ?? []).map((b: any) => ({ category: b?.category, categoryId: b?.categoryId, remaining: typeof b?.remaining === "number" ? b.remaining : undefined }));
		},
		monarchHoldings: async (env) => {
			const r = await monarch.run(env, { op: "holdings" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "monarch holdings failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.holdings ?? []).map((h: any) => ({ ticker: h?.ticker, name: h?.name, value: typeof h?.value === "number" ? h.value : undefined, quantity: typeof h?.quantity === "number" ? h.quantity : undefined }));
		},
		monarchCashflow: async (env, o) => {
			const r = await monarch.run(env, { op: "cashflow", start: o.start, end: o.end });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "monarch cashflow failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			const summary = parsed.summary;
			if (!summary || typeof summary !== "object") return null;
			return {
				sumIncome: typeof summary.sumIncome === "number" ? summary.sumIncome : undefined,
				sumExpense: typeof summary.sumExpense === "number" ? summary.sumExpense : undefined,
				savings: typeof summary.savings === "number" ? summary.savings : undefined,
				savingsRate: typeof summary.savingsRate === "number" ? summary.savingsRate : undefined,
			};
		},
	};
}
