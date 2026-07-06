import { type Fn, fail, ok } from "../registry";

function parseCsv(text: string, delim: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQ = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQ) {
			if (c === '"') {
				if (text[i + 1] === '"') { field += '"'; i++; }
				else inQ = false;
			} else field += c;
		} else if (c === '"') inQ = true;
		else if (c === delim) { row.push(field); field = ""; }
		else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
		else if (c === "\r") {  }
		else field += c;
	}
	if (field.length || row.length) { row.push(field); rows.push(row); }
	return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ""));
}

function toCsv(arr: any[], delim: string): string {
	if (!arr.length) return "";
	const headers = [...new Set(arr.flatMap((o) => Object.keys(o ?? {})))];
	const esc = (v: any) => {
		const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
		return new RegExp(`["${delim}\\n]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	return [headers.join(delim), ...arr.map((o) => headers.map((h) => esc(o?.[h])).join(delim))].join("\n");
}

export const csvJson: Fn = {
	name: "csv_json",
	description: "Convert CSV ↔ JSON. direction: to_json (default; first row = headers → array of objects) | to_csv (give a JSON array of objects). delimiter defaults to ','.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "CSV text, or a JSON array string." },
			direction: { type: "string", enum: ["to_json", "to_csv"], default: "to_json" },
			delimiter: { type: "string", default: "," },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		const delim = String(args?.delimiter ?? ",").slice(0, 1) || ",";
		if (!data.trim()) return fail("Provide `data`.");
		try {
			if (String(args?.direction ?? "to_json") === "to_csv") {
				const arr = JSON.parse(data);
				if (!Array.isArray(arr)) return fail("to_csv expects a JSON array of objects.");
				return ok(toCsv(arr, delim));
			}
			const rows = parseCsv(data, delim);
			if (rows.length < 1) return ok("[]");
			const headers = rows[0];
			const objs = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
			return ok(JSON.stringify(objs, null, 2));
		} catch (e) {
			return fail(`Conversion failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
