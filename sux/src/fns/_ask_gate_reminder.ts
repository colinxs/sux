// Ask-gate reminder (#723) — proactively surfaces durable `run` instances paused on a
// human `ask` gate (op-engine/durable.ts) instead of leaving discovery to "poll `run
// {action:'list'}` and notice yourself". Rides the FREQUENT Cron Trigger (index.ts's
// METRICS_CRON, same one mail_triage/metrics use), not the daily one: an unanswered
// gate fails closed at 24h (registry.ts's onTimeout:'fail'), so a once-a-day check
// could miss the whole window between the gate opening and its timeout.
//
// SAFETY (fail-closed): ASK_GATE_REMINDER_ENABLED unset ⇒ total no-op (dormant) — reads
// nothing, writes nothing. Armed, it only READS `run action:list`'s existing index +
// `describeOp`'s static prompt text, and WRITES a vault append (Daily note) describing
// what's pending and the exact `run {action:'answer', ...}` call to unblock it — nothing
// here ever answers a gate itself. ASK_GATE_REMINDER_EMAIL additionally mails the same
// digest to the vault owner's own primary address (mirrors _agenda's two-stage gate);
// still no third-party send, no action taken on the caller's behalf.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { errMsg, vaultToday } from "./_util";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The reminder sweep may run at all. Unset → dormant (no-op). */
export const hasAskGateReminder = (env: RtEnv): boolean => flagOn(env.ASK_GATE_REMINDER_ENABLED);

/** The digest may additionally be MAILED to the vault owner's own address. Requires
 *  ASK_GATE_REMINDER_ENABLED too — fail-closed two-stage gate, mirrors _agenda's
 *  AGENDA_ENABLED/AGENDA_EMAIL pair. */
export const hasAskGateReminderEmail = (env: RtEnv): boolean => hasAskGateReminder(env) && flagOn(env.ASK_GATE_REMINDER_EMAIL);

const numOr = (v: unknown, dflt: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
};

// How old (since the run STARTED — the closest proxy available for "since it began
// waiting", since an op tree classifies/prepares before reaching its one `ask`) before a
// paused instance is worth mentioning at all. Default 30min: long enough that a gate
// answered promptly never generates noise.
const afterMinutes = (env: RtEnv): number => numOr(env.ASK_GATE_REMINDER_AFTER_MINUTES, 30);

// Minimum gap between repeat reminders for the SAME instance, so a gate stuck for hours
// doesn't re-mail every 5-minute tick. Default 6h — a handful of nudges across the 24h
// fail-closed window, not a flood.
const cooldownMinutes = (env: RtEnv): number => numOr(env.ASK_GATE_REMINDER_COOLDOWN_MINUTES, 360);

export type AskGate = { prompt: string; timeout: string; onTimeout: string };
export type PendingGate = { instanceId: string; opId: string; startedAt: number; age_ms: number; asks: AskGate[] };

export type AskGateReminderDeps = {
	/** `run action:list`'s live entries (instanceId, opId, startedAt, status). */
	listRuns: (env: RtEnv) => Promise<Array<{ instanceId: string; opId: string; startedAt: number; status: string }>>;
	/** `run action:describe`'s static ask-gate prompts for a registered op id. */
	describeGates: (opId: string) => AskGate[];
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
	/** Send the digest to the vault owner's own primary address. The one send this loop can do. */
	sendDigest: (env: RtEnv, subject: string, body: string) => Promise<void>;
};

export type AskGateReminderReport = {
	dormant?: boolean;
	checked?: number;
	pending?: number;
	reminded?: number;
	digest_written?: boolean;
	emailed?: boolean;
	note?: string;
	// Set only when the sweep soft-fails (caught internally); runSubJob reads this to flip
	// the heartbeat. Benign no-op states (dormant, nothing due) use `note`, never `error`.
	error?: string;
};

const humanAge = (ms: number): string => {
	const h = Math.floor(ms / 3_600_000);
	if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
};

/** Compose the reminder digest: one bullet per pending gate, its age, and the exact
 *  `run action:answer` call to approve/veto it — so a caller can act without going to
 *  read the op tree's source or already knowing its `ask` prompt text. */
export function composeReminder(pending: PendingGate[]): { subject: string; body: string } {
	const lines: string[] = [`${pending.length} durable run(s) waiting on your approval:`, ""];
	for (const p of pending) {
		lines.push(`- \`${p.opId}\` (${p.instanceId}), waiting ${humanAge(p.age_ms)}`);
		for (const a of p.asks) {
			lines.push(`  - approve: \`run {action:'answer', instanceId:'${p.instanceId}', prompt:'${a.prompt}', payload:{approved:true}}\``);
			lines.push(`  - veto: \`run {action:'answer', instanceId:'${p.instanceId}', prompt:'${a.prompt}', payload:{approved:false}}\` (fails closed — onTimeout:${a.onTimeout} after ${a.timeout})`);
		}
	}
	lines.push("", "(check `run {action:'status', instanceId}` for the live state)");
	return { subject: `sux · ${pending.length} approval${pending.length === 1 ? "" : "s"} waiting`, body: lines.join("\n") };
}

