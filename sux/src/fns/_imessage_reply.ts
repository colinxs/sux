// The agenda/ask-gate approval loop's SECOND inbound channel (#897) — text
// `approve <id>` / `snooze <id> 3d` / `reject <id>` back to sux from a trusted phone
// number, the iMessage sibling of _agenda_reply.ts's inbound email loop (W2.1, #765).
// Reuses that module's command grammar (parseCommands/resolveShortId/durationMs)
// rather than re-deriving it — the two channels were always meant to share it.
//
// Also resolves paused op-engine `ask` gates (run.ts's `answer` action, #955) via a
// SEPARATE `ask <instanceId-or-prefix> [reject]` grammar (parseAskCommands below) —
// a durable Workflow instanceId is a full UUID, not a Proposal's short hex id, and it
// lives in `run action:list`'s own index, not the proposal queue, so it can't just
// reuse resolveShortId over listProposals. A distinct verb keeps the two id spaces from
// ever colliding and makes each command's target obvious to whoever's texting it. Only
// wired in here (not _agenda_reply.ts's email channel) — that's a separate follow-up
// once this one's proven out, per #955's own scoping note.
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
// allow-listed fns only, no force — see proposals.ts) for a proposal command, and by
// the op tree's OWN pre-registered `ask` gate (registry.ts) for an ask command: this
// channel can only ever answer approved:true/false to whichever gate that op already
// defined at registration time — it grants no new capability, same as answering
// `run {action:'answer'}` directly would.
//
// SAFETY (fail-closed, mirrors AGENDA_REPLY_ENABLED): IMESSAGE_REPLY_ENABLED unset, OR
// AGENDA_ENABLED unset, OR IMESSAGE_TRUSTED_HANDLES unset/empty ⇒ total no-op — scans
// nothing, dispatches nothing. Armed, it still only ever runs approveProposal /
// rejectProposal / snoozeProposal (proposal commands) or run.ts's answerVerb (ask
// commands, and only against a gate the targeted instance's own op tree actually has —
// see the single-ask-gate check below), the same kernel `proposals {action:'approve'}`/
// `run {action:'answer'}` already use. A confirmation text is always sent back for a
// processed message so silence never means success (#897's ask 3).
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

// ── Ask-gate command grammar (#955) ──────────────────────────────────────────────
// `ask <instanceId-or-prefix> [reject|no|deny]` — deliberately a different verb (not
// approve/reject/snooze) from _agenda_reply.ts's parseCommands, so the two id spaces
// (a durable run's UUID vs. a Proposal's short hex id) never collide, either for the
// parser or for whoever's reading the command back. Defaults to approve when no
// reject-shaped word follows (mirrors run.ts's answerVerb defaulting `payload` to
// {approved:true}). Pure and total, same contract as parseCommands: unparseable tokens
// are dropped, never thrown.
export type AskCommand = { token: string; approved: boolean };

const ASK_VERB_RE = /^ask$/i;
const ASK_TOKEN_RE = /^[0-9a-f-]{4,36}$/i;
const ASK_REJECT_RE = /^(reject|no|deny)$/i;

