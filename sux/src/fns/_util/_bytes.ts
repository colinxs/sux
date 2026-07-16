// String/byte primitives shared across the function library — no deps beyond
// web-standard APIs. Split out of _util.ts (#565) so a change here can't carry
// incidental risk to fns that only need the fetch/store helpers, and vice versa.

/** An Error/thrown value → its message string (the `catch (e)` idiom every fn shares). */
export const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** True for an absolute http(s) URL. */
export function isHttpUrl(u: unknown): u is string {
	return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Compact JSON for LLM-facing fn output — no pretty indentation (a model reads
 * the structure fine and pays for every whitespace token). The one serializer
 * every fn's text envelope goes through; browser-rendered surfaces (observability
 * /metrics,/logs,/feedback) stay pretty-printed and don't use this. */
export const oj = (x: unknown): string => JSON.stringify(x);

/** Truncate a string, appending a length marker when it was cut. `maxChars` counts
 * UTF-16 code units (s.length/s.slice()), not bytes — multi-byte-heavy text can run
 * up to ~3x this figure in actual byte size. */
export function clamp(s: string, maxChars = 100_000): string {
	return s.length > maxChars ? `${s.slice(0, maxChars)}\n… [truncated at ${maxChars} chars]` : s;
}

/** Truncate a string to at most `maxBytes` of UTF-8, never splitting a multi-byte
 * character — for call sites where the bound is a genuine byte budget (e.g. a
 * vault write cap), where char-based `clamp` can run ~3x over on emoji/CJK-heavy
 * text. Encodes once, slices on the byte boundary, then decodes ignoring any
 * partial trailing sequence the slice may have cut. */
export function clampBytes(s: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.length <= maxBytes) return s;
	const decoded = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
	return `${decoded}\n… [truncated at ${maxBytes} bytes]`;
}

/** base64 of raw bytes (chunked so large inputs don't blow the call stack). */
export function toB64(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s);
}

/** raw bytes from a base64 string. */
export function fromB64(b64: string): Uint8Array {
	const bin = atob(b64.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
