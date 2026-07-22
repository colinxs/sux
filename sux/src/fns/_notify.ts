// notify — the ONE push-to-Colin escalation primitive (#1367): a tiny fire-and-forget POST to
// an ntfy (https://ntfy.sh or self-hosted) topic, for the handful of cases that genuinely need
// to reach him faster than a digest he might not open for hours (agenda's "needs you today"
// drops, a fabric-health escalation, an "announce" path like mychart's). Distinct from
// _webpush.ts's notify() (VAPID Web Push to a REGISTERED browser/PWA subscription, RFC
// 8291-encrypted, requires Colin to have opted a device in first via webpush.ts's subscribe) —
// this is the simpler KISS channel the issue asks for: no subscription step, just an
// env-configured topic a phone app (ntfy) is already watching. The two are complementary, not
// redundant; a call site picks whichever fits (or both).
//
// The fabric-health escalation PREDICATE (deciding whether a health signal is bad enough to
// page) lives in SuxOS/.github as its own issue — this module is only the worker-side send
// primitive + its call sites here.
//
// Env-gated + fail-open, same shape as every other optional integration in this repo
// (lunchmoney/dropbox/mychart): NTFY_URL absent ⇒ every call below is a silent no-op, never an
// error. NTFY_URL is the full topic URL (e.g. "https://ntfy.sh/colin-sux" or a self-hosted
// "https://ntfy.example.com/colin-sux"); NTFY_TOKEN is optional bearer auth for a
// access-controlled topic. Colin provisions both via `wrangler secret put`.
//
// KISS per the issue: one POST, no retry queue, no batching, no delivery tracking. A call site
// fires it via ctx.waitUntil (env._egress?.ctx, proxy.ts's EgressContext — the ingest.ts
// backgroundAssimilate precedent) so it never blocks the caller's own response, and notify()
// itself never throws — a notification must never be able to fail the work that triggered it.
import type { RtEnv } from "../registry";

export type NotifyPriority = "min" | "low" | "default" | "high" | "urgent";

/** NTFY_URL configured ⇒ armed; absent ⇒ every send below no-ops, like lunchmoney/dropbox/mychart. */
export function hasNotify(env: RtEnv): boolean {
	return Boolean(env.NTFY_URL);
}

// ntfy reads the notification title/priority from HTTP headers — strip any embedded CR/LF so a
// title built from caller-supplied text (a mail subject, a drop title) can't inject a header.
const headerSafe = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

/** POST one push notification to the configured ntfy topic. Best-effort/no-throw: an absent
 *  NTFY_URL, a network error, or a non-2xx response all resolve to `false`, never an exception.
 *  `topic` tags WHICH internal source is escalating (folded into the title, since ntfy's actual
 *  topic is already fixed by NTFY_URL) — so one shared NTFY_URL can carry pushes from several
 *  call sites (agenda, a fabric-health escalation, mychart) while staying distinguishable. */
export async function notify(env: RtEnv, topic: string, title: string, body: string, priority: NotifyPriority = "default"): Promise<boolean> {
	if (!hasNotify(env)) return false;
	try {
		const headers: Record<string, string> = {
			Title: headerSafe(`${topic ? `[${topic}] ` : ""}${title}`).slice(0, 200),
			Priority: priority,
		};
		if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
		const res = await fetch(env.NTFY_URL!, { method: "POST", headers, body: String(body ?? "").slice(0, 4_000) });
		return res.ok;
	} catch {
		return false;
	}
}
