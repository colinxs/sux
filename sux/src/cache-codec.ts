// Transparent compression for KV cache payloads (PLAN F1 Tier-A). Cache values
// are JSON text (search/scrape/readability results, etc.) — highly compressible.
// Storing them compressed cuts KV storage + read egress and dodges the 25 MB KV
// value ceiling for large pages. Fully transparent: index.ts compresses on write
// and decompresses on read; the cached result is byte-identical.
//
// Codec preference: zstd (fast, excellent text ratio) → brotli. zstd is runtime-
// gated (Node ≥22.15 / newer workerd) — the same detection `compress` uses — so
// we fall back to brotli, which nodejs_compat always provides. gzip is the final
// safety net. Each frame records the codec it used, so decode always matches the
// codec that encoded it WITHIN a runtime; a cross-runtime mismatch (e.g. a dev
// isolate with zstd writing an entry a prod isolate without zstd later reads)
// throws on decode, which the caller treats as a cache miss and recomputes.
import zlib from "node:zlib";

const Z = zlib as any;
const hasZstd = typeof Z.zstdCompressSync === "function";

// 4-byte magic "sxz1" + 1 codec byte prefixes a compressed frame. JSON cache
// values are objects/arrays/strings that never begin with 0x73 ('s'), so the
// magic unambiguously distinguishes a compressed frame from a legacy/plain-JSON
// value stored as text.
const MAGIC = [0x73, 0x78, 0x7a, 0x31];
const TAG_ZSTD = 0x7a; // 'z'
const TAG_BROTLI = 0x62; // 'b'
const TAG_GZIP = 0x67; // 'g'

// Below this, the 5-byte header + codec overhead isn't worth it.
const MIN_COMPRESS = 512;

function compressBytes(input: Uint8Array): { tag: number; out: Uint8Array } {
	if (hasZstd) return { tag: TAG_ZSTD, out: Z.zstdCompressSync(input, { params: { [Z.constants.ZSTD_c_compressionLevel]: 10 } }) };
	return { tag: TAG_BROTLI, out: Z.brotliCompressSync(input, { params: { [Z.constants.BROTLI_PARAM_QUALITY]: 6 } }) };
}

// Decompression-bomb guard: a crafted/corrupted KV entry could carry a tiny
// compressed payload that inflates to gigabytes, OOMing the isolate before
// unpackFromCache's throw can fall through to a cache-miss recompute (see
// index.ts). Matches compress.ts's MAX_DECOMPRESS_BYTES — same node:zlib sync
// API family, so the same `maxOutputLength` option applies to every codec here.
const MAX_DECOMPRESS_BYTES = 32 * 1024 * 1024;

function decompressByTag(tag: number, payload: Uint8Array): Uint8Array {
	const opts = { maxOutputLength: MAX_DECOMPRESS_BYTES };
	if (tag === TAG_ZSTD) return Z.zstdDecompressSync(payload, opts);
	if (tag === TAG_BROTLI) return Z.brotliDecompressSync(payload, opts);
	if (tag === TAG_GZIP) return Z.gunzipSync(payload, opts);
	throw new Error(`unknown cache codec tag ${tag}`);
}

/**
 * Compress a JSON cache string to a tagged byte frame. Returns the plain string
 * unchanged for small payloads (not worth the header), when compression doesn't
 * actually shrink the data, or if compression throws — so callers can always
 * store the return value directly (string or bytes) in KV.
 */
export function packForCache(json: string): Uint8Array | string {
	const input = new TextEncoder().encode(json);
	if (input.length < MIN_COMPRESS) return json;
	try {
		const { tag, out } = compressBytes(input);
		if (out.length + MAGIC.length + 1 >= input.length) return json; // no win
		const framed = new Uint8Array(MAGIC.length + 1 + out.length);
		framed.set(MAGIC, 0);
		framed[MAGIC.length] = tag;
		framed.set(out, MAGIC.length + 1);
		return framed;
	} catch {
		return json;
	}
}

/**
 * Reverse packForCache. Accepts what KV `get` returns: an ArrayBuffer/Uint8Array
 * (real binding, read with type "arrayBuffer") or a plain string (a legacy/plain
 * JSON entry, or a test fake). A framed value is decompressed; anything else is
 * decoded/returned as the original JSON text. Throws only on a corrupt/unknown
 * frame — the caller treats that as a cache miss.
 */
export function unpackFromCache(raw: ArrayBuffer | ArrayBufferView | string): string {
	if (typeof raw === "string") return raw;
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
	if (bytes.length >= MAGIC.length + 1 && MAGIC.every((b, i) => bytes[i] === b)) {
		return new TextDecoder().decode(decompressByTag(bytes[MAGIC.length], bytes.subarray(MAGIC.length + 1)));
	}
	return new TextDecoder().decode(bytes);
}
