import { describe, expect, it } from "vitest";
import { csvToRows, detectFormat, parseCsv, parseXml, parseYaml, toCsv, toXml, toYaml } from "./_convert";

describe("parseYaml (zero-indent sequences under a mapping key)", () => {
	it("parses a sequence at the same indent as its key", () => {
		expect(parseYaml("key:\n- a\n- b")).toEqual({ key: ["a", "b"] });
	});

	it("preserves sibling keys after a zero-indent sequence (GitHub-Actions style)", () => {
		expect(parseYaml("on:\n- push\nname: ci")).toEqual({ on: ["push"], name: "ci" });
	});

	it("handles nested zero-relative-indent sequences (kubernetes style)", () => {
		const doc = "spec:\n  containers:\n  - name: app\n    image: nginx\n  restartPolicy: Always";
		expect(parseYaml(doc)).toEqual({
			spec: { containers: [{ name: "app", image: "nginx" }], restartPolicy: "Always" },
		});
	});

	it("still parses indented sequences and empty-value keys as before", () => {
		expect(parseYaml("key:\n  - a\n  - b")).toEqual({ key: ["a", "b"] });
		expect(parseYaml("key:\nnext: 1")).toEqual({ key: {}, next: 1 });
	});
});

describe("parseYaml (leading-zero and oversized integers stay strings)", () => {
	it("keeps a leading-zero token like a zip code as a string", () => {
		expect(parseYaml("zip: 01234")).toEqual({ zip: "01234" });
	});

	it("still coerces plain integers, zero, and negatives", () => {
		expect(parseYaml("a: 1234\nb: 0\nc: -42")).toEqual({ a: 1234, b: 0, c: -42 });
	});

	it("leaves integers beyond safe-integer range as strings to avoid precision loss", () => {
		expect(parseYaml("id: 123456789012345678901")).toEqual({ id: "123456789012345678901" });
	});
});

