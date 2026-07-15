import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { packForCache, unpackFromCache } from "./cache-codec";

const Z = zlib as any;
const MAGIC = [0x73, 0x78, 0x7a, 0x31];

/** Build a raw sxz1 frame around an already-compressed payload, bypassing
 * packForCache — lets a test hand-craft a frame packForCache itself would
 * never produce (e.g. a decompression bomb). */
function frame(tag: number, compressed: Uint8Array): Uint8Array {
	const out = new Uint8Array(MAGIC.length + 1 + compressed.length);
	out.set(MAGIC, 0);
	out[MAGIC.length] = tag;
	out.set(compressed, MAGIC.length + 1);
	return out;
}

describe("cache-codec", () => {
	it("passes small payloads through as a plain string (frame not worth it)", () => {
		const s = JSON.stringify({ a: 1 });
		expect(packForCache(s)).toBe(s);
		expect(unpackFromCache(s)).toBe(s);
	});

	it("compresses a large JSON payload to a tagged byte frame and round-trips it", () => {
		const big = JSON.stringify({ content: [{ type: "text", text: "lorem ipsum dolor ".repeat(200) }] });
		const packed = packForCache(big);
		expect(typeof packed).not.toBe("string");
		const bytes = packed as Uint8Array;
		expect([...bytes.slice(0, 4)]).toEqual([0x73, 0x78, 0x7a, 0x31]); // "sxz1"
		expect([0x7a, 0x62, 0x67]).toContain(bytes[4]); // zstd | brotli | gzip
		expect(bytes.length).toBeLessThan(new TextEncoder().encode(big).length); // actually smaller
		expect(unpackFromCache(bytes)).toBe(big); // via Uint8Array
		expect(unpackFromCache(bytes.buffer.slice(0) as ArrayBuffer)).toBe(big); // via ArrayBuffer (real KV shape)
	});

	it("decodes a legacy / plain-JSON entry (no magic) whether string or bytes", () => {
		const legacy = JSON.stringify({ old: true, note: "x".repeat(1000) });
		expect(unpackFromCache(legacy)).toBe(legacy);
		expect(unpackFromCache(new TextEncoder().encode(legacy))).toBe(legacy);
	});

	it("returns the plain string when compression wouldn't shrink it", () => {
		// Incompressible-ish: a long run of distinct chars still >512 bytes.
		const s = JSON.stringify({ r: Array.from({ length: 600 }, (_, i) => String.fromCharCode(33 + (i % 90))).join("") });
		const packed = packForCache(s);
		// Either it compressed (bytes) or bailed to string — but it must round-trip.
		expect(unpackFromCache(packed as any)).toBe(s);
	});

	it("rejects a decompression bomb instead of allocating past the output cap", () => {
		// All-zero buffers compress to a few KB with every codec but decompress
		// back to their full size — a crafted/corrupted KV entry could use this
		// to force a huge allocation before unpackFromCache's throw is caught.
		const bomb = new Uint8Array(40 * 1024 * 1024);
		const codecs: [number, Uint8Array][] = [
			[0x7a, Z.zstdCompressSync(bomb, { params: { [Z.constants.ZSTD_c_compressionLevel]: 10 } })],
			[0x62, Z.brotliCompressSync(bomb, { params: { [Z.constants.BROTLI_PARAM_QUALITY]: 6 } })],
			[0x67, Z.gzipSync(bomb, { level: 6 })],
		];
		for (const [tag, compressed] of codecs) {
			expect(() => unpackFromCache(frame(tag, compressed))).toThrow();
		}
	});
});
