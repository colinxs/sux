// In-isolate content-fetch dedup (substituter, PLAN Nix insight). Split out of
// _util.ts (#565) — self-contained (no deps on the rest of _util), so it can churn
// independently of the fetch/store/byte helpers that only happen to live nearby.
//
// A pipe/batch/multi-tool chain runs in ONE isolate within a short window and
// often fetches the same URL from several tools (scrape → extract → readability
// → metadata …). Cache the fetched text in memory keyed by url+maxBytes so the
// residential round-trip happens once per chain. Per-isolate + short-TTL: it
// adds no latency (memory only), needs no ctx/KV, and can't break the fetch path
// (all ops are pure and wrapped around — never through — the live fetch). The
// tool-result KV cache still handles cross-isolate/identical-call dedup; this
// closes the CROSS-TOOL same-URL gap the result cache (keyed by tool+args) can't.

export type FetchCacheEntry = { at: number; status: number; text: string; headers: Record<string, string>; url: string };
const FETCH_CACHE = new Map<string, FetchCacheEntry>();
export const FETCH_CACHE_TTL_MS = 30_000;
export const FETCH_CACHE_MAX_ENTRIES = 64;
export const FETCH_CACHE_MAX_TEXT = 512_000; // don't pin very large bodies in memory

// Disabled under vitest so the module-level cache can't leak fetched bodies
// between the many fns tests that mock the fetch and assert on it. A test can
// force it on/off via setFetchDedup to exercise the integration in isolation.
let dedupForced: boolean | null = null;
export const fetchDedupActive = (): boolean => dedupForced ?? !(typeof process !== "undefined" && process.env?.VITEST);

/** Test seam: force the fetch dedup on (true) / off (false) / default (null). */
export function setFetchDedup(on: boolean | null): void {
	dedupForced = on;
}

/** Fresh (non-expired) cache entry for `key`, or null. Evicts on expiry. */
export function fetchCacheGet(key: string, now: number): FetchCacheEntry | null {
	const e = FETCH_CACHE.get(key);
	if (!e) return null;
	if (now - e.at > FETCH_CACHE_TTL_MS) {
		FETCH_CACHE.delete(key);
		return null;
	}
	return e;
}

/** Insert an entry, evicting the oldest (Map insertion order) past the cap. */
export function fetchCacheSet(key: string, e: FetchCacheEntry): void {
	if (FETCH_CACHE.size >= FETCH_CACHE_MAX_ENTRIES && !FETCH_CACHE.has(key)) {
		const oldest = FETCH_CACHE.keys().next().value;
		if (oldest !== undefined) FETCH_CACHE.delete(oldest);
	}
	FETCH_CACHE.set(key, e);
}

/** Test seam: clear the per-isolate fetch cache. */
export function clearFetchCache(): void {
	FETCH_CACHE.clear();
}
