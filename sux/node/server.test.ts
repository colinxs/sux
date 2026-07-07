import { describe, expect, it } from "vitest";
import { encodeBody } from "./server.mjs";

// Guards the residential-proxy binary-egress contract: the node must base64 the
// upstream body and flag bodyEncoding:"base64" so arbitrary bytes survive the
// JSON transport (src/proxy.ts decodes them). Returning a plain utf8 string —
// the previous behavior — mangled non-UTF-8 bytes to U+FFFD and forced the Worker
// to refetch DIRECT, silently defeating residential egress for images/PDFs.
describe("encodeBody (node residential proxy)", () => {
	it("flags base64 and round-trips every byte 0x00-0xFF byte-for-byte", () => {
		const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
		const out = encodeBody(raw);
		expect(out.bodyEncoding).toBe("base64");
		expect(Buffer.from(out.body, "base64").equals(raw)).toBe(true);
	});

	it("base64s text too (uniform with openwrt/fetch.sh — the Worker decodes both)", () => {
		const out = encodeBody(Buffer.from("hello, world", "utf8"));
		expect(out.bodyEncoding).toBe("base64");
		expect(Buffer.from(out.body, "base64").toString("utf8")).toBe("hello, world");
	});

	it("preserves a PNG magic header (the binary that used to trip binary_refetch)", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const decoded = Buffer.from(encodeBody(png).body, "base64");
		expect(decoded.equals(png)).toBe(true);
	});
});
