// The mail-triage bot's engine — the classify → confidence-gate → act(reversible) →
// log → digest loop, orchestrating the EXISTING mail verbs (mail_search / moveMessages)
// rather than re-implementing JMAP. Two things live here: the fail-closed GATES and the
// rules-stub CLASSIFIER, both structured so the autonomous surface stays dormant until
// Colin flips a flag and so a real learning classifier (chunk 03's embeddings/kNN, not
// built yet) can drop in behind the same `classify()` seam without touching the loop.
//
// SAFETY (fail-closed, two-stage):
//   • MAIL_TRIAGE_ENABLED unset  → the whole loop is a total no-op (dormant). The fn and
//     the daily cron tick return immediately, mutating nothing, reading nothing.
//   • MAIL_TRIAGE_ENABLED set, MAIL_TRIAGE_ACT unset → classify + suggest + digest ONLY;
//     no mailbox is ever mutated (suggest-only by construction — the "first cycle is
//     suggest-only" acceptance criterion is structural here, not a mutable default).
//   • both set → it may perform REVERSIBLE moves only (archive/junk), confidence-gated,
//     every move logged for one-call bulk-undo. It NEVER deletes and never touches a
//     delete-capable verb — delete stays exclusively human.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { errMsg, vaultToday } from "./_util";
import { appendTriageEntries, type TriageEntry } from "./_mail_triage_log";

// ── Gates ────────────────────────────────────────────────────────────────────
// A dedicated toggle var (not a credential): FASTMAIL_TOKEN is required for mail to
// work AT ALL, so gating the act path on it would arm the bot the moment mail works.
// These are their own flags, default OFF, read as a truthy toggle ("0"/"false"/"off"/
// empty → off) rather than mere presence so an explicit MAIL_TRIAGE_ACT=0 stays off.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The classify→suggest→digest loop may run at all. Unset → the feature is dormant (no-op). */
export const hasMailTriage = (env: RtEnv): boolean => flagOn(env.MAIL_TRIAGE_ENABLED);

/** The bot may perform reversible mailbox moves. Requires MAIL_TRIAGE_ENABLED too — so a
 *  stray MAIL_TRIAGE_ACT without the master enable never arms anything (fail-closed). */
export const hasMailTriageAct = (env: RtEnv): boolean => hasMailTriage(env) && flagOn(env.MAIL_TRIAGE_ACT);

// ── Classifier (rules stub) ───────────────────────────────────────────────────
export type TriageLabel = "junk" | "receipt" | "newsletter" | "notification" | "personal" | "unknown";
export type Classification = { label: TriageLabel; confidence: number; reason: string };
export type TriageMsg = { id: string; from?: string; subject?: string; preview?: string };

/** Confidence at/above which an actionable label may auto-act. Conservative on purpose:
 *  in v1 the confidence gate is the ONLY thing between a bad label and a real move. */
export const CONFIDENCE_THRESHOLD = 0.75;

/** Label → the reversible action to take (target mailbox role), or null = never auto-act
 *  (personal/unknown stay in the inbox). Every target is a reversible MOVE — no delete. */
const ACTION_FOR: Record<TriageLabel, { target: string } | null> = {
	junk: { target: "junk" }, // moving into Junk is Fastmail's actual junk-teach mechanism
	receipt: { target: "archive" },
	newsletter: { target: "archive" },
	notification: { target: "archive" },
	personal: null,
	unknown: null,
};

const JUNK_SUBJECT = /\b(lottery|you won|winner|claim your prize|viagra|nigerian prince|wire transfer|risk-free|act now|100% free|congratulations you|crypto giveaway)\b/i;
const RECEIPT = /\b(receipt|invoice|order confirmation|your order|order #|order placed|payment (received|confirmation))\b/i;
const NEWSLETTER_CUE = /\b(newsletter|digest|weekly|unsubscribe|this email was sent to)\b/i;
const NEWSLETTER_FROM = /(newsletter|no-?reply|news@|updates?@|hello@|team@|marketing@)/i;
const NOTIFY_FROM = /(no-?reply|do-?not-?reply|notif|alert|updates?@|automated|@notifications?\.)/i;
const PERSONAL_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com"]);

/** Pure rules-stub classifier: sender-domain + subject/preview heuristics against a small
 *  fixed category set. Returns LOW confidence for anything unmatched, so the confidence gate
 *  stays meaningful without any learned model. Table-driven and side-effect-free (unit-tested). */
export function classifyMessage(msg: TriageMsg): Classification {
	const from = String(msg.from ?? "").toLowerCase();
	const subject = String(msg.subject ?? "");
	const preview = String(msg.preview ?? "");
	const hay = `${subject}\n${preview}`;
	const domain = (from.match(/@([^\s>,;]+)/)?.[1] ?? "").replace(/[>).]+$/, "");
	if (JUNK_SUBJECT.test(hay)) return { label: "junk", confidence: 0.9, reason: "spam-signal subject/body" };
	if (RECEIPT.test(subject)) return { label: "receipt", confidence: 0.85, reason: "receipt/invoice subject" };
	if (NEWSLETTER_CUE.test(hay) && (NEWSLETTER_FROM.test(from) || NEWSLETTER_CUE.test(preview))) return { label: "newsletter", confidence: 0.8, reason: "newsletter cue + bulk sender" };
	if (NOTIFY_FROM.test(from)) return { label: "notification", confidence: 0.75, reason: "automated notification sender" };
	if (PERSONAL_DOMAINS.has(domain)) return { label: "personal", confidence: 0.7, reason: "personal-provider sender" };
	return { label: "unknown", confidence: 0.2, reason: "no rule matched" };
}

