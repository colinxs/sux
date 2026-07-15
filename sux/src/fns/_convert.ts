// Shared conversion core for the directional, output-named converters
// (json/yaml/csv/xml/markdown). Each converter fn dispatches on the SOURCE type
// (Julia-style multiple dispatch: `json(x)` parses whatever x is; `yaml(x)`
// serialises x to YAML), and bidirectionality falls out of composing them
// (`yaml(json(x))`). Pure — its only dependency is _markup's shared entity decoder.

import { decodeEntities } from "./_markup";

export type Format = "json" | "yaml" | "csv" | "xml";

// __proto__/constructor/prototype as a YAML/XML key must never reach a plain-object
// assignment (`obj[key] = ...`) — that invokes the inherited `__proto__` setter and
// swaps the object's prototype instead of storing data. Both parsers run over
// untrusted fetched/scraped content, so this is a real sink, not just a lint nit.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Best-effort source-format detection for `from: auto`. */
export function detectFormat(s: string): Format {
	const t = s.trim();
	if (!t) return "json";
	if (t.startsWith("<")) return "xml";
	if (t.startsWith("{") || t.startsWith("[")) return "json";
	// A YAML document usually has `key:` lines or `- ` sequences early on.
	if (/^\s*[\w.-]+\s*:(\s|$)/m.test(t) || /^\s*-\s/m.test(t)) return "yaml";
	// A bare JSON scalar (42, "hi", true, null) is unambiguous; without this it
	// falls through to yaml, where parseYaml maps it to {} instead of the value.
	try {
		const v = JSON.parse(t);
		if (v === null || typeof v !== "object") return "json";
	} catch {
		/* not a JSON scalar — fall through */
	}
	// Otherwise, comma-separated columns look like CSV. A header-only or one-line
	// CSV carries no trailing newline, so don't require one.
	if (/^[^\n]*,[^\n]*(\n|$)/.test(t)) return "csv";
	return "yaml";
}

// ---------- JSON <-> YAML (practical common subset) ----------

function needsQuote(s: string): boolean {
	if (s === "") return true;
	if (/^(true|false|null|~)$/i.test(s)) return true;
	if (/^-?\d+(\.\d+)?$/.test(s)) return true;
	return /[:#\[\]{}&*!|>'"%@`,\n\r\t]|^[\s?-]|\s$/.test(s);
}

function yamlScalar(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	if (Array.isArray(v)) return "[]";
	if (typeof v === "object") return "{}";
	const s = String(v);
	return needsQuote(s) ? JSON.stringify(s) : s;
}

// A map key gets the same quoting as a scalar value: an unquoted key containing
// `:`, `#`, a leading `-`, or the empty string re-parses as a different key (or,
// for the empty key, is lost entirely), so emit it quoted when needsQuote flags it.
function yamlKey(k: string): string {
	return needsQuote(k) ? JSON.stringify(k) : k;
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
					return `${pad}${yamlKey(k)}:\n${toYaml(val, indent + 1)}`;
				}
				return `${pad}${yamlKey(k)}: ${yamlScalar(val)}`;
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
	// Only coerce integers with no leading zeros (YAML 1.2 treats "01234" as a
	// string, so zip codes / phone fragments keep their zeros) and that survive
	// the round-trip through Number without losing precision.
	if (/^-?(0|[1-9]\d*)$/.test(s)) {
		const n = parseInt(s, 10);
		if (Number.isSafeInteger(n)) return n;
	}
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
				const mk = m[1].trim();
				// Always advance `i` past the value (parseBlock consumes child lines even
				// when discarded) so an unsafe key doesn't desync the parser position.
				if (m[2].trim() === "") {
					const v = parseBlock(childIndent);
					if (!UNSAFE_KEYS.has(mk)) obj[mk] = v;
				} else if (!UNSAFE_KEYS.has(mk)) obj[mk] = parseScalar(m[2]);
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
	// Split a `key: value` line into its key and the remaining value text. A
	// quoted key (emitted by toYaml when the key contains `:`, `#`, a leading `-`,
	// or is empty) is scanned to its matching close quote so an embedded `:` is not
	// mistaken for the key/value separator, then unquoted via parseScalar.
	function splitKey(line: string): { key: string; rest: string } | null {
		const body = line.slice(indentOf(line));
		const q = body[0];
		if (q === '"' || q === "'") {
			let j = 1;
			for (; j < body.length; j++) {
				if (q === '"' && body[j] === "\\") j++;
				else if (body[j] === q) {
					if (q === "'" && body[j + 1] === "'") j++;
					else break;
				}
			}
			const after = body.slice(j + 1).replace(/^\s*/, "");
			if (after[0] !== ":") return null;
			return { key: String(parseScalar(body.slice(0, j + 1))), rest: after.slice(1) };
		}
		const m = body.match(/^([^:]+?):\s*(.*)$/);
		return m ? { key: m[1].trim(), rest: m[2] } : null;
	}
	function mergeMap(obj: Record<string, unknown>, minIndent: number) {
		while (i < lines.length) {
			const line = lines[i];
			const ind = indentOf(line);
			if (ind < minIndent || /^\s*-(\s|$)/.test(line.slice(ind))) break;
			const kv = splitKey(line);
			if (!kv) break;
			i++;
			const key = kv.key;
			if (kv.rest.trim() === "") {
				// Zero-relative-indent sequences (kubernetes/GitHub-Actions style):
				// a `- ` item at the key's own indent belongs to the key.
				const next = lines[i];
				const seqAtKeyIndent = next !== undefined && indentOf(next) === ind && /^\s*-(\s|$)/.test(next);
				// Always advance `i` past the value, even for an unsafe key, so the parser
				// position doesn't desync — only the assignment into `obj` is skipped.
				const v = parseBlock(seqAtKeyIndent ? ind : ind + 1);
				if (!UNSAFE_KEYS.has(key)) obj[key] = v;
			} else if (!UNSAFE_KEYS.has(key)) obj[key] = parseScalar(kv.rest);
		}
	}
	return parseBlock(0);
}

