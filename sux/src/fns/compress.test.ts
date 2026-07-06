import { describe, expect, it } from "vitest";
import { compress } from "./compress";

const original = "the quick brown fox ".repeat(200); // compressible

async function roundTrip(codec: string) {
	const c = JSON.parse((await compress.run({} as any, { data: original, codec })).content[0].text);
	const d = await compress.run({} as any, { data: c.base64, codec, direction: "decompress" });
	return { meta: c, decoded: d.content[0].text };
}

describe("compress", () => {
	it("defaults to brotli and round-trips losslessly at high ratio", async () => {
		const { meta, decoded } = await roundTrip("brotli");
		expect(meta.codec).toBe("brotli");
		expect(meta.saved_pct).toBeGreaterThan(80); // repetitive text -> excellent brotli ratio
		expect(meta.out_bytes).toBeLessThan(meta.in_bytes);
		expect(decoded).toBe(original);
	});

	it("round-trips gzip and deflate-raw too", async () => {
		expect((await roundTrip("gzip")).decoded).toBe(original);
		expect((await roundTrip("deflate-raw")).decoded).toBe(original);
	});

	it("round-trips zstd when the runtime supports it, else fails cleanly", async () => {
		const c = await compress.run({} as any, { data: original, codec: "zstd" });
		if (c.isError) {
			expect(c.content[0].text).toMatch(/zstd is not available/);
		} else {
			const meta = JSON.parse(c.content[0].text);
			const d = await compress.run({} as any, { data: meta.base64, codec: "zstd", direction: "decompress" });
			expect(d.content[0].text).toBe(original);
		}
	});

	it('decompress as:"base64" round-trips binary payloads losslessly', async () => {
		// Compress bytes that are NOT valid UTF-8 (would be mangled by TextDecoder).
		const binary = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 9, 9]);
		const b64 = btoa(String.fromCharCode(...binary));
		// gzip the raw text form via node zlib in-fn: compress direction takes text,
		// so gzip the base64-decoded bytes by hand instead.
		const zlib = (await import("node:zlib")) as any;
		const packed = btoa(String.fromCharCode(...new Uint8Array(zlib.gzipSync(binary))));
		const d = await compress.run({} as any, { data: packed, codec: "gzip", direction: "decompress", as: "base64" });
		expect(d.isError).toBeFalsy();
		const out = JSON.parse(d.content[0].text);
		expect(out.bytes).toBe(binary.length);
		expect(out.base64).toBe(b64);
	});

	it('decompress as:"url" stores the bytes in the CAS store and returns a ref', async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		const c = JSON.parse((await compress.run({} as any, { data: "hello", codec: "gzip" })).content[0].text);
		const d = await compress.run(env, { data: c.base64, codec: "gzip", direction: "decompress", as: "url" });
		expect(d.isError).toBeFalsy();
		const ref = JSON.parse(d.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.bytes).toBe(5);
	});

	it('compress as:"url" returns stats plus a CAS ref instead of inline base64', async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		const r = await compress.run(env, { data: original, codec: "gzip", as: "url" });
		expect(r.isError).toBeFalsy();
		const meta = JSON.parse(r.content[0].text);
		expect(meta.codec).toBe("gzip");
		expect(meta.out_bytes).toBeGreaterThan(0);
		expect(meta.base64).toBeUndefined();
		expect(meta.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
	});

	it("rejects an unknown codec", async () => {
		const r = await compress.run({} as any, { data: "x", codec: "7z" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown codec/);
	});
});
