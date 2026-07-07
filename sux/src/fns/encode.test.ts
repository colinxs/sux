import { describe, expect, it } from "vitest";

import { encode } from "./encode";

describe("encode", () => {
	it("rejects an unknown codec", async () => {
		const r = await encode.run({} as any, { text: "hello", codec: "rot13" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/codec must be base64 \| hex \| url/);
	});

	it("base64-encodes text by default", async () => {
		const r = await encode.run({} as any, { text: "hello", codec: "base64" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("aGVsbG8=");
	});

	it("round-trips utf-8 through hex decode", async () => {
		const enc = await encode.run({} as any, { text: "héllo", codec: "hex" });
		const r = await encode.run({} as any, { text: enc.content[0].text, codec: "hex", direction: "decode" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("héllo");
	});

	it("base64 round-trips a large (>200KB) input without a stack overflow", async () => {
		const text = "sûx-".repeat(60_000); // >200KB UTF-8
		const enc = await encode.run({} as any, { text, codec: "base64" });
		expect(enc.isError).toBeFalsy();
		const dec = await encode.run({} as any, { text: enc.content[0].text, codec: "base64", direction: "decode" });
		expect(dec.isError).toBeFalsy();
		expect(dec.content[0].text).toBe(text);
	});

	it("surfaces a failed base64 decode", async () => {
		const r = await encode.run({} as any, { text: "!!!not base64!!!", codec: "base64", direction: "decode" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/decode failed/);
	});
});
