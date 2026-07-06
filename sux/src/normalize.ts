// Text normalization — one place so the open/close boundary (index.ts) and the
// `plaintext` fn behave identically. Pure, dependency-free, web-standard APIs.
//
// "Sane" defaults strip the invisible/among-us junk that breaks downstream tools
// (BOM, zero-width chars, control chars, CRLF) and fold "font" characters — the
// styled Unicode letters people paste (𝐛𝐨𝐥𝐝, 𝕕𝕠𝕦𝕓𝕝𝕖, 𝔉𝔯𝔞𝔨𝔱𝔲𝔯, ｆｕｌｌｗｉｄｔｈ) —
// back to plain ASCII, without touching accents or non-Latin scripts.

export type NormalizeForm = "NFC" | "NFD" | "NFKC" | "NFKD" | "none";

export type NormalizeOptions = {
	form?: NormalizeForm; // Unicode normalization form (default NFC)
	defont?: boolean; // fold styled/fullwidth Latin letters+digits to ASCII
	stripZeroWidth?: boolean; // remove ZWSP/ZWNJ/ZWJ/WJ/BOM/soft-hyphen/bidi marks
	stripControls?: boolean; // remove C0/C1 control chars (keeps \t and \n)
	normalizeNewlines?: boolean; // CRLF/CR and LS/PS -> LF
	stripBom?: boolean; // drop a leading U+FEFF
	collapseWhitespace?: boolean; // collapse space/tab runs, trim line ends, cap blank lines
	trim?: boolean; // trim leading/trailing whitespace of the whole string
};

// Applied automatically at the MCP boundary. Conservative: fixes invisibles and
// font styling but preserves meaningful whitespace and structure (safe for JSON).
export const SANE: NormalizeOptions = {
	form: "NFC",
	defont: true,
	stripZeroWidth: true,
	stripControls: true,
	normalizeNewlines: true,
	stripBom: true,
	collapseWhitespace: false,
	trim: false,
};

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD\u200E\u200F\u061C\u180E]/g;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Fold a styled/fullwidth Latin letter or digit to ASCII, else leave it be.
 * Uses per-codepoint NFKC (handles the reserved holes in the Mathematical
 * Alphanumeric block correctly) and only accepts a short pure-ASCII result, so
 * accents (é), symbols (½, µ), and non-Latin scripts are untouched. */
export function defont(s: string): string {
	// Copy the ASCII prefix wholesale — most strings are mostly (or all) ASCII.
	let i = 0;
	while (i < s.length && s.charCodeAt(i) <= 0x7f) i++;
	if (i === s.length) return s;
	const out: string[] = [s.slice(0, i)];
	for (const ch of s.slice(i)) {
		// iterates by code point, so astral math chars (U+1D400+) stay intact
		if (ch.codePointAt(0)! <= 0x7f) {
			out.push(ch);
			continue;
		}
		const k = ch.normalize("NFKC");
		out.push(/^[A-Za-z0-9]{1,3}$/.test(k) ? k : ch);
	}
	return out.join("");
}

export function normalizeText(input: string, opts: NormalizeOptions = SANE): string {
	let s = input;
	if (opts.stripBom && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	if (opts.normalizeNewlines) s = s.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");
	if (opts.stripControls) s = s.replace(CONTROLS, "");
	if (opts.stripZeroWidth) s = s.replace(ZERO_WIDTH, "");
	// Pure-ASCII fast path: ASCII is invariant under all normalization forms and
	// defont is the identity on it, so skip both passes entirely.
	if (/[^\x00-\x7F]/.test(s)) {
		if (opts.form && opts.form !== "none") s = s.normalize(opts.form);
		// NFKC/NFKD already fold compatibility (font) characters; skip the extra pass.
		if (opts.defont && opts.form !== "NFKC" && opts.form !== "NFKD") s = defont(s);
	}
	if (opts.collapseWhitespace) {
		s = s
			.split("\n")
			.map((line) => line.replace(/[ \t]+/g, " ").replace(/ +$/g, ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");
	}
	if (opts.trim) s = s.trim();
	return s;
}

/** Deep-normalize the string values of a JSON-RPC arguments object in place-safe
 * fashion (returns a new value). Non-strings pass through untouched. */
export function normalizeArgs<T>(value: T, opts: NormalizeOptions = SANE): T {
	if (typeof value === "string") return normalizeText(value, opts) as unknown as T;
	if (Array.isArray(value)) return value.map((v) => normalizeArgs(v, opts)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = normalizeArgs(v, opts);
		return out as T;
	}
	return value;
}
