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
