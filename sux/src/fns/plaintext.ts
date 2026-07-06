import { type Fn, fail, ok } from "../registry";
import { normalizeText, type NormalizeForm } from "../normalize";

const FORMS: NormalizeForm[] = ["NFC", "NFD", "NFKC", "NFKD", "none"];

export const plaintext: Fn = {
	name: "plaintext",
	description:
		"Normalize text to clean plaintext. Folds styled/fullwidth 'font' Unicode (𝐛𝐨𝐥𝐝, 𝕕𝕠𝕦𝕓𝕝𝕖, 𝔉𝔯𝔞𝔨𝔱𝔲𝔯, ｆｕｌｌｗｉｄｔｈ) back to ASCII, " +
		"strips BOM / zero-width / control characters, normalizes CRLF→LF, and applies Unicode normalization. " +
		"The same sane normalization runs automatically on every tool's input/output; call this to do it explicitly or to opt into the extra " +
		"`collapseWhitespace`/`trim` cleanup. Options: form (NFC default; NFKC = maximal compatibility fold), defont, stripZeroWidth, stripControls, normalizeNewlines, collapseWhitespace, trim.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to normalize." },
			form: { type: "string", enum: [...FORMS], description: "Unicode normalization form. Default NFC. NFKC folds all compatibility (font) characters." },
			defont: { type: "boolean", description: "Fold styled/fullwidth Latin letters+digits to ASCII (default true; redundant under NFKC/NFKD)." },
			stripZeroWidth: { type: "boolean", description: "Remove zero-width and bidi formatting characters (default true)." },
			stripControls: { type: "boolean", description: "Remove control characters, keeping tab and newline (default true)." },
			normalizeNewlines: { type: "boolean", description: "Convert CRLF/CR and line/paragraph separators to LF (default true)." },
			collapseWhitespace: { type: "boolean", description: "Collapse space/tab runs, trim line ends, cap consecutive blank lines (default false)." },
			trim: { type: "boolean", description: "Trim leading/trailing whitespace of the whole string (default false)." },
		},
	},
	cacheable: true,
	// The boundary would normalize this fn's output anyway, but `raw` keeps the
	// caller's chosen options authoritative (e.g. form:none returns text verbatim).
	raw: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("`text` must be a string.");
		if (args?.form !== undefined && !FORMS.includes(args.form)) return fail(`Unknown form '${args.form}'. Allowed: ${FORMS.join(", ")}.`);
		const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
		const out = normalizeText(args.text, {
			form: (args?.form ?? "NFC") as NormalizeForm,
			defont: bool(args?.defont, true),
			stripZeroWidth: bool(args?.stripZeroWidth, true),
			stripControls: bool(args?.stripControls, true),
			normalizeNewlines: bool(args?.normalizeNewlines, true),
			stripBom: true,
			collapseWhitespace: bool(args?.collapseWhitespace, false),
			trim: bool(args?.trim, false),
		});
		return ok(out);
	},
};
