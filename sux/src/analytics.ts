import type { RtEnv } from "./registry";

// Best-effort event recorder riding Workers Analytics Engine (#220) — durable,
// SQL-queryable analytics without a separately-provisioned resource (see
// wrangler.jsonc's analytics_engine_datasets comment for why AE over Pipelines).
// Observability only: an absent binding or a write failure must never affect the
// caller's own outcome, so this never throws and returns nothing to await.
//
// `series` is the event's first index (Analytics Engine only honors ONE index per
// data point) — query with e.g. `WHERE index1 = 'cron_heartbeat'`. `blobs` and
// `doubles` are the event's own fields, positional per call site.
export function recordAnalyticsEvent(env: RtEnv, series: string, opts: { blobs?: Array<string | null>; doubles?: number[] } = {}): void {
	try {
		env.ANALYTICS?.writeDataPoint({ indexes: [series], blobs: opts.blobs, doubles: opts.doubles });
	} catch {
		// analytics is observability-only; never let it affect the caller.
	}
}
