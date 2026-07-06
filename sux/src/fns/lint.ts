import { type Fn, fail, ok } from "../registry";

// Lint a text document: report syntax errors (with line:col) and style warnings.
// Pure — no network, no deps. JSON gets full parse + duplicate-key detection;
// every format gets universal text-hygiene checks.

type Finding = { severity: "error" | "warning"; line: number; col: number; message: string };

const FORMATS = ["json", "text"] as const;
type Format = (typeof FORMATS)[number];

/** Map a 0-based string offset to 1-based line/col. */
function lineCol(s: string, offset: number): { line: number; col: number } {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset && i < s.length; i++) {
		if (s.charCodeAt(i) === 10) {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, col };
}

/** Universal, format-agnostic text hygiene. */
function textHygiene(s: string): Finding[] {
	const out: Finding[] = [];
	if (s.charCodeAt(0) === 0xfeff) out.push({ severity: "warning", line: 1, col: 1, message: "leading UTF-8 BOM" });
	if (s.includes("\r\n")) out.push({ severity: "warning", line: 1, col: 1, message: "CRLF line endings (expected LF)" });

	const lines = s.split("\n");
	let sawTabIndent = false;
	let sawSpaceIndent = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].replace(/\r$/, "");
		if (/[ \t]+$/.test(raw)) out.push({ severity: "warning", line: i + 1, col: raw.search(/[ \t]+$/) + 1, message: "trailing whitespace" });
		const indent = raw.match(/^[ \t]+/)?.[0] ?? "";
		if (indent.includes("\t")) sawTabIndent = true;
		if (indent.includes(" ")) sawSpaceIndent = true;
	}
	if (sawTabIndent && sawSpaceIndent) out.push({ severity: "warning", line: 1, col: 1, message: "mixed tab/space indentation" });
	if (s.length > 0 && !s.endsWith("\n")) out.push({ severity: "warning", line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1, message: "no final newline" });
	return out;
}

/** Locate a JSON parse error from V8's message across runtime versions:
 * "(line L column C)" or "position N" (older/newer V8), else the "…snippet…"
 * some builds emit instead — found back in the source to approximate the spot. */
function jsonErrorLoc(s: string, msg: string): { line: number; col: number } {
	const lc = /line (\d+) column (\d+)/.exec(msg);
	if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
	const pos = /position (\d+)/.exec(msg);
	if (pos) return lineCol(s, Number(pos[1]));
	// Snippet form: `Unexpected token 'X', "…snippet…" is not valid JSON`.
	const snip = /"((?:[^"\\]|\\.)*)"\s+is not valid JSON/.exec(msg);
	if (snip) {
		const decoded = snip[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		const idx = s.indexOf(decoded);
		if (idx >= 0) return lineCol(s, idx);
	}
	return { line: 1, col: 1 };
}

/**
 * Scan JSON for duplicate keys within the same object (JSON.parse silently keeps
 * the last). A string-aware, single-pass state machine over a container stack.
 * Only runs once the doc parses, so structure is guaranteed well-formed.
 */
type Frame = { obj: boolean; keys: Set<string> };

function duplicateKeys(s: string): Finding[] {
	const out: Finding[] = [];
	const stack: Frame[] = [];
	let i = 0;
	const n = s.length;
	// In an object, a string token is a KEY when it appears right after '{' or ','
	// (and before its ':'); after the ':' it's a value. Track that position.
	let expectKey = false;

	const readString = (): string => {
		let buf = "";
		i++; // skip opening quote
		while (i < n) {
			const c = s[i];
			if (c === "\\") {
				buf += s[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (c === '"') {
				i++;
				break;
			}
			buf += c;
			i++;
		}
		return buf;
	};

	while (i < n) {
		const c = s[i];
		if (c === "{") {
			stack.push({ obj: true, keys: new Set() });
			expectKey = true;
			i++;
		} else if (c === "[") {
			stack.push({ obj: false, keys: new Set() });
			expectKey = false;
			i++;
		} else if (c === "}" || c === "]") {
			stack.pop();
			expectKey = false;
			i++;
		} else if (c === '"') {
			const start = i;
			const str = readString();
			const top = stack[stack.length - 1];
			if (expectKey && top?.obj) {
				if (top.keys.has(str)) {
					const { line, col } = lineCol(s, start);
					out.push({ severity: "warning", line, col, message: `duplicate key "${str}"` });
				}
				top.keys.add(str);
				expectKey = false;
			}
		} else if (c === ",") {
			expectKey = stack[stack.length - 1]?.obj ?? false;
			i++;
		} else {
			i++;
		}
	}
	return out;
}

function lintJson(s: string): Finding[] {
	const findings: Finding[] = [];
	try {
		JSON.parse(s);
	} catch (e) {
		const msg = (e as Error).message;
		const pos = jsonErrorLoc(s, msg);
		findings.push({ severity: "error", line: pos.line, col: pos.col, message: msg });
		return findings; // duplicate-key scan needs a parseable doc
	}
	findings.push(...duplicateKeys(s));
	return findings;
}

export const lint: Fn = {
	name: "lint",
	description:
		"Lint a text document for syntax errors and style issues, reporting each finding with line:col and a severity. " +
		"`format: json` runs a full JSON parse (errors located by line:col, best-effort across runtimes) plus duplicate-key detection; `format: text` (default) runs only " +
		"the universal hygiene checks. All formats also get: BOM, CRLF line endings, trailing whitespace, mixed tab/space indentation, and missing final newline. " +
		"Returns JSON { ok, errors, warnings, findings:[{ severity, line, col, message }] }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "The document text to lint." },
			format: { type: "string", enum: [...FORMATS], description: "Document format. 'json' adds JSON syntax + duplicate-key checks. Default 'text'." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.data !== "string") return fail("`data` must be a string.");
		const format = (args?.format ?? "text") as Format;
		if (!FORMATS.includes(format)) return fail(`Unknown format '${format}'. Allowed: ${FORMATS.join(", ")}.`);

		const findings: Finding[] = [];
		if (format === "json") findings.push(...lintJson(args.data));
		findings.push(...textHygiene(args.data));
		findings.sort((a, b) => a.line - b.line || a.col - b.col);

		const errors = findings.filter((f) => f.severity === "error").length;
		const warnings = findings.length - errors;
		return ok(JSON.stringify({ ok: errors === 0, errors, warnings, findings }, null, 2));
	},
};
