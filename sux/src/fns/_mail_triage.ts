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
//   • both set → it may perform only the ops on the auto-act allow-list (AUTO_ACT_OPS:
//     label:add, archive, unarchive, undelete), confidence-gated, every action logged for
//     one-call bulk-undo. Two bars, per Colin's 2026-07-12 ruling reconciled with [[safe-
//     direction-autonomy]]: the attention-INCREASING ops (label:add, unarchive, undelete —
//     add a keyword in place, restore to the inbox) clear the normal CONFIDENCE_THRESHOLD;
//     `archive` is the ONE attention-reducing op allowed, and only at the much higher
//     ARCHIVE_CONFIDENCE_THRESHOLD — below that bar a receipt/newsletter/notification guess
//     de-escalates to labeling in place (kept visible) rather than hiding mail Colin hasn't
//     seen. junk still LABELS in place (never files into Junk). delete, junk-move, and
//     label-remove (the other attention-reducing moves) stay structurally unrepresentable —
//     no such `TriageOp` variant exists — so they can never be smuggled past the gate.
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
/** `op` is an optional PER-MESSAGE reversible override of the label's default `ACTION_FOR` op —
 *  used by service-notification classification to attach a type-specific label keyword (e.g.
 *  `gh:ci-fail`) instead of the label's blanket action. It is still funnelled through the same
 *  auto-act allow-list + confidence gate, so an override can never smuggle a non-reversible op. */
export type Classification = { label: TriageLabel; confidence: number; reason: string; op?: TriageOp };
export type TriageMsg = { id: string; from?: string; subject?: string; preview?: string };

/** Confidence at/above which an attention-INCREASING op (label:add / unarchive / undelete) may
 *  auto-act. Conservative on purpose: in v1 the confidence gate is the ONLY thing between a bad
 *  label and a real action. */
export const CONFIDENCE_THRESHOLD = 0.75;

/** The HIGHER bar `archive` must clear — the one attention-REDUCING op the bot may take. Archiving
 *  hides mail Colin hasn't seen, so per his 2026-07-12 ruling ("auto-archive HIGH-CONFIDENCE only")
 *  reconciled with [[safe-direction-autonomy]] it needs far more certainty than a label. Below this
 *  bar a declutter guess de-escalates to labeling in place (see `resolveOp`), never hiding. */
export const ARCHIVE_CONFIDENCE_THRESHOLD = 0.9;

/** The auto-act allow-list: the EXACT set of ops the bot may perform when armed. Three are
 *  attention-INCREASING (label:add keeps mail in place + tagged; unarchive/undelete restore it to
 *  the inbox) and clear the normal bar; `archive` is the one attention-REDUCING op, allowed only
 *  above ARCHIVE_CONFIDENCE_THRESHOLD. The other hiding moves (delete, junk-move, label-remove) are
 *  deliberately absent. Enforced by `isAutoActAllowed` at the executor boundary, and structurally
 *  by `TriageOp` (no delete/junk-move/label-remove op is representable). */
export const AUTO_ACT_OPS = ["label:add", "archive", "unarchive", "undelete"] as const;
export type AutoActOp = (typeof AUTO_ACT_OPS)[number];

/** A triage action. archive/unarchive/undelete are mailbox moves (unarchive/undelete restore to the
 *  inbox — the attention-increasing side of archive/delete; archive is the lone hiding move, gated
 *  high); `label` adds a non-hiding keyword that leaves the message exactly where it is. There is no
 *  delete/junk-move/label-remove variant — those hiding directions stay human-gated, unrepresentable. */
export type TriageOp = { kind: "archive" } | { kind: "unarchive" } | { kind: "undelete" } | { kind: "label"; label: string; add: boolean };

// Widened to `string` (not AutoActOp) so a `label`-remove op — representable but NOT allow-listed —
// projects to its off-list token and is rejected by the guard rather than failing to type-check.
const opToken = (op: TriageOp): string => (op.kind === "label" ? (op.add ? "label:add" : "label:remove") : op.kind);

/** Guard: is this op on the auto-act allow-list? The ACTION_FOR ops (label:add, archive, and
 *  unarchive/undelete were they ever emitted) pass; a label-REMOVE fails here — defense-in-depth
 *  so a future classifier can never smuggle an attention-reducing label-remove past the gate. */
export const isAutoActAllowed = (op: TriageOp): boolean => (AUTO_ACT_OPS as readonly string[]).includes(opToken(op));

