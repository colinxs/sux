// Per-domain fetch-ladder rung memory (#844, F-008). The ladder (proxy fetch →
// cf render → paid unlocker) re-pays every cheap-rung failure each time it hits
// a domain that only ever answers at a higher rung. This remembers which rung
// last WON for a domain in OAUTH_KV, so a caller can start there instead of the
// bottom — a pure latency/cost win, no change to terminal-failure semantics.
//
// Self-healing by design (never permanently pins a domain to an expensive
// rung): entries expire after RUNG_TTL_MS, and even a fresh entry is ignored a
// small fraction of the time (REPROBE_PROBABILITY) so a domain that's stopped
// needing its learned rung (site changed, or the escalation was a fluke) drifts
// back down on its own. Both failure modes of `learnedRung` (no KV bound, no
// entry, expired, ignored-for-reprobe) return null, which every caller treats
// as "start at the bottom" — fails toward the cheaper rung, never the reverse.

import type { RtEnv } from "../../registry";

export type Rung = "scrape" | "render" | "unlocker";
const RUNG_ORDER: Rung[] = ["scrape", "render", "unlocker"];

const KV_PREFIX = "rung:";
const RUNG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — bounds how long a pin can outlive its cause
const REPROBE_PROBABILITY = 0.1; // ignore a live entry this often to re-probe the cheaper rungs

function domainOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** The rung that last won for `url`'s domain, or null to start at the bottom
 * (no KV bound, nothing learned yet, the entry aged out, or this call landed
 * in the periodic re-probe fraction). */
export async function learnedRung(env: RtEnv, url: string): Promise<Rung | null> {
	const kv = env.OAUTH_KV;
	const domain = domainOf(url);
	if (!kv || !domain) return null;
	if (Math.random() < REPROBE_PROBABILITY) return null;
	const raw = await kv.get(KV_PREFIX + domain).catch(() => null);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { rung?: unknown; at?: unknown };
		const rung = parsed.rung as Rung;
		const at = Number(parsed.at);
		if (!RUNG_ORDER.includes(rung) || !Number.isFinite(at)) return null;
		if (Date.now() - at > RUNG_TTL_MS) return null;
		return rung;
	} catch {
		return null;
	}
}

/** Record that `rung` won the ladder for `url`'s domain just now. Best-effort —
 * swallows KV errors, since a failed write only costs the future latency win,
 * never correctness (the ladder still ran the leg that actually succeeded). */
export async function recordRung(env: RtEnv, url: string, rung: Rung): Promise<void> {
	const kv = env.OAUTH_KV;
	const domain = domainOf(url);
	if (!kv || !domain) return;
	const body = JSON.stringify({ rung, at: Date.now() });
	await kv.put(KV_PREFIX + domain, body, { expirationTtl: Math.ceil(RUNG_TTL_MS / 1000) }).catch(() => {});
}

/** Whether rung `a` is at or past rung `b` in the ladder — lets a caller ask
 * "should I skip straight past this rung?" without hand-rolling index math. */
export function rungAtLeast(a: Rung, b: Rung): boolean {
	return RUNG_ORDER.indexOf(a) >= RUNG_ORDER.indexOf(b);
}
