// In-isolate request coalescing (cache-stampede protection). On a cache miss,
// N concurrent identical tool calls would each run fn.run — N Kagi extracts, N
// Browser-Rendering sessions, N SerpAPI hits — before the first deferred cache
// write lands. Those are the literal-dollar tools. Coalescing collapses same-key
// concurrent runs in the SAME isolate to a single in-flight execution; the
// followers await and share its result. Keyed by the content-addressed cache key,
// so only cacheable fns coalesce (identical args → identical key → identical
// result). Best-effort by design: it does not span isolates (that's the KV
// cache's job once the first result lands), it just kills the common burst.

/**
 * Run `thunk` under `key`, coalescing concurrent callers onto one execution.
 * The map entry is cleared when the promise settles (resolve OR reject), so the
 * next call re-runs. A rejection propagates to every awaiter (each handles it as
 * it would a solo failure); the internal cleanup never raises an unhandled
 * rejection.
 */
export function singleFlight<T>(inflight: Map<string, Promise<T>>, key: string, thunk: () => Promise<T>): Promise<T> {
	const existing = inflight.get(key);
	if (existing) return existing;
	const p = thunk();
	inflight.set(key, p);
	// Clear on settle; swallow this cleanup chain's copy of any rejection (the
	// awaiters of `p` still receive it — `p` is returned unwrapped).
	p.finally(() => {
		if (inflight.get(key) === p) inflight.delete(key);
	}).catch(() => {});
	return p;
}
