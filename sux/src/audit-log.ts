import { cappedKvLog } from "./fns/_capped_kv_log";
import { type RtEnv } from "./registry";

// The forensic audit log — an append-only, KV-backed record of every side-effecting
// action sux actually committed (send/delete/move/put), distinct from ledger.ts's
// TTL'd idempotency dedup store (ledger.ts answers "have I already done X"; this
// answers "what did sux actually do"). Hooked at stage.ts's staged() chokepoint —
// the one place every gated mutate() call runs through — so nearly every
// STAGE_KINDS-annotated action is captured without touching each leaf fn. Uses the
// same capped, gzip-compressed single-key JSON log idiom as _mail_triage_log.ts /
// _feedback.ts rather than inventing a new store; cappedKvLog already serializes
// concurrent appends per key, so no extra locking is needed here.

export type AuditEntry = {
	kind: string;
	at: number;
	/** The human-legible preview object the action was staged/run with (already redacted by
	 *  each call site — e.g. mail_send's preview carries body_chars, never the raw body). */
	preview: unknown;
	/** The mutate() result, when it resolved to something — often carries the undo coordinates
	 *  a future reader needs (a message id, a submissionId, a git sha). */
	result?: unknown;
};

const KEY = "sux:audit:log";
const CAP = 2000;

const log = (env: RtEnv) => cappedKvLog<AuditEntry>(env, KEY, CAP);

/** Record one committed side-effecting action. Best-effort and never throws — a logging
 *  failure (no KV binding, a transient KV error) must never surface as though the actual
 *  action failed, since this always runs AFTER the real mutation already succeeded. */
export async function recordAudit(env: RtEnv, kind: string, preview: unknown, result?: unknown): Promise<void> {
	if (!env.OAUTH_KV) return;
	try {
		await log(env).push({ kind, at: Date.now(), preview, ...(result !== undefined ? { result } : {}) });
	} catch {
		// best-effort — see doc comment above.
	}
}

/** Read logged entries, newest-first, optionally filtered by kind and/or a since (ms epoch) floor. */
export async function readAuditEntries(env: RtEnv, opts?: { kind?: string; since?: number; limit?: number }): Promise<AuditEntry[]> {
	let items = await log(env).load();
	if (opts?.kind) items = items.filter((i) => i.kind === opts.kind);
	if (opts?.since !== undefined) items = items.filter((i) => i.at >= opts.since!);
	return items.slice(0, Math.max(0, opts?.limit ?? 100));
}
