// Shared JSON-parse-with-fallback helper. Split out of fns/_util.ts (#565) —
// re-exported from there, so existing `from "./_util"` imports are unaffected.

/**
 * Parse `raw` as JSON, returning `fallback` for a null/undefined/empty input OR a
 * parse failure — the common shape for a KV-cache read, an OAuth state blob, or any
 * other "best-effort parse, degrade gracefully" call site that used to hand-roll its
 * own `try { JSON.parse(...) } catch { ...fallback... }` (#564). Not a fit for a call
 * site that needs to distinguish "missing" from "malformed" or that should propagate
 * the parse error — those still want their own try/catch.
 */
export function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * Resolve a dotted path (`"a.b.c"`) against an already-parsed value — best-effort,
 * `undefined` on a miss or a non-object hop. The one path-digging implementation
 * shared by pipe.ts's `{{prev.path}}` and batch.ts's `{{item.path}}`/`{{items.path}}`
 * token substitution (was duplicated verbatim in both — #391).
 */
export function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as any)[k] : undefined), value);
}
