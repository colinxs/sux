import { describe, expect, it } from "vitest";
import { GZIP_MARKER, isCompressed, maybeCompress, maybeCompressString, maybeDecompress, maybeDecompressString, shouldCompress } from "./_gzip";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
// Highly compressible text well over the min-size threshold.
const bigText = "the quick brown fox jumps over the lazy dog. ".repeat(200);

describe("_gzip codec", () => {
	it("compresses a large text blob into a marker-framed gzip stream and round-trips", async () => {
		const raw = enc(bigText);
		const stored = await maybeCompress(raw, "text/plain");
		expect(stored.length).toBeLessThan(raw.length);
		expect(isCompressed(stored)).toBe(true);
		expect(stored[0]).toBe(GZIP_MARKER);
		expect(stored[1]).toBe(0x1f);
		expect(stored[2]).toBe(0x8b);
		expect(dec(await maybeDecompress(stored))).toBe(bigText);
	});

	it("leaves a small value uncompressed (marker overhead would grow it)", async () => {
		const raw = enc("hello world");
		const stored = await maybeCompress(raw, "text/plain");
		expect(stored).toBe(raw); // same reference — untouched
		expect(isCompressed(stored)).toBe(false);
	});

	it("skips already-compressed content types even when large", async () => {
		const raw = new Uint8Array(4096).fill(65); // would compress well, but ct says no
		const stored = await maybeCompress(raw, "image/png");
		expect(stored).toBe(raw);
	});

	it("skips payloads whose magic bytes are already compressed (no/opaque ct)", async () => {
		// A PDF header + filler, labeled octet-stream — magic-byte sniff must skip it.
		const raw = new Uint8Array(2048);
		raw.set(enc("%PDF-1.7"), 0);
		const stored = await maybeCompress(raw, "application/octet-stream");
		expect(stored).toBe(raw);
	});

	it("stores raw when the content does not actually shrink (random bytes)", async () => {
		const raw = new Uint8Array(1024);
		crypto.getRandomValues(raw);
		const stored = await maybeCompress(raw, "text/plain");
		expect(stored).toBe(raw); // gzip of random data is bigger — kept raw
		expect(isCompressed(stored)).toBe(false);
	});

	it("passes legacy/raw bytes through maybeDecompress unchanged (backward compatible)", async () => {
		const legacy = enc("a pre-existing object stored before compression existed");
		expect(await maybeDecompress(legacy)).toBe(legacy);
	});

	it("never auto-inflates a user's own gzip file (no marker in front of 1f 8b)", async () => {
		// Real gzip bytes start 1f 8b with NO leading marker byte — must be left alone.
		const userGz = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
		expect(isCompressed(userGz)).toBe(false);
		expect(await maybeDecompress(userGz)).toBe(userGz);
	});

	it("rejects cleanly (no hang, no unhandled rejection) on a corrupt marker-framed frame", async () => {
		// Marker(0x00) + gzip magic(1f 8b) but a garbage/truncated body: isCompressed()
		// treats it as ours, so gunzip must throw a handled rejection — the read-path
		// callers (store/dropbox/kv_get) wrap this in a fail(). Guards the writer-side
		// error handling in gunzip (a stray unhandled rejection would fail CI).
		const frame = new Uint8Array([GZIP_MARKER, 0x1f, 0x8b, 0x00, 0x11, 0x22, 0x33]);
		expect(isCompressed(frame)).toBe(true);
		await expect(maybeDecompress(frame)).rejects.toThrow();
	});

	it("shouldCompress gates on size, content type, and magic bytes", () => {
		expect(shouldCompress(enc(bigText), "text/plain")).toBe(true);
		expect(shouldCompress(enc("tiny"), "text/plain")).toBe(false);
		expect(shouldCompress(enc(bigText), "application/zip")).toBe(false);
	});

	it("KV string: compresses a large value and round-trips; small/legacy pass through", async () => {
		const packed = await maybeCompressString(bigText);
		expect(packed.length).toBeLessThan(bigText.length);
		expect(packed).not.toBe(bigText);
		expect(await maybeDecompressString(packed)).toBe(bigText);

		const small = "just a short config value";
		expect(await maybeCompressString(small)).toBe(small); // stored plain
		expect(await maybeDecompressString(small)).toBe(small); // legacy plain passes through
	});
});
