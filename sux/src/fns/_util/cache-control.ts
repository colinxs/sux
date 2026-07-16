// noCache mutators shared by transport fns. Split out of fns/_util.ts (#565) —
// re-exported from there, so existing `from "./_util"` imports are unaffected.

/**
 * Transport fns (proxy/protocol/scrape/batch_fetch) faithfully return
 * error pages too — the raw response IS their content — but a transient
 * 403/429/consent wall must never enter the KV cache, or it poisons repeat
 * calls for an hour. Content-consuming fns instead fail() on >= 400 (see
 * fetchTextOk).
 */
export function noCacheOn4xx<T extends { noCache?: boolean }>(result: T, status: number): T {
	if (status >= 400) result.noCache = true;
	return result;
}

/**
 * Transport fns (proxy/scrape/batch_fetch) accept an arbitrary method, but their
 * results are content-addressed by args and cached for the fn TTL. A non-idempotent
 * request (POST/PUT/PATCH/DELETE/…) must never be memoized: caching it both serves
 * a stale response for a repeat mutation and silently skips re-executing the side
 * effect. Only GET/HEAD are safe to cache; mark everything else noCache.
 */
export function noCacheOnMutation<T extends { noCache?: boolean }>(result: T, method: unknown): T {
	const m = String(method ?? "GET").toUpperCase();
	if (m !== "GET" && m !== "HEAD") result.noCache = true;
	return result;
}
