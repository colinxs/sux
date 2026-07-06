// Shared conversion core for the directional, output-named converters
// (json/yaml/csv/xml/markdown). Each converter fn dispatches on the SOURCE type
// (Julia-style multiple dispatch: `json(x)` parses whatever x is; `yaml(x)`
// serialises x to YAML), and bidirectionality falls out of composing them
// (`yaml(json(x))`). Pure, dependency-free.

export type Format = "json" | "yaml" | "csv" | "xml";

/** Best-effort source-format detection for `from: auto`. */
export function detectFormat(s: string): Format {
	const t = s.trim();
	if (!t) return "json";
	if (t.startsWith("<")) return "xml";
	if (t.startsWith("{") || t.startsWith("[")) return "json";
	// A YAML document usually has `key:` lines or `- ` sequences early on.
	if (/^\s*[\w.-]+\s*:(\s|$)/m.test(t) || /^\s*-\s/m.test(t)) return "yaml";
	// Otherwise, comma-separated columns across lines looks like CSV.
	if (/^[^\n]*,[^\n]*\n/.test(t)) return "csv";
	return "yaml";
}

// ---------- JSON <-> YAML (practical common subset) ----------

function needsQuote(s: string): boolean {
	if (s === "") return true;
	if (/^(true|false|null|~)$/i.test(s)) return true;
	if (/^-?\d+(\.\d+)?$/.test(s)) return true;
	return /[:#\[\]{}&*!|>'"%@`,]|^[\s?-]|\s$/.test(s);
}

function yamlScalar(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	if (Array.isArray(v)) return "[]";
	if (typeof v === "object") return "{}";
	const s = String(v);
	return needsQuote(s) ? JSON.stringify(s) : s;
}

export function toYaml(v: unknown, indent = 0): string {
	const pad = "  ".repeat(indent);
	if (Array.isArray(v)) {
		if (!v.length) return `${pad}[]`;
		return v
			.map((item) => {
				if (item !== null && typeof item === "object" && Object.keys(item as object).length) {
					const block = toYaml(item, indent + 1);
					return `${pad}-${block.slice(pad.length + 1)}`;
				}
				return `${pad}- ${yamlScalar(item)}`;
			})
			.join("\n");
	}
	if (v !== null && typeof v === "object") {
		const keys = Object.keys(v as object);
		if (!keys.length) return `${pad}{}`;
		return keys
			.map((k) => {
				const val = (v as Record<string, unknown>)[k];
				if (val !== null && typeof val === "object" && Object.keys(val as object).length) {
					return `${pad}${k}:\n${toYaml(val, indent + 1)}`;
				}
				return `${pad}${k}: ${yamlScalar(val)}`;
			})
			.join("\n");
	}
	return `${pad}${yamlScalar(v)}`;
}

function parseScalar(raw: string): unknown {
	const s = raw.trim();
	if (s === "" || s === "~" || s === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+$/.test(s)) return parseInt(s, 10);
	if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		if (s[0] === '"') {
			try {
				return JSON.parse(s);
			} catch {
				return s.slice(1, -1);
			}
		}
		return s.slice(1, -1).replace(/''/g, "'");
	}
	if (s.startsWith("[") || s.startsWith("{")) {
		try {
			return JSON.parse(s);
		} catch {
			/* fall through */
		}
	}
	return s;
}

export function parseYaml(text: string): unknown {
	const lines = text
		.split(/\r?\n/)
		.filter((l) => l.trim() !== "" && !/^\s*#/.test(l))
		.map((l) => (/["']/.test(l) ? l : l.replace(/\s+#.*$/, "")))
		.map((l) => l.replace(/\s+$/, ""));

	let i = 0;
	const indentOf = (l: string) => l.match(/^\s*/)![0].length;

	function parseBlock(minIndent: number): unknown {
		const first = lines[i];
		if (first === undefined) return null;
		if (/^\s*-(\s|$)/.test(first)) return parseSeq(minIndent);
		return parseMap(minIndent);
	}
	function parseSeq(minIndent: number): unknown[] {
		const arr: unknown[] = [];
		while (i < lines.length) {
			const line = lines[i];
			const ind = indentOf(line);
			if (ind < minIndent || !/^\s*-(\s|$)/.test(line)) break;
			const rest = line.slice(ind + 1).replace(/^\s*/, "");
			i++;
			if (rest === "") {
				arr.push(parseBlock(ind + 1));
			} else if (/^[^"'\[{][^:]*:(\s|$)/.test(rest)) {
				const m = rest.match(/^([^:]+):\s*(.*)$/)!;
				const obj: Record<string, unknown> = {};
				const childIndent = ind + 2;
				if (m[2].trim() === "") obj[m[1].trim()] = parseBlock(childIndent);
				else obj[m[1].trim()] = parseScalar(m[2]);
				mergeMap(obj, childIndent);
				arr.push(obj);
			} else {
				arr.push(parseScalar(rest));
			}
		}
		return arr;
	}
	function parseMap(minIndent: number): Record<string, unknown> {
		const obj: Record<string, unknown> = {};
		mergeMap(obj, minIndent);
		return obj;
	}
	function mergeMap(obj: Record<string, unknown>, minIndent: number) {
		while (i < lines.length) {
			const line = lines[i];
			const ind = indentOf(line);
			if (ind < minIndent || /^\s*-(\s|$)/.test(line.slice(ind))) break;
			const m = line.match(/^\s*([^:]+?):\s*(.*)$/);
			if (!m) break;
			i++;
			const key = m[1].trim();
			if (m[2].trim() === "") obj[key] = parseBlock(ind + 1);
			else obj[key] = parseScalar(m[2]);
		}
	}
	return parseBlock(0);
}

/** Parse any supported source string into a JS value. csv/xml are wired as the
 * matching directional converters land; unsupported sources say so clearly. */
export function parseSource(data: string, from: Format): unknown {
	switch (from) {
		case "json":
			return JSON.parse(data);
		case "yaml":
			return parseYaml(data);
		default:
			throw new Error(`parsing '${from}' isn't wired here yet — use the ${from}_json converter`);
	}
}
