import { recordAnalyticsEvent } from "./analytics";
import { type RtEnv } from "./registry";

// Per-subsystem heartbeats for the daily cron. After each unattended sub-job
// (Kroger refresh, mail triage, adblock rebuild, self-improve) we stamp
// {ok,at,error?} into KV so gatherHealth can surface last-success + staleness on
// the public status page. Without this a failure lands only in `wrangler tail`
// (console.warn ships nowhere), where a silently-stalled autonomous loop — mail
// triage, self-improve — can go unnoticed for weeks. Observability only: it never
// changes a sub-job's behavior, and a KV write failure must never turn a working
// tick into a thrown error.

const PREFIX = "sux:cron:heartbeat:";

// The daily cron fires once every 24h, so a heartbeat older than ~26h (a day plus
// jitter/retry slack) means the sub-job stopped running — flagged as `stale`.
export const CRON_STALE_MS = 26 * 60 * 60 * 1000;

// Every named sub-job the daily cron runs, in tick order. gatherHealth reports one
// entry per name; a name that has never fired reports { seen: false }.
export const CRON_JOBS = ["kroger_token", "mychart_token", "mychart_pull", "mail_triage", "mail_triage_plan", "vault_consolidate_plan", "contact_consolidate_plan", "files_consolidate_plan", "mychart_reconcile_plan", "vault_cross_link_plan", "ask_gate_reminder", "agenda_reply", "agenda_ask", "imessage_reply", "vectorize_backfill", "weekly_recall", "consolidate", "watch_sweep", "cross_semantic", "briefing", "agenda", "adblock", "life_wiki", "infer_nudge", "self_improve", "web_search_selftest", "learning_folder", "gh_actions_billing", "dropbox_ingest"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export type Heartbeat = { ok: boolean; at: number; error?: string };

/** Coerce any thrown or reported error value into a NON-EMPTY string (#1480).
 *
 * Every caller here has the same requirement — a red heartbeat must carry text a human can
 * act on — and every caller previously got it slightly wrong in a different way. The two
 * live holes this closes:
 *   • `String((e as Error)?.message ?? e)` yields "" for `new Error("")`, because "" is not
 *     nullish so `??` never falls through to `e`. recordHeartbeat's `if (error)` then drops
 *     it, producing the ok=false-with-no-error beat observed in prod for mail_triage.
 *   • A report carrying `error` as an Error/object (not a string) fell through the old
 *     string-only check and was recorded as ok=TRUE — a failure logged as a success.
 * Falsy inputs are the caller's business (they mean "no error"); this only runs once the
 * caller has decided an error exists, so an empty result here is always a bug to name, not
 * a state to pass through. */
function errorText(value: unknown, fallback: string): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (value instanceof Error) {
		if (typeof value.message === "string" && value.message.length > 0) return value.message;
		// An Error with no message still tells us its constructor — strictly better than nothing.
		return value.name ? `${value.name} (no message)` : fallback;
	}
	if (value && typeof value === "object") {
		try {
			const json = JSON.stringify(value);
			if (json && json !== "{}") return json;
		} catch {
			// circular / non-serializable — fall through to the fallback
		}
		return fallback;
	}
	const s = String(value);
	return s.length > 0 ? s : fallback;
}

/** Stamp a sub-job's outcome. Best-effort: swallows KV errors so it can't fail the tick.
 *
 * Enforces the invariant `ok === false` implies `error` is present (#1480). Callers are
 * expected to supply the text, but the guarantee lives HERE rather than in each caller so a
 * future call site cannot silently reintroduce an undiagnosable red beat. */
export async function recordHeartbeat(env: RtEnv, name: CronJob, ok: boolean, error?: string): Promise<void> {
	try {
		const beat: Heartbeat = { ok, at: Date.now() };
		if (error) beat.error = error.slice(0, 300);
		else if (!ok) beat.error = "failed with no error text recorded";
		await env.OAUTH_KV?.put(PREFIX + name, JSON.stringify(beat));
		// Queryable analytics (#220): "which cron sub-job fails most often" over time,
		// not just the latest scalar heartbeat this KV key holds.
		recordAnalyticsEvent(env, "cron_heartbeat", { blobs: [name, ok ? "ok" : "fail", beat.error ?? null], doubles: [ok ? 1 : 0] });
	} catch {
		// heartbeat is observability-only; never let it fail the tick.
	}
}

/** A tick's soft-failure signal: the tick functions deliberately catch their own internal
 * failures and RETURN a report instead of throwing (so one bad message/step doesn't sink the
 * whole cycle), surfacing the failure as a top-level `error` string on that report (e.g.
 * self-improve's tick, or a vault-append that threw). A thrown exception is the hard-failure
 * path; this is the soft one — both must flip the heartbeat, or a job whose visible output has
 * been silently broken for weeks still reports ok. Returns the error text if the resolved report
 * carries one, else undefined. Benign no-op states (dormant/skipped/dry-run) use `note`, never
 * `error`, so they stay healthy. */
export function subJobError(report: unknown): string | undefined {
	if (report && typeof report === "object") {
		const err = (report as { error?: unknown }).error;
		// Falsy (absent/null/false/""/0) is the benign "no error" case and must stay ok=true.
		// Anything truthy is a failure regardless of its TYPE — an Error or a structured
		// object used to slip through the old string-only check and be recorded as ok=true.
		if (err) return errorText(err, "sub-job reported a non-descriptive error");
	}
	return undefined;
}

