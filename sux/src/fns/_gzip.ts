// Transparent storage compression for text blobs. Native CompressionStream/
// DecompressionStream (WHATWG Compression Streams API) — zero-dependency, and
// present in both Workers (workerd) and Node ≥18 (so vitest exercises the real
// codec). Used by every persistent store (R2 CAS, user KV, Dropbox app-folder)
// to shrink text-ish payloads on write and inflate them back on read.
//
// Backward-compatibility is the whole design: a compressed blob is framed as a
// single MARKER byte followed by the raw gzip stream, and NOTHING else is
// touched. A read decompresses ONLY when it sees that exact frame prefix; every
// pre-existing (unmarked) object and every payload we chose not to compress is
// returned byte-for-byte unchanged. The marker also disambiguates OUR frames
// from a raw gzip file a user legitimately stored — we never auto-inflate the
// latter, because it lacks the marker byte in front of its 1f 8b magic.

// Frame = [GZIP_MARKER, 0x1f, 0x8b, ...gzip]. 0x00 as the marker is deliberate:
// UTF-8 text (the only thing we compress) never begins with a NUL, so a stored
// text/JSON payload can't accidentally look like a compression frame, and a raw
// gzip blob (starts 1f 8b, no leading NUL) is left alone.
export const GZIP_MARKER = 0x00;

// Below this, gzip's ~18-byte header + our marker make the output no smaller (or
// bigger) than the input — not worth the CPU or the round-trip complexity.
const MIN_COMPRESS_BYTES = 256;

// Decompression-bomb guard: a tiny marked frame could inflate to gigabytes and
// OOM the isolate. We only ever inflate our own frames, but a caller can hand us
// a hand-crafted stored blob (e.g. store put with base64 = marker+bomb), so cap
// the inflated output and abort past it.
const MAX_DECOMPRESS_BYTES = 64 * 1024 * 1024;

// Content types whose bytes are already compressed / entropy-dense — gzip only
// adds overhead. Matched case-insensitively against the MIME prefix.
const INCOMPRESSIBLE_CT =
	/^(image\/|audio\/|video\/|font\/|application\/(zip|gzip|x-gzip|x-bzip2?|x-7z-compressed|x-rar-compressed|x-xz|x-lzma|zstd|pdf|wasm|epub\+zip|x-apple-diskimage|vnd\.(openxmlformats|ms-excel|ms-powerpoint|rar)))/i;

/** Magic-byte sniff for already-compressed / media container formats, so a
 * mislabeled or octet-stream payload (pdf/png/jpg/zip/gzip/…) is still skipped. */
function looksCompressed(b: Uint8Array): boolean {
	if (b.length < 4) return false;
	const [a, c, d, e] = b;
	if (a === 0x1f && c === 0x8b) return true; // gzip
	if (a === 0x50 && c === 0x4b) return true; // zip / office / epub  (PK)
	if (a === 0x25 && c === 0x50 && d === 0x44 && e === 0x46) return true; // %PDF
	if (a === 0x89 && c === 0x50 && d === 0x4e && e === 0x47) return true; // PNG
	if (a === 0xff && c === 0xd8 && d === 0xff) return true; // JPEG
	if (a === 0x47 && c === 0x49 && d === 0x46) return true; // GIF
	if (a === 0x52 && c === 0x49 && d === 0x46 && e === 0x46) return true; // RIFF (webp/wav/avi)
	if (a === 0x42 && c === 0x5a && d === 0x68) return true; // bzip2 (BZh)
	if (a === 0x28 && c === 0xb5 && d === 0x2f && e === 0xfd) return true; // zstd
	if (a === 0xfd && c === 0x37 && d === 0x7a && e === 0x58) return true; // xz
	if (a === 0x37 && c === 0x7a && d === 0xbc && e === 0xaf) return true; // 7z
	return false;
}

/** True when `bytes` is a payload worth gzip-compressing (text-ish, big enough,
 * not already compressed). Errs toward NOT compressing — a false negative just
 * stores raw; a false positive on random bytes is caught later (kept only if the
 * result is actually smaller). */
export function shouldCompress(bytes: Uint8Array, contentType?: string): boolean {
	if (bytes.length < MIN_COMPRESS_BYTES) return false;
	if (contentType && INCOMPRESSIBLE_CT.test(contentType)) return false;
	if (looksCompressed(bytes)) return false;
	return true;
}

