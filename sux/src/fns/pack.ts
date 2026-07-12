import { type Fn, fail, ok } from "../registry";
import { toCsv } from "./_convert";

// Re-encode a JSON array of records into a header-plus-rows tabular form so the
// keys aren't repeated on every object. Cuts token count for LLM consumption.

type Row = Record<string, unknown>;

function cellString(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function packTsv(headers: string[], rows: Row[], sep: string): string {
	const esc = (s: string) => s.replace(/[\t\r\n]/g, " ");
	const lines = [headers.map(esc).join(sep)];
	for (const r of rows) lines.push(headers.map((h) => esc(cellString(r[h]))).join(sep));
	return lines.join("\n");
}

// csv delegates to _convert's toCsv rather than reimplementing quoting — it
// carries the spreadsheet-formula-injection guard (a leading =/+/-/@ cell opened
// in Excel/Sheets/LibreOffice can execute as a formula) that a bespoke escaper
// here would otherwise have to duplicate and could omit.

// kv: one "k=v" pair per field, records separated by a blank line. Skips empties.
function packKv(headers: string[], rows: Row[]): string {
	return rows
		.map((r) => headers.filter((h) => cellString(r[h]) !== "").map((h) => `${h}=${cellString(r[h])}`).join("\n"))
		.join("\n\n");
}

export const pack: Fn = {
	name: "pack",
	description:
		"Re-encode a JSON array of objects into a compact, token-cheap tabular form so keys aren't repeated per row. format: tsv (default) | csv | kv. Emits a header (tsv/csv) or key=value pairs (kv). Returns the packed string plus an estimated token-savings note (set note:false for the bare packed data, e.g. when piping downstream). Fails if `data` is not an array of objects.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "array", description: "JSON array of flat objects (records)." },
			format: { type: "string", enum: ["tsv", "csv", "kv"], default: "tsv" },
			note: { type: "boolean", default: true, description: "Append the token-savings note. Set false to return only the packed data." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = args?.data;
		if (!Array.isArray(data)) return fail("`data` must be a JSON array of objects.");
		if (data.length === 0) return ok("(empty array)");
		if (!data.every((o) => o !== null && typeof o === "object" && !Array.isArray(o)))
			return fail("`data` must be an array of objects.");

		const format = args?.format ?? "tsv";
		if (format !== "tsv" && format !== "csv" && format !== "kv") return fail("format must be one of: tsv, csv, kv");

		const rows = data as Row[];
		const headers = [...new Set(rows.flatMap((o) => Object.keys(o)))];
		if (headers.length === 0) return fail("`data` objects have no keys to pack.");

		const packed = format === "csv" ? toCsv(rows, ",") : format === "kv" ? packKv(headers, rows) : packTsv(headers, rows, "\t");

		if (args?.note === false) return ok(packed);

		// ~4 chars/token heuristic for the savings note.
		const originalBytes = JSON.stringify(data).length;
		const packedBytes = packed.length;
		const saved = originalBytes - packedBytes;
		const pct = originalBytes > 0 ? Math.round((saved / originalBytes) * 100) : 0;
		const note = `\n\n[packed ${rows.length} records as ${format}: ~${Math.round(originalBytes / 4)} → ~${Math.round(packedBytes / 4)} tokens, ${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%]`;
		return ok(packed + note);
	},
};
