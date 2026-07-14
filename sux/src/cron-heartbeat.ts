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
export const CRON_JOBS = ["kroger_token", "mychart_token", "mail_triage", "weekly_recall", "briefing", "adblock", "self_improve"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export type Heartbeat = { ok: boolean; at: number; error?: string };

/** Stamp a sub-job's outcome. Best-effort: swallows KV errors so it can't fail the tick. */
export async function recordHeartbeat(env: RtEnv, name: CronJob, ok: boolean, error?: string): Promise<void> {
	try {
		const beat: Heartbeat = { ok, at: Date.now() };
		if (error) beat.error = error.slice(0, 300);
		await env.OAUTH_KV?.put(PREFIX + name, JSON.stringify(beat));
	} catch {
		// heartbeat is observability-only; never let it fail the tick.
	}
}

/** Run one named sub-job, record its heartbeat, and swallow failures so a single bad
 * sub-job neither throws nor blocks the rest of the tick (mirrors the prior per-job
 * try/catch, now with a persisted outcome instead of only a console.warn). */
export async function runSubJob(env: RtEnv, name: CronJob, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
		await recordHeartbeat(env, name, true);
	} catch (e) {
		const msg = String((e as Error)?.message ?? e);
		console.warn(`sux scheduled ${name} skipped: ${msg}`);
		await recordHeartbeat(env, name, false, msg);
	}
}

type KVLike = { get(key: string): Promise<string | null> };

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
