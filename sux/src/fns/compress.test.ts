import { describe, expect, it } from "vitest";
import { compress } from "./compress";

const original = "the quick brown fox ".repeat(200); // compressible

describe("compress", () => {
	it("round-trips losslessly (gzip)", async () => {
		const c = await compress.run({} as any, { data: original, codec: "gzip" });
		const meta = JSON.parse(c.content[0].text);
		expect(meta.saved_pct).toBeGreaterThan(50); // repetitive text compresses well
		expect(meta.out_bytes).toBeLessThan(meta.in_bytes);

		const d = await compress.run({} as any, { data: meta.base64, codec: "gzip", direction: "decompress" });
		expect(d.content[0].text).toBe(original);
	});

	it("round-trips deflate-raw too", async () => {
		const c = JSON.parse((await compress.run({} as any, { data: "hello", codec: "deflate-raw" })).content[0].text);
		const d = await compress.run({} as any, { data: c.base64, codec: "deflate-raw", direction: "decompress" });
		expect(d.content[0].text).toBe("hello");
	});

	it("rejects not-yet-supported codecs", async () => {
		const r = await compress.run({} as any, { data: "x", codec: "zstd" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not yet supported/);
	});
});