/** The pluggable classify SEAM. Today it is the rules stub; when chunk 03's learning
 *  substrate (embeddings + kNN over Colin's own filing history) lands, branch here on its
 *  presence and fall back to classifyMessage — the loop below never needs to change. */
export function classify(_env: RtEnv, msg: TriageMsg): Classification {
	return classifyMessage(msg);
}

// ── The loop ───────────────────────────────────────────────────────────────────
export type TriageDeps = {
	search: (env: RtEnv, opts: { mailbox: string; unread?: boolean; limit: number }) => Promise<TriageMsg[]>;
	move: (env: RtEnv, ids: string[], target: string) => Promise<void>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
};

export type TriageOpts = { mailbox?: string; max?: number; dry_run?: boolean; cycle_id?: string; budget_ms?: number; unread?: boolean };

export type TriageReport = {
	cycle: string;
	dormant?: boolean;
	mailbox?: string;
	act_enabled?: boolean;
	scanned?: number;
	new?: number;
	skipped_seen?: number;
	acted?: Array<{ id: string; label: string; confidence: number; to: string }>;
	suggested?: Array<{ id: string; label: string; confidence: number; reason: string }>;
	truncated?: boolean;
	digest_written?: boolean;
	undo?: string;
	note?: string;
};

const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

/** Build the markdown digest block appended to the daily note. `undo` is the cycle id —
 *  the handle a human passes back to `mail_triage {action:'undo', cycle_id}` to reverse it. */
function buildDigest(r: { cycle: string; mailbox: string; actEnabled: boolean; acted: TriageReport["acted"]; suggested: TriageReport["suggested"] }): string {
	const acted = r.acted ?? [];
	const suggested = r.suggested ?? [];
	const lines: string[] = [];
	lines.push(`\n## Mail triage — ${new Date().toISOString()} (${r.mailbox})`);
	lines.push(`_cycle \`${r.cycle}\` · ${r.actEnabled ? "acting" : "suggest-only"}_`);
	lines.push(`**Did (${acted.length}):**`);
	if (acted.length) for (const a of acted) lines.push(`- moved \`${a.id}\` → ${a.to} (${a.label}, ${a.confidence.toFixed(2)})`);
	else lines.push(`- (nothing moved)`);
	lines.push(`**Suggests (${suggested.length}):**`);
	if (suggested.length) for (const s of suggested) lines.push(`- \`${s.id}\` — ${s.label} (${s.confidence.toFixed(2)}): ${s.reason}`);
	else lines.push(`- (none)`);
	lines.push(`**Undo:** \`mail_triage {action:"undo", cycle_id:"${r.cycle}"}\``);
	return `${lines.join("\n")}\n`;
}

/** Run one triage cycle. Fail-closed: returns a dormant no-op unless MAIL_TRIAGE_ENABLED.
 *  Self-bounds its own wall-clock budget because the cron `scheduled()` path bypasses the
 *  normal FN_DEADLINE_MS guard — past the budget it stops claiming new messages, reports
 *  `truncated`, and never pretends it finished the cycle. Idempotent per message via the
 *  `mail_triage` ledger (markIfNew), so a re-run performs zero new actions on seen ids. */
