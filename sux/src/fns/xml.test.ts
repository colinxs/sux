import { describe, expect, it } from "vitest";
import { xml } from "./xml";
import { json } from "./json";

const xrun = async (args: any) => (await xml.run({} as any, args)).content[0].text;
const jrun = async (args: any) => (await json.run({} as any, args)).content[0].text;

describe("xml (JSON -> XML)", () => {
	it("renders elements, attributes, and text", async () => {
		const out = await xrun({ data: '{"note":{"@id":"1","#text":"hi"}}' });
		expect(out).toBe('<note id="1">hi</note>');
	});

	it("repeats a tag for arrays and escapes entities", async () => {
		expect(await xrun({ data: '{"item":["a","b"]}' })).toBe("<item>a</item><item>b</item>");
		expect(await xrun({ data: '{"t":"a & b < c"}' })).toBe("<t>a &amp; b &lt; c</t>");
	});

	it("errors on invalid JSON", async () => {
		expect((await xml.run({} as any, { data: "<not-json>" })).isError).toBe(true);
	});

	it("accepts a real object (not just a pre-stringified JSON string)", async () => {
		expect(await xrun({ data: { note: { "#text": "hi" } } })).toBe("<note>hi</note>");
	});
});

describe("json from xml (dispatch + round-trip)", () => {
	it("parses xml to objects with @attr and arrays for repeats", async () => {
		const out = await jrun({ data: '<root><item id="1">a</item><item>b</item></root>', from: "xml" });
		expect(JSON.parse(out)).toEqual({ root: { item: [{ "@id": "1", "#text": "a" }, "b"] } });
	});

	it("auto-detects xml", async () => {
		expect(JSON.parse(await jrun({ data: "<a>1</a>" })).a).toBe("1");
	});

	it("xml(json(xml)) round-trips a simple document", async () => {
		const src = "<note><to>Ada</to><body>hi</body></note>";
		expect(await xrun({ data: await jrun({ data: src, from: "xml" }) })).toBe(src);
	});
});
