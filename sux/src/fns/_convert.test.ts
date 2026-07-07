import { describe, expect, it } from "vitest";
import { detectFormat, parseXml, parseYaml, toXml, toYaml } from "./_convert";

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
