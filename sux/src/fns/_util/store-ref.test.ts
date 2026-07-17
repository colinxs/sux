import { describe, expect, it } from "vitest";
import { getBlob, putBlob } from "./store-ref";

function mockKV() {
	const m = new Map<string, string>();
	return { _m: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
function mockR2() {
	const m = new Map<string, { bytes: Uint8Array; ct?: string; meta?: Record<string, string> }>();
	return {
		_m: m,
		put: async (key: string, value: any, opts?: any) => {
			const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
			m.set(key, { bytes, ct: opts?.httpMetadata?.contentType, meta: opts?.customMetadata });
		},
		get: async (key: string) => {
			const o = m.get(key);
			if (!o) return null;
			return { size: o.bytes.length, httpMetadata: { contentType: o.ct }, customMetadata: o.meta, text: async () => new TextDecoder().decode(o.bytes), arrayBuffer: async () => o.bytes.buffer };
		},
		head: async () => null,
		delete: async (key: string) => void m.delete(key),
		list: async () => ({ objects: [], truncated: false }),
	};
}
const mkEnv = () => ({ R2: mockR2(), OAUTH_KV: mockKV() }) as any;

describe("store-ref: gzip-magic-collision blob (R-001)", () => {
	it("round-trips an incompressible payload whose first 3 bytes collide with our gzip frame marker", async () => {
		// maybeCompress only frames bytes that gzip actually shrinks; incompressible
		// content over MIN_COMPRESS_BYTES (256) is stored RAW. If those raw bytes
		// happen to start with [0x00, 0x1f, 0x8b] (our GZIP_MARKER + gzip magic),
		// isCompressed() can't tell that apart from a real compressed frame on
		// read — without the getBlob fallback, gunzip() throws on the garbage
		// body and the blob becomes permanently unreadable.
		const bytes = new Uint8Array(512);
		bytes[0] = 0x00;
		bytes[1] = 0x1f;
		bytes[2] = 0x8b;
		// Fill the rest with high-entropy bytes so gzip can't shrink it (keeps
		// maybeCompress on the "store raw" branch, not the "store framed" branch).
		crypto.getRandomValues(bytes.subarray(3));

		const env = mkEnv();
		const ref = await putBlob(env, bytes, "application/octet-stream");

		// Confirm the bug's precondition actually held: the object landed in R2
		// unframed (raw), and those raw bytes are themselves a false-positive for
		// isCompressed() — i.e. exactly the collision this test exercises.
		const stored = env.R2._m.get(ref.key)!.bytes;
		expect(stored).toEqual(bytes);

		const got = await getBlob(env, ref.uuid);
		expect(got).not.toBeNull();
		expect(got!.bytes).toEqual(bytes);
	});
});
