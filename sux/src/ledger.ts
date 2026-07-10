import { type RtEnv } from "./registry";

// A tiny idempotency ledger over OAUTH_KV: "have I already done X?" so batch sweeps
// converge on re-run instead of re-doing work. Namespaced, TTL'd. markIfNew is the
// gate — true the FIRST time an id is seen (and it records it), false thereafter.
// NOT atomic (Cloudflare KV has no compare-and-set): the small race is acceptable for
// idempotency — worst case is a rare double-process, which a well-formed sweep already
// tolerates. With no KV binding it degrades to "always new" (can't dedupe, never throws).

const PREFIX = "sux:ledger:";
const keyOf = (ns: string, id: string) => `${PREFIX}${ns}:${id}`;

export type Ledger = {
	/** Has this id been recorded in this namespace? */
	seen: (id: string) => Promise<boolean>;
	/** Record this id (TTL'd). */
	mark: (id: string, value?: string) => Promise<void>;
	/** Record iff new — returns true the first time (and records), false if already seen. */
	markIfNew: (id: string, value?: string) => Promise<boolean>;
};

/** Open a namespaced idempotency ledger. ttlSeconds (default 30d) auto-expires entries; clamped to KV's 60s floor. */
export function ledger(env: RtEnv, ns: string, ttlSeconds = 30 * 24 * 3600): Ledger {
	const kv = env.OAUTH_KV;
	const ttl = { expirationTtl: Math.max(60, ttlSeconds) };
	return {
		async seen(id) {
			return Boolean(await kv?.get(keyOf(ns, id)));
		},
		async mark(id, value = "1") {
			await kv?.put(keyOf(ns, id), value, ttl);
		},
		async markIfNew(id, value = "1") {
			if (await kv?.get(keyOf(ns, id))) return false;
			await kv?.put(keyOf(ns, id), value, ttl);
			return true;
		},
	};
}

/** A short content fingerprint (first 8 bytes of SHA-256, hex) for idempotency keys — bounded, collision-safe enough within a namespace. */
export async function fingerprint(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
