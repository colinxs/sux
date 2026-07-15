import { describe, expect, it } from "vitest";
import { yaml } from "./yaml";

const yrun = async (args: any) => (await yaml.run({} as any, args)).content[0].text;

describe("yaml (JSON to YAML)", () => {
	it("serializes objects and arrays", async () => {
		const y = await yrun({ data: '{"name":"Ada","nums":[1,2]}' });
		expect(y).toContain("name: Ada");
		expect(y).toContain("- 1");
	});

	it("quotes values that would otherwise parse as non-strings", async () => {
		const y = await yrun({ data: '{"v":"true","n":"42"}' });
		expect(y).toContain('v: "true"');
		expect(y).toContain('n: "42"');
	});

	it("renders empty containers and errors on invalid JSON", async () => {
		expect(await yrun({ data: '{"a":[],"b":{}}' })).toContain("a: []");
		expect((await yaml.run({} as any, { data: "not json" })).isError).toBe(true);
	});

	it("accepts a real object (not just a pre-stringified JSON string)", async () => {
		expect(await yrun({ data: { name: "Ada" } })).toContain("name: Ada");
	});
});