export async function runTriage(env: RtEnv, opts: TriageOpts, deps: TriageDeps): Promise<TriageReport> {
	const cycle = String(opts.cycle_id ?? new Date().toISOString().replace(/[:.]/g, "-"));
	if (!hasMailTriage(env)) {
		return { cycle, dormant: true, note: "mail_triage is disabled — set MAIL_TRIAGE_ENABLED to classify+suggest+digest; also set MAIL_TRIAGE_ACT to allow reversible moves. Fail-closed: nothing runs until the flag is set." };
	}
	const mailbox = String(opts.mailbox ?? "inbox");
	const max = numClamp(opts.max, 1, 100, 25);
	const budgetMs = numClamp(opts.budget_ms, 1000, 45_000, 20_000);
	const deadline = Date.now() + budgetMs;
	const actAllowed = opts.dry_run !== true && hasMailTriageAct(env);
	const led = ledger(env, "mail_triage");

	const msgs = await deps.search(env, { mailbox, unread: opts.unread === true, limit: max });
	let scanned = 0;
	let skipped = 0;
	let truncated = false;
	const acted: NonNullable<TriageReport["acted"]> = [];
	const suggested: NonNullable<TriageReport["suggested"]> = [];
	const logEntries: TriageEntry[] = [];

	for (const m of msgs) {
		if (Date.now() >= deadline) {
			truncated = true;
			break;
		}
		scanned++;
		if (!m?.id) continue;
		// Idempotent pull: the message id is a natural last-seen key — markIfNew records it
		// and returns false forever after, so re-runs (and the daily cron) never re-process.
		if (!(await led.markIfNew(m.id))) {
			skipped++;
			continue;
		}
		const c = classify(env, m);
		const action = ACTION_FOR[c.label];
		const wouldAct = !!action && c.confidence >= CONFIDENCE_THRESHOLD;
		if (wouldAct && actAllowed) {
			try {
				await deps.move(env, [m.id], action!.target);
				acted.push({ id: m.id, label: c.label, confidence: c.confidence, to: action!.target });
				logEntries.push({ cycle, id: m.id, action: "acted", label: c.label, confidence: c.confidence, reason: c.reason, subject: m.subject, from_mailbox: mailbox, to_mailbox: action!.target, at: Date.now() });
			} catch (e) {
				const reason = `move → ${action!.target} failed: ${errMsg(e)}`;
				suggested.push({ id: m.id, label: c.label, confidence: c.confidence, reason });
				logEntries.push({ cycle, id: m.id, action: "suggested", label: c.label, confidence: c.confidence, reason, subject: m.subject, at: Date.now() });
			}
		} else {
			const why = !action ? `${c.label}: no auto-action` : c.confidence < CONFIDENCE_THRESHOLD ? `low confidence ${c.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}` : "act path disabled (suggest-only)";
			const reason = `${c.reason} — ${why}${action ? `; suggest move → ${action.target}` : ""}`;
			suggested.push({ id: m.id, label: c.label, confidence: c.confidence, reason });
			logEntries.push({ cycle, id: m.id, action: "suggested", label: c.label, confidence: c.confidence, reason, subject: m.subject, ...(action ? { to_mailbox: action.target } : {}), at: Date.now() });
		}
	}

	if (logEntries.length) await appendTriageEntries(env, logEntries);

	// Digest: best-effort, idempotent per cycle id (a double cron-fire won't double-append).
	let digestWritten = false;
	if (acted.length || suggested.length) {
		const dled = ledger(env, "mail_triage_digest");
		const digKey = `digest::${cycle}`;
		if (!(await dled.seen(digKey))) {
			try {
				await deps.digestAppend(env, `Daily/${vaultToday(env.VAULT_TZ)}.md`, buildDigest({ cycle, mailbox, actEnabled: actAllowed, acted, suggested }));
				await dled.mark(digKey);
				digestWritten = true;
			} catch {
				// A vault-append failure must never fail the cycle — the moves are already done + logged.
			}
		}
	}

	return { cycle, mailbox, act_enabled: actAllowed, scanned, new: acted.length + suggested.length, skipped_seen: skipped, acted, suggested, truncated, digest_written: digestWritten, undo: cycle };
}

/** The real deps: mail_search + moveMessages (mail-mcp) and the git-backed vault append
 *  (obsidian fn). Dynamically imported to break the fns→mail-mcp→index cycle, mirroring
 *  renderHtml's dynamic-import idiom in _util.ts. Tests inject fakes instead. */
export async function defaultDeps(): Promise<TriageDeps> {
	const mail = await import("../mail-mcp");
	const { obsidian } = await import("./obsidian");
	const searchTool = mail.MAIL_TOOLS.find((t) => t.name === "mail_search");
	return {
		search: async (env, o) => {
			if (!searchTool) throw new Error("mail_search tool not found");
			const r = await searchTool.run(env, { mailbox: o.mailbox, ...(o.unread ? { unread: true } : {}), limit: o.limit });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail_search failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.emails ?? []).map((e: any) => ({ id: String(e?.id ?? ""), from: e?.from, subject: e?.subject, preview: e?.preview }));
		},
		move: async (env, ids, target) => {
			const r = await mail.moveMessages(env, ids, target);
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "move failed");
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
	};
}