// ---------- JSON <-> CSV (RFC4180-ish) ----------

export function parseCsv(text: string, delim: string): string[][] {
	const rows: string[][] = [];
	// Parallel to `rows`: true where the row had real syntax (a quote, delimiter,
	// or content) so a quoted-empty line `""` is kept while a truly blank line is
	// dropped by the trailing filter.
	const nonBlank: boolean[] = [];
	let row: string[] = [];
	let field = "";
	let inQ = false;
	let started = false;
	const pushField = () => {
		row.push(field);
		field = "";
	};
	const pushRow = () => {
		pushField();
		rows.push(row);
		nonBlank.push(started);
		row = [];
		started = false;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQ) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else inQ = false;
			} else field += c;
			continue;
		}
		if (c === '"') {
			inQ = true;
			started = true;
		} else if (c === delim) {
			pushField();
			started = true;
		} else if (c === "\n") {
			pushRow();
		} else if (c === "\r") {
			if (text[i + 1] !== "\n") pushRow();
		} else {
			field += c;
			started = true;
		}
	}
	if (started || field.length || row.length) pushRow();
	return rows.filter((r, i) => !(r.length === 1 && r[0] === "" && !nonBlank[i]));
}

/** CSV text -> array of row objects (first row = headers). */
export function csvToRows(text: string, delim: string): Record<string, string>[] {
	const rows = parseCsv(text, delim);
	if (!rows.length) return [];
	// Dedupe duplicate header names so Object.fromEntries doesn't silently
	// collapse repeated columns (last-column-wins). Repeats get an _N suffix:
	// [a, a, a] -> [a, a_2, a_3].
	const seen = new Map<string, number>();
	const headers = rows[0].map((h) => {
		const n = (seen.get(h) ?? 0) + 1;
		seen.set(h, n);
		return n === 1 ? h : `${h}_${n}`;
	});
	return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

export function toCsv(arr: unknown[], delim: string): string {
	if (!arr.length) return "";
	const headers = [...new Set(arr.flatMap((o) => (o && typeof o === "object" ? Object.keys(o as object) : [])))];
	const esc = (v: unknown): string => {
		let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
		// CSV formula injection: a string cell beginning with = + - @ (or a leading
		// TAB/CR) is evaluated as a formula when the file is opened in Excel/Sheets/
		// LibreOffice (DDE -> data exfiltration / command execution). Prefix such
		// string values with a single quote so the spreadsheet treats them as text.
		// Genuine numbers/booleans arrive non-string and are never neutralised.
		if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
		return new RegExp(`["${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	// Escape the header row too — a key containing the delimiter/quote/newline (e.g. "a,b")
	// would otherwise split into extra columns, misaligning every data row and breaking round-trip.
	const lines = [headers.map((h) => esc(h)).join(delim)];
	for (const o of arr) lines.push(headers.map((h) => esc((o as Record<string, unknown>)?.[h])).join(delim));
	return lines.join("\n");
}

// ---------- JSON <-> XML ----------

// decodeEntities lives in ./_markup — the same named+numeric decoder the HTML/
// Markdown converter and the retail scrapers use, so XML text/attribute decoding
// doesn't carry its own drifted copy.
function encodeEntities(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function attach(node: Record<string, unknown>, name: string, child: unknown) {
	if (UNSAFE_KEYS.has(name)) return;
	if (name in node) {
		const cur = node[name];
		if (Array.isArray(cur)) cur.push(child);
		else node[name] = [cur, child];
	} else node[name] = child;
}
function collapse(node: Record<string, unknown>): unknown {
	const keys = Object.keys(node);
	if (keys.length === 1 && keys[0] === "#text") return node["#text"];
	return node;
}

/** Find the `>` that closes the tag opened at `lt`, skipping any `>` that sits
 * inside a quoted attribute value (legal XML, e.g. `<a href="x>y">`). A bare
 * indexOf(">") would truncate the tag there, dropping the attribute and leaking
 * the remainder into the text node. */
function tagEnd(s: string, lt: number): number {
	let quote = "";
	for (let i = lt + 1; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === ">") {
			return i;
		}
	}
	return -1;
}

export function parseXml(xml: string): unknown {
	const src = xml
		.replace(/<\?[\s\S]*?\?>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!DOCTYPE[^>]*>/gi, "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c) => encodeEntities(c));
	const root: Record<string, unknown> = {};
	const nodes: Record<string, unknown>[] = [root];
	const names: string[] = [""];
	let pos = 0;
	while (pos < src.length) {
		const lt = src.indexOf("<", pos);
		if (lt === -1) break;
		const text = src.slice(pos, lt);
		if (text.trim()) {
			const top = nodes[nodes.length - 1];
			top["#text"] = ((top["#text"] as string) ?? "") + decodeEntities(text).trim();
		}
		const gt = tagEnd(src, lt);
		if (gt === -1) throw new Error("unterminated tag");
		let tag = src.slice(lt + 1, gt).trim();
		if (tag.startsWith("/")) {
			const closing = tag.slice(1).trim();
			if (nodes.length < 2) throw new Error(`unexpected closing tag </${closing}>`);
			const expected = names[names.length - 1];
			if (closing !== expected) throw new Error(`mismatched tag: expected </${expected}>, got </${closing}>`);
			const finished = nodes.pop()!;
			names.pop();
			attach(nodes[nodes.length - 1], expected, collapse(finished));
			pos = gt + 1;
			continue;
		}
		const selfClose = tag.endsWith("/");
		if (selfClose) tag = tag.slice(0, -1).trim();
		const name = tag.match(/^([\w:.-]+)/)?.[1];
		if (!name) throw new Error("malformed tag");
		const node: Record<string, unknown> = {};
		for (const a of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)) {
			const key = a[1] ?? a[3];
			const val = a[2] ?? a[4] ?? "";
			node["@" + key] = decodeEntities(val);
		}
		if (selfClose) {
			attach(nodes[nodes.length - 1], name, Object.keys(node).length ? node : "");
		} else {
			nodes.push(node);
			names.push(name);
		}
		pos = gt + 1;
	}
	if (nodes.length !== 1) throw new Error("unclosed tag(s)");
	return collapse(root);
}

export function toXml(obj: unknown, name?: string): string {
	if (obj === null || obj === undefined) return name ? `<${name}/>` : "";
	if (Array.isArray(obj)) return obj.map((v) => toXml(v, name)).join("");
	if (typeof obj === "object") {
		const entries = Object.entries(obj as Record<string, unknown>);
		const attrs = entries
			.filter(([k]) => k.startsWith("@"))
			// The value lands inside a double-quoted attribute; encodeEntities only
			// escapes &<>, so a value carrying a `"` (e.g. {"@id":'a"b'}) would close
			// the attribute early — emitting malformed XML that parseXml then reads
			// back truncated. Escape the quote too so the value round-trips intact.
			.map(([k, v]) => ` ${k.slice(1)}="${encodeEntities(String(v)).replace(/"/g, "&quot;")}"`)
			.join("");
		const inner = entries
			.filter(([k]) => !k.startsWith("@"))
			.map(([k, v]) => (k === "#text" ? encodeEntities(String(v)) : toXml(v, k)))
			.join("");
		if (!name) return inner;
		return inner === "" && attrs !== "" ? `<${name}${attrs}/>` : `<${name}${attrs}>${inner}</${name}>`;
	}
	const esc = encodeEntities(String(obj));
	return name ? `<${name}>${esc}</${name}>` : esc;
}

/** Parse any supported source string into a JS value (Julia-style: json() calls
 * this dispatching on the detected/declared source format). */
export function parseSource(data: string, from: Format, opts?: { delimiter?: string }): unknown {
	switch (from) {
		case "json":
			return JSON.parse(data);
		case "yaml":
			return parseYaml(data);
		case "csv":
			return csvToRows(data, (opts?.delimiter ?? ",").slice(0, 1) || ",");
		case "xml":
			return parseXml(data);
	}
}