/** gzip `input` via native CompressionStream. Reads the output concurrently so a
 * large input can't deadlock on writer backpressure. */
async function gzip(input: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream("gzip");
	const out = new Response(cs.readable).arrayBuffer();
	const w = cs.writable.getWriter();
	await w.write(input);
	await w.close();
	return new Uint8Array(await out);
}

/** Inflate a gzip stream, aborting past MAX_DECOMPRESS_BYTES (bomb guard). */
async function gunzip(input: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream("gzip");
	const w = ds.writable.getWriter();
	// Feed the writer without awaiting (a large stream would block on backpressure
	// until the reader below pulls); a decode error surfaces via the READER loop, which
	// we handle. Swallow every writer-side rejection here — write(), close(), AND the
	// writer's own `closed` promise (all reject when the stream errors on corrupt input)
	// — so a bad frame never escapes as an UNHANDLED rejection.
	w.closed.catch(() => {});
	void w
		.write(input)
		.then(() => w.close())
		.catch(() => {});
	const reader = ds.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_DECOMPRESS_BYTES) {
			await reader.cancel().catch(() => {});
			throw new Error(`gzip: inflated output exceeds ${MAX_DECOMPRESS_BYTES}-byte cap (possible decompression bomb)`);
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		merged.set(c, off);
		off += c.byteLength;
	}
	return merged;
}

/** True when `stored` is one of OUR compression frames (marker + gzip magic). */
export function isCompressed(stored: Uint8Array): boolean {
	return stored.length >= 3 && stored[0] === GZIP_MARKER && stored[1] === 0x1f && stored[2] === 0x8b;
}

/**
 * The write half of transparent compression: given the raw bytes about to be
 * persisted, return the bytes to actually store. Compresses text-ish payloads
 * into a MARKER-prefixed gzip frame when that is genuinely smaller; otherwise
 * returns the input unchanged (raw, no marker). Never throws — a codec failure
 * degrades to storing raw.
 */
export async function maybeCompress(bytes: Uint8Array, contentType?: string): Promise<Uint8Array> {
	if (!shouldCompress(bytes, contentType)) return bytes;
	try {
		const gz = await gzip(bytes);
		if (gz.length + 1 >= bytes.length) return bytes; // no real win — store raw
		const framed = new Uint8Array(gz.length + 1);
		framed[0] = GZIP_MARKER;
		framed.set(gz, 1);
		return framed;
	} catch {
		return bytes;
	}
}

/**
 * The read half: given persisted bytes, return the original bytes. Inflates only
 * OUR marker-prefixed frames; anything else (legacy unmarked objects, raw
 * payloads, a user's own .gz) is returned unchanged. Throws only on a corrupt
 * frame or a decompression-bomb overflow — never on ordinary raw input.
 */
export async function maybeDecompress(stored: Uint8Array): Promise<Uint8Array> {
	if (!isCompressed(stored)) return stored;
	return gunzip(stored.subarray(1));
}

// --- KV string helpers: KV values are strings here, so a compressed frame is
// carried as a control-prefixed base64 string. Same marker discipline: the
// leading NUL a normal text value never has gates decompression. base64's 33%
// overhead is accepted because we only keep the compressed form when the encoded
// result is still shorter than the original string.

const KV_GZIP_PREFIX = "\u0000gz:";

function b64encode(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s);
}

function b64decode(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Compress a KV string value when worthwhile, returning either the original
 * string (unchanged, stored plain) or a control-prefixed base64 gzip frame. */
export async function maybeCompressString(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	if (!shouldCompress(bytes, "text/plain")) return value;
	try {
		const gz = await gzip(bytes);
		const encoded = KV_GZIP_PREFIX + b64encode(gz);
		return encoded.length < value.length ? encoded : value;
	} catch {
		return value;
	}
}

/** Inflate a KV string value produced by maybeCompressString; passes any plain
 * (unprefixed, legacy) value straight through. */
export async function maybeDecompressString(value: string): Promise<string> {
	if (!value.startsWith(KV_GZIP_PREFIX)) return value;
	const inflated = await gunzip(b64decode(value.slice(KV_GZIP_PREFIX.length)));
	return new TextDecoder().decode(inflated);
}
