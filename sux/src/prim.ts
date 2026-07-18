// Leaf-level primitives with zero project imports — safe for both proxy.ts and
// fns/_util.ts to depend on without forming a module cycle (#620). Keep this
// dependency-free; anything that needs RtEnv/registry/other project types
// belongs in fns/_util.ts instead.

/** An Error/thrown value → its message string (the `catch (e)` idiom every fn shares). */
export const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Compact JSON for LLM-facing fn output — no pretty indentation (a model reads
 * the structure fine and pays for every whitespace token). The one serializer
 * every fn's text envelope goes through; browser-rendered surfaces (observability
 * /metrics,/logs,/feedback) stay pretty-printed and don't use this. */
export const oj = (x: unknown): string => JSON.stringify(x);

/** True for an absolute http(s) URL. */
export function isHttpUrl(u: unknown): u is string {
	return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Same test as isHttpUrl, for a caller whose value is already typed `string` —
 *  isHttpUrl's `u is string` guard narrows an already-`string` input to `never`
 *  in the else branch, so a call site with a pre-narrowed string (e.g. after a
 *  `.trim()`) should use this instead of reaching for a `String(x)` escape hatch. */
export function isHttpUrlStr(s: string): boolean {
	return /^https?:\/\//i.test(s);
}

/** Shared cap: index.ts's checkArgs rejects tools/call args nested deeper than
 *  this, and rate-limit.ts's weightedRateLimit rejects the same payloads before
 *  pricing them (#626) — one source of truth for both gates. */
export const MAX_ARG_DEPTH = 64;

/** Bounded depth probe: true if `v`'s object nesting exceeds `limit`. Recursion is
 *  capped at `limit`, so a pathologically deep (or cyclic) blob can't blow the
 *  stack while measuring it. Lives here (not index.ts) so rate-limit.ts can reuse
 *  it without importing index.ts and forming a cycle. */
export function exceedsDepth(v: unknown, limit: number): boolean {
	let deep = false;
	const walk = (node: unknown, d: number): void => {
		if (deep) return;
		if (d > limit) {
			deep = true;
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const val of Object.values(node as Record<string, unknown>)) walk(val, d + 1);
	};
	walk(v, 0);
	return deep;
}