describe("parseYaml (prototype pollution)", () => {
	it("drops a top-level __proto__ key instead of polluting the returned object's prototype", () => {
		const out: any = parseYaml("a: x\n__proto__:\n  polluted: true");
		expect(out).toEqual({ a: "x" });
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("drops a nested constructor key while still parsing sibling keys correctly", () => {
		const out: any = parseYaml("outer:\n  constructor:\n    polluted: true\n  b: y\nafter: z");
		expect(out).toEqual({ outer: { b: "y" }, after: "z" });
	});

	it("drops an inline __proto__ key (key: value on one line)", () => {
		const out: any = parseYaml("__proto__: polluted\nb: y");
		expect(out).toEqual({ b: "y" });
	});
});

describe("detectFormat (bare scalars and header-only CSV don't degrade to yaml)", () => {
	it("detects a bare JSON scalar as json instead of yaml (which parseYaml maps to {})", () => {
		expect(detectFormat("42")).toBe("json");
		expect(detectFormat('"hi"')).toBe("json");
		expect(detectFormat("true")).toBe("json");
		expect(detectFormat("null")).toBe("json");
	});

	it("detects a header-only / single-line CSV without a trailing newline as csv", () => {
		expect(detectFormat("a,b,c")).toBe("csv");
	});

	it("still detects genuine yaml and json objects", () => {
		expect(detectFormat("name: Ada")).toBe("yaml");
		expect(detectFormat('{"a":1}')).toBe("json");
		expect(detectFormat("a,b\n1,2\n")).toBe("csv");
	});
});

describe("toYaml (multiline strings)", () => {
	it("quotes strings containing newlines so the output stays valid YAML", () => {
		const y = toYaml({ note: "line1\nline2" });
		expect(y).toBe('note: "line1\\nline2"');
	});

	it("round-trips strings with \\n, \\r and \\t", () => {
		const obj = { note: "line1\nline2", crlf: "a\r\nb", tabbed: "a\tb" };
		expect(parseYaml(toYaml(obj))).toEqual(obj);
	});
});

describe("toYaml (map-key quoting)", () => {
	it("quotes a key containing a colon so it can't be re-split into key/value", () => {
		expect(toYaml({ "a: b": 1 })).toBe('"a: b": 1');
		expect(parseYaml(toYaml({ "a: b": 1 }))).toEqual({ "a: b": 1 });
	});

	it("quotes the empty key so it isn't silently dropped", () => {
		expect(toYaml({ "": 1 })).toBe('"": 1');
		expect(parseYaml(toYaml({ "": 1 }))).toEqual({ "": 1 });
	});

	it("round-trips keys with '#', a leading '-', and a nested quoted key", () => {
		const obj = { "a#b": "x", "-lead": "y", "k: 1": { "c: d": 2 } };
		expect(parseYaml(toYaml(obj))).toEqual(obj);
	});
});

describe("toXml (attribute-value escaping)", () => {
	it("escapes a double quote in an attribute value so it can't close the attribute early", () => {
		// A `"` in an @attr value would otherwise emit `<n id="a"b">…` — malformed
		// XML whose attribute parseXml then reads back truncated to `a`.
		const xml = toXml({ n: { "@id": 'a"b', "#text": "hi" } });
		expect(xml).toBe('<n id="a&quot;b">hi</n>');
		expect(xml).not.toContain('id="a"b"');
	});

	it("round-trips an attribute value containing a quote through parseXml", () => {
		const obj = { n: { "@id": 'a"b', "#text": "hi" } };
		expect(parseXml(toXml(obj))).toEqual(obj);
	});
});

describe("parseXml (`>` inside a quoted attribute value)", () => {
	it("does not truncate the tag at a `>` sitting inside a double-quoted attribute", () => {
		// A bare indexOf(">") ends the tag at `a>`, dropping the attribute and
		// leaking `b">text` into the text node. The scan must skip quoted regions.
		expect(parseXml('<tag attr="a>b">text</tag>')).toEqual({ tag: { "@attr": "a>b", "#text": "text" } });
	});

	it("handles `>` inside a single-quoted attribute value", () => {
		expect(parseXml("<tag attr='x>y'/>")).toEqual({ tag: { "@attr": "x>y" } });
	});
});

describe("parseXml (prototype pollution)", () => {
	it("drops a __proto__ element instead of polluting the parent node's prototype", () => {
		const out: any = parseXml("<root><__proto__><polluted>true</polluted></__proto__><b>y</b></root>");
		expect(out).toEqual({ root: { b: "y" } });
		expect(Object.getPrototypeOf(out.root ?? out)).toBe(Object.prototype);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("drops a self-closing __proto__ element", () => {
		expect(parseXml("<root><__proto__/><b>y</b></root>")).toEqual({ root: { b: "y" } });
	});
});

describe("parseCsv (quoted-empty vs truly-blank rows)", () => {
	it("keeps a row that is an explicitly quoted single empty field", () => {
		// The blank-row filter must drop a bare `\n` line but keep `""`, which is a
		// deliberately empty single-column field.
		expect(parseCsv('a\n""\nb\n', ",")).toEqual([["a"], [""], ["b"]]);
	});

	it("still drops a truly blank line", () => {
		expect(parseCsv("a\n\nb\n", ",")).toEqual([["a"], ["b"]]);
	});
});

describe("csvToRows (duplicate header names)", () => {
	it("suffixes repeated headers instead of collapsing them", () => {
		// Two columns named `a` must not collapse to one; the second becomes `a_2`.
		expect(csvToRows("a,a\n1,2\n", ",")).toEqual([{ a: "1", a_2: "2" }]);
	});
});

describe("toCsv (spreadsheet formula-injection guard)", () => {
	it("prefixes a leading =/+/-/@ string cell with a quote so it can't execute as a formula", () => {
		// Opened in Excel/Sheets/LibreOffice, a cell starting with =, +, -, @, or a
		// leading tab/CR is evaluated as a formula (DDE -> exfiltration/RCE). A
		// prefixed single quote forces it to be read as literal text.
		const csv = toCsv([{ cmd: "=cmd()" }], ",");
		expect(csv).toBe("cmd\n'=cmd()");
	});

	it("leaves a genuine number (non-string) un-neutralized", () => {
		const csv = toCsv([{ n: -5 }], ",");
		expect(csv).toBe("n\n-5");
	});
});
