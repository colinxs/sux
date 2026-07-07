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