function buildDigestBlock(pending: PendingGate[], emailed: boolean, d: { subject: string; body: string }): string {
	return `\n## Pending approvals — ${new Date().toISOString()}\n_${pending.length} durable run(s) waiting · ${emailed ? "digest emailed" : "digest (vault only)"}_\n\n${d.body.trim()}\n`;
}

/** Run one reminder sweep. Fail-closed: dormant no-op unless ASK_GATE_REMINDER_ENABLED.
 *  Finds `run`-tracked instances whose live status is "waiting" (durable.ts's `ask`
 *  parks on step.waitForEvent — the only wait this repo's op trees currently use) and
 *  old enough (afterMinutes), fetches each op's static ask-gate prompts, and — for the
 *  ones not already reminded within cooldownMinutes (a per-instance ledger) — appends a
 *  digest to the Daily note (and mails it, when armed). Rides the frequent cron so a
 *  gate surfaces well before its 24h fail-closed timeout, not just once a day. */
export async function runAskGateReminder(env: RtEnv, deps: AskGateReminderDeps): Promise<AskGateReminderReport> {
	if (!hasAskGateReminder(env)) {
		return {
			dormant: true,
			note: "ask_gate_reminder is disabled — set ASK_GATE_REMINDER_ENABLED to proactively surface durable `run` instances paused on a human `ask` gate (vault append; also mail to yourself with ASK_GATE_REMINDER_EMAIL). Fail-closed: nothing runs until the flag is set. Never answers a gate itself.",
		};
	}

	let runs: Array<{ instanceId: string; opId: string; startedAt: number; status: string }>;
	try {
		runs = await deps.listRuns(env);
	} catch (e) {
		return { error: `run list failed: ${errMsg(e)}` };
	}

	const now = Date.now();
	const afterMs = afterMinutes(env) * 60_000;
	// "waiting" is the Workflow status durable.ts's `ask` parks on (step.waitForEvent) —
	// the only wait shape any op tree here currently has (no step.sleep in use).
	const waiting = runs.filter((r) => r.status === "waiting" && now - r.startedAt >= afterMs);
	const pending: PendingGate[] = waiting.map((r) => ({ instanceId: r.instanceId, opId: r.opId, startedAt: r.startedAt, age_ms: now - r.startedAt, asks: deps.describeGates(r.opId) }));

	// Per-instance cooldown ledger: only the gates not already reminded within the
	// window get included in THIS tick's digest, so a long-stuck gate nudges every few
	// hours instead of every 5-minute tick. Checked (not marked) here — marking happens
	// only after the digest append succeeds, so a failed write doesn't suppress the
	// instance for the whole cooldown window (see #725: mark-before-confirm silently
	// swallowed the reminder on a transient vault-append failure).
	const led = ledger(env, "ask_gate_reminder", cooldownMinutes(env) * 60);
	const due: PendingGate[] = [];
	for (const p of pending) if (!(await led.seen(p.instanceId))) due.push(p);

	if (!due.length) return { checked: runs.length, pending: pending.length, reminded: 0 };

	const digest = composeReminder(due);

	// Attempt the send BEFORE the vault append so the append's "digest emailed" text
	// reflects the true outcome, not the config flag — a send failure here must still
	// never fail the sweep (the vault digest lands regardless), so it's caught, not thrown.
	let emailed = false;
	if (hasAskGateReminderEmail(env)) {
		try {
			await deps.sendDigest(env, digest.subject, digest.body);
			emailed = true;
		} catch {
			// An email failure must never fail the sweep — the vault digest still lands below.
		}
	}

	try {
		await deps.digestAppend(env, `Daily/${vaultToday(env.VAULT_TZ)}.md`, buildDigestBlock(due, emailed, digest));
	} catch (e) {
		return { checked: runs.length, pending: pending.length, reminded: due.length, digest_written: false, emailed, error: `vault append failed: ${errMsg(e)}` };
	}
	for (const p of due) await led.mark(p.instanceId);

	return { checked: runs.length, pending: pending.length, reminded: due.length, digest_written: true, emailed };
}

/** Production surface: run.ts's listDurableRuns + describeOp, the git-backed vault
 *  append, and a self-addressed mail_send for the digest. Dynamically imported so the
 *  cron path pulls these in only when armed (mirrors _agenda/_weekly_recall). */
export async function defaultDeps(): Promise<AskGateReminderDeps> {
	const runFns = await import("./run");
	const { obsidian } = await import("./obsidian");
	const mail = await import("../mail-mcp");
	const tool = (name: string) => mail.MAIL_TOOLS.find((t) => t.name === name);
	return {
		listRuns: (env) => runFns.listDurableRuns(env),
		describeGates: (opId) => {
			try {
				return runFns.describeOp(opId).asks;
			} catch {
				return [];
			}
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
		sendDigest: async (env, subject, body) => {
			// Resolve the vault owner's own primary identity and send the digest to
			// themself — force:true skips the stage gate (this loop is the deliberate,
			// armed sender); it is the ONE send here and it is self-addressed, mirroring
			// _agenda's sendDigest.
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
	};
}