/** Classifier label → the ideal op to take, or null = never auto-act (personal/unknown stay in the
 *  inbox untouched). Declutter labels (receipt/newsletter/notification) map to `archive`, but the
 *  loop runs every op through `resolveOp` first: an archive only survives above the high archive bar,
 *  otherwise it de-escalates to labeling in place. A junk guess LABELS (never files into Junk). */
export const ACTION_FOR: Record<TriageLabel, TriageOp | null> = {
	junk: { kind: "label", label: "junk", add: true },
	receipt: { kind: "archive" },
	newsletter: { kind: "archive" },
	notification: { kind: "archive" },
	personal: null,
	unknown: null,
};

/** Confidence-resolve an op before it acts: `archive` is attention-reducing, so below the high
 *  ARCHIVE_CONFIDENCE_THRESHOLD it de-escalates to a same-name label kept in the inbox — a
 *  low-confidence declutter guess tags mail but never hides it. Every other op passes through
 *  unchanged (already gated at CONFIDENCE_THRESHOLD by the loop). */
export function resolveOp(op: TriageOp, label: TriageLabel, confidence: number): TriageOp {
	if (op.kind === "archive" && confidence < ARCHIVE_CONFIDENCE_THRESHOLD) return { kind: "label", label, add: true };
	return op;
}

/** Project an op into the acted-record `to` field + the log fields needed to REVERSE it:
 *  a move records its origin/target mailbox (undo moves back to origin); a label records the
 *  keyword (undo removes it). Keeps the loop and the undo path reading from one source of truth. */
function opRecord(op: TriageOp, fromMailbox: string): { to: string; log: Partial<TriageEntry> } {
	if (op.kind === "label") return { to: `${op.add ? "+" : "-"}label:${op.label}`, log: { op: "label", keyword: op.label } };
	// archive files into Archive; unarchive/undelete both restore to the inbox.
	const to = op.kind === "archive" ? "archive" : "inbox";
	return { to, log: { op: op.kind, from_mailbox: fromMailbox, to_mailbox: to } };
}

