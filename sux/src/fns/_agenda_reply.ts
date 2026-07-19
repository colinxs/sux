// The agenda loop's inbound half (W2.1, docs/design/personal-agent-roadmap.md epic #228) —
// email is a bidirectional command surface: _agenda.ts's digest asks Colin to reply
// `approve <id>` / `snooze <id> 3d` / `reject <id>`; this module is what actually reads
// those replies and dispatches them through the W1 proposal kernel (proposals.ts).
//
// AUTH (the load-bearing part — an inbound email is untrusted content):
//   1. The message's From must match one of Colin's OWN verified send-from addresses
//      (mail_identities) — a stranger's mail can never dispatch a command, even one that
//      literally reads "approve 1a2b3c4d".
//   2. The subject must still carry the digest's own prefix (composeDigest's `sux · `,
//      surviving any number of Re:/Fwd: hops) — a cheap pre-filter so gate 3's jmap lookup
//      only runs for messages that at least look like a digest-thread reply.
//   3. The message's In-Reply-To/References headers (raw jmap Email/get — mail_search's
//      shapeRef() doesn't expose them) must name a Message-ID that _agenda.ts's sendDigest
//      ledgered when it actually sent a digest (`agenda_digest_msgid`, 30d TTL). This is the
//      real binding: gate 2's subject prefix is guessable by anyone, but only a genuine
//      reply-chain to a digest sux itself sent carries one of these Message-IDs.
//   Only messages that pass ALL THREE gates are ever fed to the command parser.
//   Residual limitation: a From header is provider-parsed SMTP envelope data, not
//   cryptographically verified here (no DKIM/SPF/DMARC check in this mail stack) — gate 1
//   proves "looks like Colin's address", not "definitely Colin". Impact is bounded by the
//   proposal kernel's own locks (reversible + allow-listed fns only, no force — see
//   proposals.ts).
//
// SAFETY (fail-closed, mirrors AGENDA_ENABLED): AGENDA_REPLY_ENABLED unset ⇒ total no-op —
// scans nothing, dispatches nothing. Armed, it still only ever runs approveProposal /
// rejectProposal / snoozeProposal — the same kernel `proposals {action:'approve'}` already
// uses, with the same fail-closed allow-list + no-force guarantees. Nothing here can ever
// dispatch outside that kernel.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { approveProposal, listProposals, rejectProposal, snoozeProposal } from "../proposals";
import type { MailRef } from "./_agenda";
import { errMsg } from "./_util";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The reply-parsing loop may run at all. Unset → dormant (no-op). Requires AGENDA_ENABLED
 *  too (mirrors AGENDA_EMAIL's two-stage gate) — replying to a digest presupposes the
 *  digest loop itself is armed. */
export const hasAgendaReply = (env: RtEnv): boolean => flagOn(env.AGENDA_REPLY_ENABLED) && flagOn(env.AGENDA_ENABLED);

// ── Command grammar ───────────────────────────────────────────────────────────────
// `approve <id> [<id>…]` · `snooze <id> [<n><unit>]` · `reject <id> [<id>…]` — matches
// composeDigest's footer exactly. A short id is the first 6-12 hex chars of the uuid
// (composeDigest's shortId uses 8); tokens outside that shape are ignored, not errored —
// a reply is prose with commands embedded, not a strict command file.
export type ReplyVerb = "approve" | "reject" | "snooze";
export type ReplyCommand = { verb: ReplyVerb; ids: string[]; duration?: { n: number; unit: "h" | "d" | "w" } };

const VERB_RE = /^(approve|reject|snooze)$/i;
const ID_RE = /^[0-9a-f]{6,12}$/i;
const DURATION_RE = /^(\d+)\s*([hdw])$/i;

/** Parse every `approve|snooze|reject <id...>` command out of free-text (a reply's preview/
 *  body). Pure and total: unparseable tokens are silently dropped, never thrown. */
export function parseCommands(text: string): ReplyCommand[] {
	const tokens = String(text ?? "").split(/\s+/).filter(Boolean);
	const commands: ReplyCommand[] = [];
	let current: ReplyCommand | null = null;
	for (const raw of tokens) {
		const tok = raw.replace(/^[("'`]+|[)."'`,;:!?]+$/g, "");
		if (VERB_RE.test(tok)) {
			if (current && current.ids.length) commands.push(current);
			current = { verb: tok.toLowerCase() as ReplyVerb, ids: [] };
			continue;
		}
		if (!current) continue;
		const dur = tok.match(DURATION_RE);
		if (dur && current.verb === "snooze" && current.ids.length && !current.duration) {
			current.duration = { n: Number(dur[1]), unit: dur[2].toLowerCase() as "h" | "d" | "w" };
			continue;
		}
		if (ID_RE.test(tok)) current.ids.push(tok.toLowerCase());
	}
	if (current && current.ids.length) commands.push(current);
	return commands;
}

const DURATION_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
export const durationMs = (n: number, unit: string): number => n * (DURATION_MS[unit.toLowerCase()] ?? DURATION_MS.d);

// A digest-reply subject still carries composeDigest's `sux · ` prefix under any number of
// mail-client Re:/Fwd: hops (`Re: Fwd: Re: sux · 3 things need you (2026-07-13)`).
const DIGEST_SUBJECT_RE = /^(?:(?:re|fwd?)\s*:\s*)*sux\s*·/i;
export const looksLikeDigestReply = (subject: string | undefined): boolean => DIGEST_SUBJECT_RE.test(String(subject ?? "").trim());

/** Pull the bare address out of a From header (`"Name" <addr>` or a bare address). */
export function extractEmail(from: string | undefined): string {
	const s = String(from ?? "").trim();
	const m = s.match(/<([^>]+)>/);
	return (m ? m[1] : s.split(",")[0]).trim().toLowerCase();
}

/** Resolve a short id against the open (proposed/snoozed) queue by prefix match.
 *  Returns the full id, "ambiguous" if more than one proposal shares the prefix (never
 *  guess — surfaced as unresolved so Colin can send the fuller id), or undefined if none. */
export function resolveShortId(open: Array<{ id: string }>, token: string): string | "ambiguous" | undefined {
	const hits = open.filter((p) => p.id.toLowerCase().startsWith(token.toLowerCase()));
	if (hits.length === 1) return hits[0].id;
	if (hits.length > 1) return "ambiguous";
	return undefined;
}

// ── Deps (injectable side-effect surface — mirrors _agenda.ts/_ask_gate_reminder.ts) ──
export type AgendaReplyDeps = {
	/** Recent unread inbox messages, newest first (id/from/subject/preview). */
	mailSearch: (env: RtEnv, opts: { limit: number }) => Promise<MailRef[]>;
	/** Colin's own verified send-from addresses (mail_identities), for the sender auth gate. */
	identities: (env: RtEnv) => Promise<string[]>;
	/** This message's In-Reply-To + References Message-IDs (raw jmap Email/get) — checked
	 *  against the ledgered sent-digest Message-IDs as the thread-binding auth gate. */
	threadIds: (env: RtEnv, mailId: string) => Promise<string[]>;
	/** Full plain-text body (mail_read) — fallen back to only when the (JMAP-truncated)
	 *  `preview` parses zero commands, since a reply's command line can fall outside the
	 *  ~256-char preview window (a leading sentence, or a top-posting client). */
	mailBody: (env: RtEnv, mailId: string) => Promise<string>;
};

export type AgendaReplyReport = {
	dormant?: boolean;
	scanned?: number;
	untrusted?: number; // From didn't match a verified identity — never parsed
	not_a_reply?: number; // subject didn't carry the digest thread prefix — never parsed
	not_thread_matched?: number; // subject looked right but In-Reply-To/References named no ledgered digest — never parsed
	processed?: number; // messages whose commands were parsed and dispatched
	approved?: string[];
	rejected?: string[];
	snoozed?: string[];
	unresolved?: string[]; // command tokens that named no (or an ambiguous) open proposal
	note?: string;
	error?: string;
};

const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

/** Run one reply-scan cycle. Fail-closed: dormant no-op unless AGENDA_REPLY_ENABLED (and
 *  AGENDA_ENABLED). For each unread inbox message that passes BOTH auth gates (from a
 *  verified identity, subject still a digest-thread reply), parses the approve/snooze/
 *  reject grammar and dispatches each resolved id through the real proposal kernel
 *  (approveProposal/rejectProposal/snoozeProposal — the same fns `proposals {action:...}`
 *  uses). Every scanned message is marked in a ledger so a re-run never reprocesses it,
 *  regardless of outcome — a typo'd id is simply unresolved, not retried forever. */
export async function runAgendaReply(env: RtEnv, opts: { max_mail?: number }, deps: AgendaReplyDeps): Promise<AgendaReplyReport> {
	if (!hasAgendaReply(env)) {
		return {
			dormant: true,
			note: "agenda_reply is disabled — set AGENDA_REPLY_ENABLED (requires AGENDA_ENABLED) to parse inbound 'approve/snooze/reject <id>' replies to the agenda digest and dispatch them through the proposal kernel. Only messages FROM one of your own mail_identities, whose subject is still a digest-thread reply ('sux · …'), AND whose In-Reply-To/References actually name a Message-ID sux ledgered when it sent that digest are ever parsed — everything else is ignored untouched. Fail-closed: nothing runs until the flag is set.",
		};
	}

	let messages: MailRef[];
	try {
		messages = await deps.mailSearch(env, { limit: numClamp(opts.max_mail, 1, 50, 25) });
	} catch (e) {
		return { error: `mail scan failed: ${errMsg(e)}` };
	}
	const identities = new Set((await deps.identities(env).catch(() => [])).map((e) => e.toLowerCase()).filter(Boolean));

	const led = ledger(env, "agenda_reply");
	const digestMsgIds = ledger(env, "agenda_digest_msgid");
	let scanned = 0;
	let untrusted = 0;
	let notReply = 0;
	let notThreadMatched = 0;
	let processed = 0;
	const approved: string[] = [];
	const rejected: string[] = [];
	const snoozed: string[] = [];
	const unresolved: string[] = [];

	for (const m of messages) {
		scanned++;
		if (await led.seen(m.id)) continue; // already handled this message, whatever the outcome

		if (!identities.has(extractEmail(m.from))) {
			untrusted++;
			await led.mark(m.id);
			continue;
		}
		if (!looksLikeDigestReply(m.subject)) {
			notReply++;
			await led.mark(m.id);
			continue;
		}
		// Gate 3 — the real binding: the subject prefix is guessable, so require this message's
		// In-Reply-To/References to actually name a Message-ID _agenda.ts ledgered when it sent a
		// digest. Checked serially (not Promise.all) so a match short-circuits the KV reads.
		const refs = await deps.threadIds(env, m.id).catch(() => []);
		let threadMatched = false;
		for (const ref of refs) {
			if (await digestMsgIds.seen(ref)) {
				threadMatched = true;
				break;
			}
		}
		if (!threadMatched) {
			notThreadMatched++;
			await led.mark(m.id);
			continue;
		}

		let commands = parseCommands(m.preview ?? "");
		if (!commands.length) {
			// The preview is a JMAP-server-truncated snippet — a command line following a
			// lead-in sentence, or below a top-posted signature/quoted block, can fall outside
			// its window. Both auth gates already passed (verified identity + a real digest
			// thread), so it's safe/cheap to re-parse the full body before giving up.
			const body = await deps.mailBody(env, m.id).catch(() => "");
			if (body) commands = parseCommands(body);
		}
		if (commands.length) {
			processed++;
			// The open queue is re-read per message (not hoisted) so an id acted on by an
			// earlier message in THIS same scan can't be re-matched by a later one.
			const open = (await listProposals(env, { includeSnoozed: true })).filter((p) => p.status === "proposed" || p.status === "snoozed");
			for (const cmd of commands) {
				const untilMs = cmd.verb === "snooze" ? Date.now() + durationMs(cmd.duration?.n ?? 1, cmd.duration?.unit ?? "d") : undefined;
				for (const tok of cmd.ids) {
					const full = resolveShortId(open, tok);
					if (!full || full === "ambiguous") {
						unresolved.push(tok);
						continue;
					}
					try {
						if (cmd.verb === "approve") {
							await approveProposal(env, full);
							approved.push(full);
						} else if (cmd.verb === "reject") {
							await rejectProposal(env, full);
							rejected.push(full);
						} else {
							await snoozeProposal(env, full, untilMs);
							snoozed.push(full);
						}
					} catch {
						unresolved.push(tok); // dispatch failed — surfaced, never silently dropped
					}
				}
			}
		}
		await led.mark(m.id);
	}

	return { scanned, untrusted, not_a_reply: notReply, not_thread_matched: notThreadMatched, processed, approved, rejected, snoozed, unresolved };
}

// ── Real deps ───────────────────────────────────────────────────────────────────────
/** Production surface: mail_search (unread inbox) + mail_identities. Dynamically imported
 *  so the cron path pulls in the mail surface only when armed (mirrors _agenda/
 *  _ask_gate_reminder). */
export async function defaultDeps(): Promise<AgendaReplyDeps> {
	const mail = await import("../mail-mcp");
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
		identities: async (env) => {
			const t = tool("mail_identities");
			if (!t) throw new Error("mail_identities tool not found");
			const r = await t.run(env, {});
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail_identities failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return ((parsed.identities ?? []) as Array<{ email?: string }>).map((i) => i.email).filter((e): e is string => Boolean(e));
		},
		threadIds: async (env, mailId) => {
			const t = tool("jmap");
			if (!t) return [];
			try {
				const r = await t.run(env, { method: "Email/get", args: { ids: [mailId], properties: ["inReplyTo", "references"] } });
				if (r.isError) return [];
				const mrs = JSON.parse(r.content?.[0]?.text ?? "{}").methodResponses ?? [];
				const e = mrs.find((mr: any) => mr[0] === "Email/get")?.[1]?.list?.[0];
				const inReplyTo = Array.isArray(e?.inReplyTo) ? e.inReplyTo : [];
				const references = Array.isArray(e?.references) ? e.references : [];
				return [...inReplyTo, ...references].filter((x): x is string => Boolean(x));
			} catch {
				return [];
			}
		},
		mailBody: async (env, mailId) => {
			const t = tool("mail_read");
			if (!t) return "";
			const r = await t.run(env, { id: mailId });
			if (r.isError) return "";
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return String(parsed?.body ?? "");
		},
	};
}
