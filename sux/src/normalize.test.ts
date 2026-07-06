import { describe, expect, it } from "vitest";
import { normalizeArgs, normalizeText, SANE } from "./normalize";

describe("normalizeText (sane defaults)", () => {
	it("folds mathematical/styled font letters to ASCII", () => {
		expect(normalizeText("𝐇𝐞𝐥𝐥𝐨 𝕎𝕠𝕣𝕝𝕕 𝔉𝔯𝔞𝔨𝔱𝔲𝔯")).toBe("Hello World Fraktur");
	});

	it("folds fullwidth forms to ASCII", () => {
		expect(normalizeText("Ｈｅｌｌｏ１２３")).toBe("Hello123");
	});

	it("preserves accents and non-Latin scripts", () => {
		expect(normalizeText("café — Москва — 日本語 — µ ½")).toBe("café — Москва — 日本語 — µ ½");
	});

	it("strips zero-width and BOM characters", () => {
		expect(normalizeText("﻿a​b‍c⁠d")).toBe("abcd");
	});

	it("removes control characters but keeps tab and newline", () => {
		expect(normalizeText("abc\td\ne")).toBe("abc\td\ne");
	});

	it("normalizes CRLF and line/paragraph separators to LF", () => {
		expect(normalizeText("a\r\nb\rc d e")).toBe("a\nb\nc\nd\ne");
	});

	it("does not collapse whitespace by default (safe for structure)", () => {
		expect(normalizeText("a    b\n\n\n\nc")).toBe("a    b\n\n\n\nc");
	});

	it("applies NFC composition", () => {
		// decomposed e + combining acute -> composed é
		expect(normalizeText("é")).toBe("é");
		expect(SANE.form).toBe("NFC");
	});
});

describe("normalizeText (options)", () => {
	it("collapseWhitespace collapses runs and caps blank lines", () => {
		expect(normalizeText("a    b   \n\n\n\nc", { collapseWhitespace: true })).toBe("a b\n\nc");
	});

	it("trim trims the whole string", () => {
		expect(normalizeText("  hi  ", { trim: true })).toBe("hi");
	});

	it("form:none leaves styling when defont is off", () => {
		expect(normalizeText("𝐇𝐢", { form: "none", defont: false })).toBe("𝐇𝐢");
	});

	it("NFKC folds font characters without a separate defont pass", () => {
		expect(normalizeText("𝐇𝐢", { form: "NFKC", defont: false })).toBe("Hi");
	});
});

describe("normalizeArgs", () => {
	it("normalizes string values deeply, leaving non-strings intact", () => {
		const out = normalizeArgs({ q: "𝐇𝐢", n: 42, nested: { list: ["𝐀", true] } });
		expect(out).toEqual({ q: "Hi", n: 42, nested: { list: ["A", true] } });
	});
});
