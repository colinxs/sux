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

	it("escapes a header key that contains the delimiter (no column misalignment)", async () => {
		const out = await crun({ data: '[{"a,b":1,"c":2}]' });
		expect(out).toBe('"a,b",c\n1,2'); // 2-column header over a 2-column row, round-trippable
	});

	it("supports a custom delimiter and rejects non-arrays", async () => {
		expect(await crun({ data: '[{"a":1,"b":2}]', delimiter: ";" })).toBe("a;b\n1;2");
		expect((await csv.run({} as any, { data: '{"a":1}' })).isError).toBe(true);
	});

	it("neutralizes spreadsheet formula-injection prefixes on string cells", async () => {
		const out = await crun({
			data: '[{"eq":"=cmd|\'/c calc\'!A0","at":"@SUM(1)","plus":"+1","minus":"-2+3","tab":"\\tx"}]',
		});
		// each dangerous string cell gains a leading single quote so Excel/Sheets treats it as text.
		expect(out).toContain("'=cmd|'");
		expect(out).toContain("'@SUM(1)");
		expect(out).toContain("'+1");
		expect(out).toContain("'-2+3");
		expect(out).toContain("'\tx");
	});

	it("leaves genuine numeric (non-string) values untouched", async () => {
		expect(await crun({ data: '[{"n":-5}]' })).toBe("n\n-5");
	});

	it("rejects scalar or mixed arrays instead of emitting blank rows", async () => {
		expect((await csv.run({} as any, { data: '["a","b"]' })).isError).toBe(true);
		expect((await csv.run({} as any, { data: '[{"a":1},"stray"]' })).isError).toBe(true);
		expect((await csv.run({} as any, { data: "[1,2,3]" })).isError).toBe(true);
	});

	it("accepts a real array (not just a pre-stringified JSON string)", async () => {
		expect(await crun({ data: [{ a: 1, b: "x" }] })).toBe("a,b\n1,x");
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