/** Run one named sub-job, record its heartbeat, and swallow failures so a single bad
 * sub-job neither throws nor blocks the rest of the tick (mirrors the prior per-job
 * try/catch, now with a persisted outcome instead of only a console.warn). A thrown
 * exception AND a soft failure the tick reports via `error` on its resolved report both
 * stamp ok=false. */
export async function runSubJob(env: RtEnv, name: CronJob, fn: () => Promise<unknown>): Promise<void> {
	try {
		const report = await fn();
		const soft = subJobError(report);
		if (soft) {
			console.warn(`sux scheduled ${name} reported a failure: ${soft}`);
			await recordHeartbeat(env, name, false, soft);
		} else {
			await recordHeartbeat(env, name, true);
		}
	} catch (e) {
		const msg = errorText(e, `${name} threw a non-descriptive error`);
		console.warn(`sux scheduled ${name} skipped: ${msg}`);
		await recordHeartbeat(env, name, false, msg);
	}
}

type KVLike = { get(key: string): Promise<string | null> };
type ListableKVLike = KVLike & { list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }> };

// Local `watch` scheduled tasks (deterministic check.sh probes) are namespaced
// separately from CRON_JOBS above — an open-ended set of names, not a fixed const
// list, so heartbeats are looked up by KV `list()` over the prefix rather than a
// known-names map (#1414). Default staleAfter mirrors CRON_STALE_MS; a poster may
// override it per name (its own cadence).
const WATCH_PREFIX = "sux:watch:heartbeat:";
export const WATCH_STALE_MS_DEFAULT = CRON_STALE_MS;

export type WatchHeartbeat = { ok: boolean; at: number; error?: string; staleAfterMs?: number };

/** Stamp a named watch's outcome. Best-effort, same posture as recordHeartbeat: a KV
 * write failure never throws — the ingest route's caller must never see its pass fail
 * just because observability couldn't persist. */
export async function recordWatchHeartbeat(env: RtEnv, name: string, ok: boolean, error?: string, staleAfterMs?: number): Promise<void> {
	try {
		const beat: WatchHeartbeat = { ok, at: Date.now() };
		if (error) beat.error = error.slice(0, 300);
		else if (!ok) beat.error = "failed with no error text recorded";
		if (staleAfterMs && staleAfterMs > 0) beat.staleAfterMs = staleAfterMs;
		await env.OAUTH_KV?.put(WATCH_PREFIX + name, JSON.stringify(beat));
	} catch {
		// heartbeat is observability-only; never let it fail the poster's pass.
	}
}

/** Read every posted watch heartbeat and derive its staleness at `now`, per-watch
 * cadence honored via each beat's own `staleAfterMs` (falls back to the cron default).
 * Mirrors readHeartbeats' never-throws contract; an empty/failed list degrades to {}. */
export async function readWatchHeartbeats(kv: ListableKVLike | undefined, now = Date.now()): Promise<Record<string, unknown>> {
	if (!kv) return {};
	try {
		const { keys } = await kv.list({ prefix: WATCH_PREFIX });
		const entries = await Promise.all(
			keys.map(async ({ name: key }) => {
				const name = key.slice(WATCH_PREFIX.length);
				try {
					const raw = await kv.get(key);
					const beat = raw ? (JSON.parse(raw) as Partial<WatchHeartbeat>) : null;
					if (!beat || typeof beat.at !== "number") return [name, { seen: false }] as const;
					const age_ms = now - beat.at;
					const staleAfterMs = beat.staleAfterMs ?? WATCH_STALE_MS_DEFAULT;
					return [
						name,
						{ seen: true, ok: Boolean(beat.ok), at: beat.at, age_ms, stale: age_ms > staleAfterMs, ...(beat.error ? { error: beat.error } : {}) },
					] as const;
				} catch {
					return [name, { seen: false }] as const;
				}
			}),
		);
		return Object.fromEntries(entries);
	} catch {
		return {};
	}
}

/** Read every sub-job heartbeat and derive its staleness at `now`. Pure over a
 * KV-like reader so it's testable; a missing/unparseable beat degrades to
 * { seen: false } and never throws. */
export async function readHeartbeats(kv: KVLike | undefined, now = Date.now()): Promise<Record<string, unknown>> {
	const entries = await Promise.all(
		CRON_JOBS.map(async (name) => {
			let beat: Partial<Heartbeat> | null = null;
			try {
				const raw = await kv?.get(PREFIX + name);
				if (raw) beat = JSON.parse(raw) as Partial<Heartbeat>;
			} catch {
				beat = null;
			}
			if (!beat || typeof beat.at !== "number") return [name, { seen: false }] as const;
			const age_ms = now - beat.at;
			return [
				name,
				{
					seen: true,
					ok: Boolean(beat.ok),
					at: beat.at,
					age_ms,
					stale: age_ms > CRON_STALE_MS,
					...(beat.error ? { error: beat.error } : {}),
				},
			] as const;
		}),
	);
	return Object.fromEntries(entries);
}