export function parseAskCommands(text: string): AskCommand[] {
	const tokens = String(text ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => t.replace(/^[("'`]+|[)."'`,;:!?]+$/g, ""));
	const commands: AskCommand[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (!ASK_VERB_RE.test(tokens[i])) continue;
		const idTok = tokens[i + 1];
		if (!idTok || !ASK_TOKEN_RE.test(idTok)) continue;
		const modTok = tokens[i + 2];
		commands.push({ token: idTok.toLowerCase(), approved: !(modTok && ASK_REJECT_RE.test(modTok)) });
	}
	return commands;
}

/** Resolve a run instanceId-or-prefix against `run action:list`'s own instances by
 *  prefix match — the ask-gate analogue of _agenda_reply.ts's resolveShortId, just over
 *  a different candidate set (durable run instances, not the open proposal queue).
 *  Same "ambiguous" / undefined contract: never guess when more than one instance
 *  shares the prefix. */
export function resolveInstanceToken(runs: Array<{ instanceId: string }>, token: string): string | "ambiguous" | undefined {
	const hits = runs.filter((r) => r.instanceId.toLowerCase().startsWith(token.toLowerCase()));
	if (hits.length === 1) return hits[0].instanceId;
	if (hits.length > 1) return "ambiguous";
	return undefined;
}

// ── Deps (injectable side-effect surface — mirrors _agenda_reply.ts's AgendaReplyDeps) ──
export type AskGateRef = { prompt: string; timeout: string; onTimeout: string };

export type ImessageReplyDeps = {
	/** Recent iMessage threads (imessage.ts action:'threads'). */
	threads: (env: RtEnv, opts: { since?: string }) => Promise<ImessageThreadRef[]>;
	/** A thread's recent messages, newest-last (imessage.ts action:'messages'). */
	messages: (env: RtEnv, opts: { thread: string; limit: number }) => Promise<ImessageMessageRef[]>;
	/** GATED confirmation send (imessage.ts action:'send', allow_send forced true here —
	 *  this is sux's own deliberate reply, not user-authored content passing through). */
	send: (env: RtEnv, opts: { to: string; text: string }) => Promise<void>;
	/** `run action:list`'s live instances (run.ts's listDurableRuns) — the candidate set
	 *  resolveInstanceToken matches an ask command's token against. */
	listRuns: (env: RtEnv) => Promise<Array<{ instanceId: string; opId: string; startedAt: number; status: string }>>;
	/** `run action:describe`'s static ask-gate prompts for a registered op id (run.ts's
	 *  describeOp). Empty/throwing means "nothing to validate against" — treated as
	 *  unresolvable, never guessed. */
	describeGates: (opId: string) => AskGateRef[];
	/** Deliver a payload to the instance's ask gate (run.ts's answerVerb). */
	answerGate: (env: RtEnv, instanceId: string, prompt: string, payload: unknown) => Promise<void>;
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
	gates_answered?: string[]; // instanceIds whose ask gate was successfully answered (#955)
	gates_unresolved?: string[]; // ask command tokens that named no (or an ambiguous/unanswerable) gate
	note?: string;
	error?: string;
};

/** Run one reply-scan cycle. Fail-closed: dormant no-op unless IMESSAGE_REPLY_ENABLED
 *  (and AGENDA_ENABLED) and at least one IMESSAGE_TRUSTED_HANDLES entry. For each recent
 *  inbound message on a trusted-contact thread, parses the approve/snooze/reject grammar
 *  and dispatches each resolved id through the real proposal kernel — the same
 *  approveProposal/rejectProposal/snoozeProposal _agenda_reply.ts uses — and separately
 *  parses the `ask <instanceId> [reject]` grammar (#955), resolving each token against
 *  `run action:list`'s live instances and delivering approved:true/false to that
 *  instance's own single ask gate via run.ts's answerVerb. Every scanned message is
 *  ledgered so a re-run never reprocesses it, and a confirmation text is sent back to the
 *  thread for every message that carried a command, whatever the outcome — silence never
 *  means success. */
export async function runImessageReply(env: RtEnv, opts: { max_messages?: number }, deps: ImessageReplyDeps): Promise<ImessageReplyReport> {
	if (!hasImessageReply(env)) {
		return {
			dormant: true,
			note: "imessage_reply is disabled — set IMESSAGE_REPLY_ENABLED (requires AGENDA_ENABLED) and IMESSAGE_TRUSTED_HANDLES (comma-separated phone/email handles allowed to send commands) to parse inbound 'approve/snooze/reject <id>' texts (dispatched through the proposal kernel) and 'ask <instanceId> [reject]' texts (dispatched through run.ts's answerVerb, for a paused op-engine ask gate — #955). Only messages received from a trusted handle are ever parsed — everything else is ignored untouched. Fail-closed: nothing runs until both are set.",
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
	const gatesAnswered: string[] = [];
	const gatesUnresolved: string[] = [];

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
			const askCommands = parseAskCommands(m.text);
			if (!commands.length && !askCommands.length) {
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

			if (askCommands.length) {
				// The run index is re-read per message, same reasoning as the open proposal
				// queue above — this scan's own earlier answers can change what `list` reports
				// (a fully-answered instance may drop out of "waiting").
				let runs: Array<{ instanceId: string; opId: string; startedAt: number; status: string }> = [];
				try {
					runs = await deps.listRuns(env);
				} catch {
					runs = []; // an unreadable run index resolves nothing this cycle, never throws
				}
				for (const cmd of askCommands) {
					const full = resolveInstanceToken(runs, cmd.token);
					if (!full || full === "ambiguous") {
						gatesUnresolved.push(cmd.token);
						results.push(`${cmd.token}: not found`);
						continue;
					}
					const entry = runs.find((r) => r.instanceId === full);
					if (entry?.status !== "waiting") {
						gatesUnresolved.push(cmd.token);
						results.push(`${full.slice(0, 8)}: not waiting`);
						continue;
					}
					// Only auto-answer when the op has EXACTLY one ask gate — with zero there's
					// nothing to target, and with more than one there's no way to tell which the
					// instance is actually paused on from the index alone (durable.ts exposes no
					// "current wait" prompt), so guessing would risk answering the wrong gate.
					let gates: AskGateRef[] = [];
					try {
						gates = deps.describeGates(entry.opId);
					} catch {
						gates = [];
					}
					if (gates.length !== 1) {
						gatesUnresolved.push(cmd.token);
						results.push(`${full.slice(0, 8)}: ${gates.length ? "ambiguous gate" : "no gate"}`);
						continue;
					}
					try {
						await deps.answerGate(env, full, gates[0].prompt, { approved: cmd.approved });
						gatesAnswered.push(full);
						results.push(`${full.slice(0, 8)}: ${cmd.approved ? "approved" : "rejected"}`);
					} catch {
						gatesUnresolved.push(cmd.token); // dispatch failed — surfaced, never silently dropped
						results.push(`${cmd.token}: failed`);
					}
				}
			}

			await led.mark(m.id);
			if (t.contact) {
				await deps.send(env, { to: t.contact, text: `sux: ${results.join(", ")}` }).catch(() => {}); // best-effort — a lost confirmation must never undo the dispatch above
			}
		}
	}

	return { scanned_threads: scannedThreads, untrusted_threads: untrustedThreads, processed, approved, rejected, snoozed, unresolved, gates_answered: gatesAnswered, gates_unresolved: gatesUnresolved };
}

// ── Real deps ───────────────────────────────────────────────────────────────────────
/** Production surface: imessage.ts's threads/messages/send, plus run.ts's
 *  listDurableRuns/describeOp/answerVerb for ask-gate resolution (#955). Dynamically
 *  imported so the cron path pulls in the iMessage spoke (and the op-engine registry)
 *  only when armed (mirrors _agenda_reply's/_ask_gate_reminder's defaultDeps). */
export async function defaultDeps(): Promise<ImessageReplyDeps> {
	const { imessage } = await import("./imessage");
	const runFns = await import("./run");
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
		listRuns: (env) => runFns.listDurableRuns(env),
		describeGates: (opId) => {
			try {
				return runFns.describeOp(opId).asks;
			} catch {
				return [];
			}
		},
		answerGate: (env, instanceId, prompt, payload) => runFns.answerVerb(instanceId, prompt, payload, env),
	};
}
