// The agenda/ask-gate approval loop's SECOND inbound channel (#897) — text
// `approve <id>` / `snooze <id> 3d` / `reject <id>` back to sux from a trusted phone
// number, the iMessage sibling of _agenda_reply.ts's inbound email loop (W2.1, #765).
// Reuses that module's command grammar (parseCommands/resolveShortId/durationMs)
// rather than re-deriving it — the two channels were always meant to share it.
//
// AUTH (the load-bearing part — an inbound text is untrusted content, same as an
// inbound email): a command is only ever parsed from a message that arrives on an
// iMessage thread whose contact is one of IMESSAGE_TRUSTED_HANDLES (Colin's own
// configured phone/email handles — the iMessage analogue of mail_identities, since the
// Mac-local service has no "list my own identities" call to derive it from) AND whose
// `from_me` is false (an inbound message actually received from that contact, not one
// sux itself sent — mirrors the email gate's "From matches a verified identity", not
// "in a thread with a verified identity"). There is no digest-thread-binding gate
// (_agenda_reply.ts's gate 3) here: unlike the mailed digest, sux never sends a
// proposal digest over iMessage, so there is no prior outbound Message-ID to bind a
// reply to — the trusted-handle gate is the whole boundary. Residual limitation: same
// as email, a `handle`/`contact` string is Mac chat.db data, not cryptographically
// verified — impact is bounded by the same proposal-kernel locks (reversible +
// allow-listed fns only, no force — see proposals.ts).
//
// SAFETY (fail-closed, mirrors AGENDA_REPLY_ENABLED): IMESSAGE_REPLY_ENABLED unset, OR
// AGENDA_ENABLED unset, OR IMESSAGE_TRUSTED_HANDLES unset/empty ⇒ total no-op — scans
// nothing, dispatches nothing. Armed, it still only ever runs approveProposal /
// rejectProposal / snoozeProposal, the same kernel `proposals {action:'approve'}`
// already uses. A confirmation text is always sent back for a processed message so
// silence never means success (#897's ask 3).
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { approveProposal, listProposals, rejectProposal, snoozeProposal } from "../proposals";
import { durationMs, parseCommands, resolveShortId } from "./_agenda_reply";
import { errMsg } from "./_util";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The iMessage reply-parsing loop may run at all. Requires AGENDA_ENABLED too (mirrors
 *  _agenda_reply's two-stage gate) — acting on a proposal presupposes the proposal loop
 *  itself is armed. */
export const hasImessageReply = (env: RtEnv): boolean => flagOn(env.IMESSAGE_REPLY_ENABLED) && flagOn(env.AGENDA_ENABLED);

/** Loose match so "+1 (555) 123-4567" in env and "+15551234567" from chat.db's
 *  chat_identifier still line up — strips whitespace/dashes/parens for a phone-shaped
 *  handle, lowercases. An email handle (contains `@`) is left alone — its dots are
 *  meaningful, not formatting. Not full E.164 normalization; a handle that still doesn't
 *  match after this is simply untrusted. */
export const normalizeHandle = (h: string | undefined): string => {
	const s = String(h ?? "").trim().toLowerCase();
	return s.includes("@") ? s : s.replace(/[\s\-().]/g, "");
};

/** Colin's own configured control handles (IMESSAGE_TRUSTED_HANDLES, comma-separated
 *  phone/email handles) — the iMessage equivalent of email's mail_identities gate.
 *  Unset/empty ⇒ empty set, so the gate can never pass (fail-closed, not "trust
 *  everyone" the way an absent allow-list might read). */
export function trustedHandles(env: RtEnv): Set<string> {
	return new Set(
		String(env.IMESSAGE_TRUSTED_HANDLES ?? "")
			.split(",")
			.map((h) => normalizeHandle(h))
			.filter(Boolean),
	);
}

// A 2-day lookback bounds the threads scan (imessage.ts's `threads` has no unread
// concept, same reason _agenda.ts's unanswered_text detector windows it) — this loop
// rides the frequent (~5min) cron, so a reply is always well inside the window; the
// per-message ledger below is what actually makes re-scans idempotent.
const LOOKBACK_MS = 2 * 24 * 3_600_000;

const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export type ImessageThreadRef = { id: string; contact?: string; name?: string };
export type ImessageMessageRef = { id: string; from_me: boolean; handle?: string; text?: string; at?: string };

// ── Deps (injectable side-effect surface — mirrors _agenda_reply.ts's AgendaReplyDeps) ──
export type ImessageReplyDeps = {
	/** Recent iMessage threads (imessage.ts action:'threads'). */
	threads: (env: RtEnv, opts: { since?: string }) => Promise<ImessageThreadRef[]>;
	/** A thread's recent messages, newest-last (imessage.ts action:'messages'). */
	messages: (env: RtEnv, opts: { thread: string; limit: number }) => Promise<ImessageMessageRef[]>;
	/** GATED confirmation send (imessage.ts action:'send', allow_send forced true here —
	 *  this is sux's own deliberate reply, not user-authored content passing through). */
	send: (env: RtEnv, opts: { to: string; text: string }) => Promise<void>;
};

export type ImessageReplyReport = {
	dormant?: boolean;
	scanned_threads?: number;
	untrusted_threads?: number; // thread's contact wasn't in IMESSAGE_TRUSTED_HANDLES — never scanned for commands
	processed?: number; // inbound messages whose commands were parsed and dispatched
	approved?: string[];
	rejected?: string[];
	snoozed?: string[];
	unresolved?: string[]; // command tokens that named no (or an ambiguous) open proposal
	note?: string;
	error?: string;
};

/** Run one reply-scan cycle. Fail-closed: dormant no-op unless IMESSAGE_REPLY_ENABLED
 *  (and AGENDA_ENABLED) and at least one IMESSAGE_TRUSTED_HANDLES entry. For each recent
 *  inbound message on a trusted-contact thread, parses the approve/snooze/reject grammar
 *  and dispatches each resolved id through the real proposal kernel — the same
 *  approveProposal/rejectProposal/snoozeProposal _agenda_reply.ts uses. Every scanned
 *  message is ledgered so a re-run never reprocesses it, and a confirmation text is sent
 *  back to the thread for every message that carried a command, whatever the outcome —
 *  silence never means success. */
export async function runImessageReply(env: RtEnv, opts: { max_messages?: number }, deps: ImessageReplyDeps): Promise<ImessageReplyReport> {
	if (!hasImessageReply(env)) {
		return {
			dormant: true,
			note: "imessage_reply is disabled — set IMESSAGE_REPLY_ENABLED (requires AGENDA_ENABLED) and IMESSAGE_TRUSTED_HANDLES (comma-separated phone/email handles allowed to send commands) to parse inbound 'approve/snooze/reject <id>' texts and dispatch them through the proposal kernel. Only messages received from a trusted handle are ever parsed — everything else is ignored untouched. Fail-closed: nothing runs until both are set.",
		};
	}
	const trusted = trustedHandles(env);
	if (!trusted.size) {
		return { dormant: true, note: "IMESSAGE_TRUSTED_HANDLES is unset — no handle is trusted, so nothing is ever parsed. Set it to your own phone/email handle(s) to arm this loop." };
	}

	let threads: ImessageThreadRef[];
	try {
		threads = await deps.threads(env, { since: new Date(Date.now() - LOOKBACK_MS).toISOString() });
	} catch (e) {
		return { error: `imessage thread scan failed: ${errMsg(e)}` };
	}

	const led = ledger(env, "imessage_reply");
	const limit = numClamp(opts.max_messages, 1, 20, 10);
	let scannedThreads = 0;
	let untrustedThreads = 0;
	let processed = 0;
	const approved: string[] = [];
	const rejected: string[] = [];
	const snoozed: string[] = [];
	const unresolved: string[] = [];

	for (const t of threads) {
		scannedThreads++;
		if (!trusted.has(normalizeHandle(t.contact))) {
			untrustedThreads++;
			continue;
		}

		let msgs: ImessageMessageRef[];
		try {
			msgs = await deps.messages(env, { thread: t.id, limit });
		} catch {
			continue; // one unreadable thread never sinks the whole scan
		}

		for (const m of msgs) {
			if (m.from_me) continue; // only a message actually received from the trusted contact can carry a command
			if (await led.seen(m.id)) continue;
			if (!m.text) {
				await led.mark(m.id);
				continue;
			}

			const commands = parseCommands(m.text);
			if (!commands.length) {
				await led.mark(m.id);
				continue;
			}

			processed++;
			// The open queue is re-read per message (not hoisted) so an id acted on by an
			// earlier message in THIS same scan can't be re-matched by a later one.
			const open = (await listProposals(env, { includeSnoozed: true })).filter((p) => p.status === "proposed" || p.status === "snoozed");
			const results: string[] = [];
			for (const cmd of commands) {
				const untilMs = cmd.verb === "snooze" ? Date.now() + durationMs(cmd.duration?.n ?? 1, cmd.duration?.unit ?? "d") : undefined;
				for (const tok of cmd.ids) {
					const full = resolveShortId(open, tok);
					if (!full || full === "ambiguous") {
						unresolved.push(tok);
						results.push(`${tok}: not found`);
						continue;
					}
					try {
						if (cmd.verb === "approve") {
							await approveProposal(env, full);
							approved.push(full);
							results.push(`${full.slice(0, 8)}: approved`);
						} else if (cmd.verb === "reject") {
							await rejectProposal(env, full);
							rejected.push(full);
							results.push(`${full.slice(0, 8)}: rejected`);
						} else {
							await snoozeProposal(env, full, untilMs);
							snoozed.push(full);
							results.push(`${full.slice(0, 8)}: snoozed`);
						}
					} catch {
						unresolved.push(tok); // dispatch failed — surfaced, never silently dropped
						results.push(`${tok}: failed`);
					}
				}
			}
			await led.mark(m.id);
			if (t.contact) {
				await deps.send(env, { to: t.contact, text: `sux: ${results.join(", ")}` }).catch(() => {}); // best-effort — a lost confirmation must never undo the dispatch above
			}
		}
	}

	return { scanned_threads: scannedThreads, untrusted_threads: untrustedThreads, processed, approved, rejected, snoozed, unresolved };
}

// ── Real deps ───────────────────────────────────────────────────────────────────────
/** Production surface: imessage.ts's threads/messages/send. Dynamically imported so the
 *  cron path pulls in the iMessage spoke only when armed (mirrors _agenda_reply's
 *  defaultDeps). */
export async function defaultDeps(): Promise<ImessageReplyDeps> {
	const { imessage } = await import("./imessage");
	return {
		threads: async (env, o) => {
			const r = await imessage.run(env, { action: "threads", since: o.since });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "imessage threads failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return ((parsed.threads ?? []) as Array<{ id?: number | string; contact?: string; name?: string }>)
				.filter((t) => t?.id !== undefined && t?.id !== null)
				.map((t) => ({ id: String(t.id), contact: t.contact, name: t.name ?? undefined }));
		},
		messages: async (env, o) => {
			const r = await imessage.run(env, { action: "messages", thread: o.thread, limit: o.limit });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "imessage messages failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return ((parsed.messages ?? []) as Array<{ id?: number | string; from_me?: boolean; handle?: string; text?: string; at?: string }>)
				.filter((m) => m?.id !== undefined && m?.id !== null)
				.map((m) => ({ id: String(m.id), from_me: Boolean(m.from_me), handle: m.handle ?? undefined, text: m.text ?? undefined, at: m.at ?? undefined }));
		},
		send: async (env, o) => {
			const r = await imessage.run(env, { action: "send", to: o.to, text: o.text, allow_send: true });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "imessage send failed");
		},
	};
}