const JUNK_SUBJECT = /\b(lottery|you won|winner|claim your prize|viagra|nigerian prince|wire transfer|risk-free|act now|100% free|congratulations you|crypto giveaway)\b/i;
const RECEIPT = /\b(receipt|invoice|order confirmation|your order|order #|order placed|payment (received|confirmation))\b/i;
const NEWSLETTER_CUE = /\b(newsletter|digest|weekly|unsubscribe|this email was sent to)\b/i;
const NEWSLETTER_FROM = /(newsletter|no-?reply|news@|updates?@|hello@|team@|marketing@)/i;
const NOTIFY_FROM = /(no-?reply|do-?not-?reply|notif|alert|updates?@|automated|@notifications?\.)/i;
const PERSONAL_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com"]);

// ── Service-notification rule ──────────────────────────────────────────────────
// Dev/CI service notifications (GitHub, GitLab, Vercel, CircleCI) are worth KEEPING visible and
// sorted by TYPE, not blanket-archived like a generic `notification`. This rule is reversible-only
// by construction: it always emits a `label:add` op (`<svc>:<type>`), never archive/delete — so a
// mislabel is a one-call un-label away and a CI failure or mention is never hidden from the inbox.
const SERVICE_SENDERS: Array<{ re: RegExp; prefix: string; sub: boolean }> = [
	{ re: /@(.*\.)?github\.com\b/i, prefix: "gh", sub: true }, // notifications@github.com et al.
	{ re: /@(.*\.)?gitlab\.com\b/i, prefix: "gitlab", sub: false },
	{ re: /@(.*\.)?vercel\.com\b/i, prefix: "vercel", sub: false },
	{ re: /@(.*\.)?circleci\.com\b/i, prefix: "ci", sub: false },
];
// GitHub-style subtypes, first match wins; only cues that survive on subject/preview ALONE (no
// X-GitHub-Reason header available here) are used, so we stay honest and fall back to `:activity`.
const SERVICE_SUBTYPES: Array<{ re: RegExp; type: string }> = [
	{ re: /\bdependabot\b|^\s*bump\b|\bbuild\(deps\b/i, type: "dependabot" },
	{ re: /\b(run failed|build failed|deploy(ment)? failed|workflow.*fail|ci (failed|failure)|checks? failed|job failed|is failing)\b/i, type: "ci-fail" },
	{ re: /\bmentioned you\b/i, type: "mention" },
	{ re: /\b(review requested|requested (your|a) review|requested changes|approved these changes|new review on)\b/i, type: "review" },
];

/** Classify a dev/CI service notification into a reversible type-label op, or null if the sender
 *  isn't a known service. Sender match gives the `<prefix>`; subject+preview cues give the subtype
 *  (GitHub only — others get `<prefix>:notification`). Always a `label:add`, never a hiding move. */
export function detectServiceNotification(from: string, subject: string, preview: string): Classification | null {
	const svc = SERVICE_SENDERS.find((s) => s.re.test(from));
	if (!svc) return null;
	const hay = `${subject}\n${preview}`;
	const sub = svc.sub ? SERVICE_SUBTYPES.find((t) => t.re.test(hay))?.type : undefined;
	const type = sub ?? "notification";
	// A recognized subtype is a strong signal (sender + cue); a bare service sender is still solid.
	const confidence = sub ? 0.9 : 0.8;
	return { label: "notification", confidence, reason: `${svc.prefix} ${type} notification`, op: { kind: "label", label: `${svc.prefix}:${type}`, add: true } };
}

/** Pure rules-stub classifier: sender-domain + subject/preview heuristics against a small
 *  fixed category set. Returns LOW confidence for anything unmatched, so the confidence gate
 *  stays meaningful without any learned model. Table-driven and side-effect-free (unit-tested). */
export function classifyMessage(msg: TriageMsg): Classification {
	const from = String(msg.from ?? "").toLowerCase();
	const subject = String(msg.subject ?? "");
	const preview = String(msg.preview ?? "");
	const hay = `${subject}\n${preview}`;
	const domain = (from.match(/@([^\s>,;]+)/)?.[1] ?? "").replace(/[>).]+$/, "");
	const isPersonal = PERSONAL_DOMAINS.has(domain);
	if (JUNK_SUBJECT.test(hay)) return { label: "junk", confidence: 0.9, reason: "spam-signal subject/body" };
	if (RECEIPT.test(subject)) return { label: "receipt", confidence: 0.85, reason: "receipt/invoice subject" };
	// Dev/CI service notifications: label by type + KEEP visible. Checked before the newsletter/
	// notify branches, both of which a GitHub sender would otherwise match (notifications@github.com
	// hits NOTIFY_FROM's `notif`, and a "digest" subject hits the newsletter cue) — and be archived.
	const svc = detectServiceNotification(from, subject, preview);
	if (svc) return svc;
	// Newsletter needs a SENDER signal, never a body/preview cue alone: a bulk-sender address
	// (NEWSLETTER_FROM), or — only for a NON-personal domain — a preview cue. Gating the
	// preview-only path behind !isPersonal stops a real person's mail that merely says
	// "weekly"/"unsubscribe" from being mislabeled a newsletter and auto-archived.
	if (NEWSLETTER_CUE.test(hay) && (NEWSLETTER_FROM.test(from) || (!isPersonal && NEWSLETTER_CUE.test(preview)))) return { label: "newsletter", confidence: 0.8, reason: "newsletter cue + bulk sender" };
	if (NOTIFY_FROM.test(from)) return { label: "notification", confidence: 0.75, reason: "automated notification sender" };
	if (isPersonal) return { label: "personal", confidence: 0.7, reason: "personal-provider sender" };
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
	act: (env: RtEnv, ids: string[], op: TriageOp) => Promise<void>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
	/** Override the classify SEAM (defaults to the module `classify`). The seam a learning
	 *  classifier drops into; tests inject it to drive the loop with arbitrary confidences. */
	classify?: (env: RtEnv, msg: TriageMsg) => Classification;
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
	acted?: Array<{ id: string; label: string; confidence: number; op: string; to: string }>;
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
	if (acted.length) for (const a of acted) lines.push(`- ${a.op === "label" ? "labeled" : a.op} \`${a.id}\` → ${a.to} (${a.label}, ${a.confidence.toFixed(2)})`);
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
		return { cycle, dormant: true, note: "mail_triage is disabled — set MAIL_TRIAGE_ENABLED to classify+suggest+digest; also set MAIL_TRIAGE_ACT to allow the auto-act ops (label:add/unarchive/undelete, plus archive only above the high archive-confidence bar). Fail-closed: nothing runs until the flag is set." };
	}
	const mailbox = String(opts.mailbox ?? "inbox");
	const max = numClamp(opts.max, 1, 100, 25);
	const budgetMs = numClamp(opts.budget_ms, 1000, 45_000, 20_000);
	const deadline = Date.now() + budgetMs;
	const actAllowed = opts.dry_run !== true && hasMailTriageAct(env);
	const led = ledger(env, "mail_triage");

	// Default the autonomous scan to UNREAD-only so the bot never touches mail Colin has
	// intentionally opened and kept in the inbox. `unread:false` is an explicit override.
	const msgs = await deps.search(env, { mailbox, unread: opts.unread !== false, limit: max });
	let scanned = 0;
	let skipped = 0;
	let truncated = false;
	const acted: NonNullable<TriageReport["acted"]> = [];
	const suggested: NonNullable<TriageReport["suggested"]> = [];

	for (const m of msgs) {
		if (Date.now() >= deadline) {
			truncated = true;
			break;
		}
		scanned++;
		if (!m?.id) continue;
		// Idempotency: the message id is a natural last-seen key. We CHECK it up front (skip
		// already-processed ids so daily cron re-runs are no-ops), but only MARK it seen AFTER
		// a definitive decision below — never before. This fixes two bugs: a transient act
		// failure must be retried (so we don't mark on failure), and a suggest-ONLY pass must
		// not block a later ACT pass (so we don't mark when acting is disabled). Enabling ACT
		// therefore still processes the full backlog.
		if (await led.seen(m.id)) {
			skipped++;
			continue;
		}
		const c = (deps.classify ?? classify)(env, m);
		// A classification may carry a per-message op override (service notifications attach a
		// type-specific label); otherwise fall back to the label's default action. `resolveOp`
		// then applies the archive confidence bar — a low-confidence archive de-escalates to a
		// label kept in the inbox, so declutter mail is only HIDDEN when we're highly certain.
		const base = c.op ?? ACTION_FOR[c.label];
		const op = base ? resolveOp(base, c.label, c.confidence) : null;
		// Allow-list guard sits BEFORE the confidence gate: an op not on AUTO_ACT_OPS can never act.
		const wouldAct = !!op && isAutoActAllowed(op) && c.confidence >= CONFIDENCE_THRESHOLD;
		const rec = op ? opRecord(op, mailbox) : null;
		let markSeen = false;
		// This message's log entry, persisted BEFORE led.mark below (see the ordering note).
		let entry: TriageEntry | null = null;
		if (wouldAct && actAllowed) {
			try {
				await deps.act(env, [m.id], op!);
				acted.push({ id: m.id, label: c.label, confidence: c.confidence, op: rec!.log.op ?? op!.kind, to: rec!.to });
				entry = { cycle, id: m.id, action: "acted", label: c.label, confidence: c.confidence, reason: c.reason, subject: m.subject, at: Date.now(), ...rec!.log };
				markSeen = true; // acted successfully → don't reprocess
			} catch (e) {
				const reason = `act ${rec!.to} failed: ${errMsg(e)}`;
				suggested.push({ id: m.id, label: c.label, confidence: c.confidence, reason });
				entry = { cycle, id: m.id, action: "suggested", label: c.label, confidence: c.confidence, reason, subject: m.subject, at: Date.now() };
				// act FAILED → leave unseen so the next cycle retries.
			}
		} else {
			const why = !op ? `${c.label}: no auto-action` : c.confidence < CONFIDENCE_THRESHOLD ? `low confidence ${c.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}` : "act path disabled (suggest-only)";
			const reason = `${c.reason} — ${why}${rec ? `; suggest ${rec.to}` : ""}`;
			suggested.push({ id: m.id, label: c.label, confidence: c.confidence, reason });
			entry = { cycle, id: m.id, action: "suggested", label: c.label, confidence: c.confidence, reason, subject: m.subject, ...(rec ? rec.log : {}), at: Date.now() };
			// Mark seen only on a definitive no-act decision while ACT is enabled (so daily
			// re-runs don't re-suggest). In pure suggest-only mode, leave it unseen so that
			// turning ACT on later still actions the existing inbox.
			if (actAllowed) markSeen = true;
		}
		// Reversibility invariant: PERSIST the undo-log entry for this message BEFORE marking it
		// seen. led.mark is what stops the next cycle from reprocessing; if we marked first and
		// then crashed (or the isolate was evicted) before writing the log, an ACTED message would
		// be un-undoable — acted-but-unlogged. Log-then-mark, per message, closes that window.
		if (entry) await appendTriageEntries(env, [entry]);
		if (markSeen) await led.mark(m.id);
	}

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

/** The real deps: mail_search + moveMessages/labelMessages (mail-mcp) and the git-backed vault append
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
		act: async (env, ids, op) => {
			if (op.kind === "label") {
				const r = await mail.labelMessages(env, ids, op.label, op.add);
				if (r.isError) throw new Error(r.content?.[0]?.text ?? "label failed");
				return;
			}
			// archive files into Archive; unarchive/undelete both restore to the inbox.
			const target = op.kind === "archive" ? "archive" : "inbox";
			const r = await mail.moveMessages(env, ids, target);
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "move failed");
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
	};
}
