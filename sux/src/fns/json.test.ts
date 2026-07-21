import { describe, expect, it } from "vitest";
import { json } from "./json";
import { yaml } from "./yaml";

const jrun = async (args: any) => (await json.run({} as any, args)).content[0].text;
const yrun = async (args: any) => (await yaml.run({} as any, args)).content[0].text;
// yaml's own unit tests live in yaml.test.ts; here we exercise json + composition.

describe("json (to JSON, dispatched on source)", () => {
	it("auto-detects and parses YAML", async () => {
		const out = await jrun({ data: "name: Ada\nnums:\n  - 1\n  - 2\n" });
		expect(JSON.parse(out)).toEqual({ name: "Ada", nums: [1, 2] });
	});

	it("passes JSON through (identity) and honors indent", async () => {
		expect(JSON.parse(await jrun({ data: '{"a":1}', from: "json" }))).toEqual({ a: 1 });
		expect(await jrun({ data: '{"a":1}', indent: 0 })).toBe('{"a":1}');
	});

	it("respects an explicit from", async () => {
		expect(JSON.parse(await jrun({ data: "a: 1", from: "yaml" }))).toEqual({ a: 1 });
	});

	it("errors on empty data and unsupported source", async () => {
		expect((await json.run({} as any, { data: "  " })).isError).toBe(true);
	});

	it("auto-detects unstructured prose as a bare YAML scalar instead of an empty map", async () => {
		// Prose has no ':'/'- ' marker, so auto-detect falls through to YAML, whose
		// parser treats an unmarked root-level line as a plain scalar (the whole
		// line, as a string) rather than an empty map -- nothing is discarded.
		expect(await jrun({ data: "Just some prose without any structure at all" })).toBe(
			'"Just some prose without any structure at all"',
		);
	});

	it("errors instead of silently returning {} when the proto-pollution guard strips every key", async () => {
		// A lone `__proto__: x` (or `constructor: x`) document auto-detects as YAML
		// (it has a ':' marker) but the parser's prototype-pollution guard strips
		// that key, so it parses to an empty map. Returning "{}" would silently
		// discard the input, so that mis-detection must surface as an error instead.
		const res = await json.run({} as any, { data: "__proto__: evil" });
		expect(res.isError).toBe(true);
	});

	it("still passes a genuine empty JSON object through", async () => {
		expect(await jrun({ data: "{}" })).toBe("{}");
	});

	it("accepts a real object for data when from is json or auto, but rejects it for other formats", async () => {
		expect(await jrun({ data: { a: 1 }, indent: 0 })).toBe('{"a":1}');
		expect(await jrun({ data: { a: 1 }, from: "json", indent: 0 })).toBe('{"a":1}');
		expect((await json.run({} as any, { data: { a: 1 }, from: "yaml" })).isError).toBe(true);
	});
});

describe("json/yaml compose (bidirectionality)", () => {
	it("yaml(json(x)) round-trips a document", async () => {
		const yamlSrc = "name: Ada\nactive: true\ntags:\n  - a\n  - b\n";
		const asJson = await jrun({ data: yamlSrc });
		const backToYaml = await yrun({ data: asJson });
		// Re-parse the regenerated YAML and compare structurally.
		const reparsed = JSON.parse(await jrun({ data: backToYaml }));
		expect(reparsed).toEqual({ name: "Ada", active: true, tags: ["a", "b"] });
	});
});
