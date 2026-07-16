import { describe, expect, it } from "vitest";
import { headerSafeJson } from "./_dropbox-core";

describe("headerSafeJson", () => {
	it("leaves plain ASCII untouched", () => {
		expect(headerSafeJson({ path: "/plain/file.txt" })).toBe('{"path":"/plain/file.txt"}');
	});

	it("escapes accented characters", () => {
		expect(headerSafeJson({ path: "/café/notes.txt" })).toBe('{"path":"/caf\\u00e9/notes.txt"}');
	});

	it("escapes CJK characters", () => {
		expect(headerSafeJson({ path: "/日本語.txt" })).toBe('{"path":"/\\u65e5\\u672c\\u8a9e.txt"}');
	});

	it("escapes emoji (surrogate pairs) with no raw bytes >= 0x7f left", () => {
		const out = headerSafeJson({ path: "/emoji😀test.txt" });
		expect(out).toBe('{"path":"/emoji\\ud83d\\ude00test.txt"}');
		expect([...out].every((c) => c.charCodeAt(0) < 0x7f)).toBe(true);
	});

	it("leaves literal hyphens alone", () => {
		expect(headerSafeJson({ path: "/a-b-c.txt" })).toBe('{"path":"/a-b-c.txt"}');
	});
});
