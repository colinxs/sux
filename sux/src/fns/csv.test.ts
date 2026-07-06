import { describe, expect, it } from "vitest";
import { csv } from "./csv";
import { json } from "./json";

const crun = async (args: any) => (await csv.run({} as any, args)).content[0].text;
const jrun = async (args: any) => (await json.run({} as any, args)).content[0].text;

describe("csv (JSON array -> CSV)", () => {
	it("writes a header row plus data rows", async () => {
		const out = await crun({ data: '[{"a":1,"b":"x"},{"a":2,"b":"y"}]' });
		expect(out).toBe("a,b\n1,x\n2,y");
	});

	it("quotes fields containing the delimiter or quotes", async () => {
		const out = await crun({ data: '[{"a":"x,y","b":"he said \\"hi\\""}]' });
		expect(out).toContain('"x,y"');
		expect(out).toContain('"he said ""hi"""');
	});

	it("supports a custom delimiter and rejects non-arrays", async () => {
		expect(await crun({ data: '[{"a":1,"b":2}]', delimiter: ";" })).toBe("a;b\n1;2");
		expect((await csv.run({} as any, { data: '{"a":1}' })).isError).toBe(true);
	});
});

describe("json from csv (dispatch + round-trip)", () => {
	it("parses csv to row objects", async () => {
		const out = await jrun({ data: "a,b\n1,x\n2,y", from: "csv" });
		expect(JSON.parse(out)).toEqual([{ a: "1", b: "x" }, { a: "2", b: "y" }]);
	});

	it("auto-detects csv", async () => {
		const out = await jrun({ data: "name,age\nAda,36\n" });
		expect(JSON.parse(out)).toEqual([{ name: "Ada", age: "36" }]);
	});

	it("csv(json(csv)) round-trips", async () => {
		const src = "a,b\n1,x\n2,y";
		expect(await crun({ data: await jrun({ data: src, from: "csv" }) })).toBe(src);
	});
});
