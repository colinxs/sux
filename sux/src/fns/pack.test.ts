import { describe, expect, it } from "vitest";
import { pack } from "./pack";

const run = (args: any) => pack.run({} as any, args);

describe("pack", () => {
	it("rejects data that is not an array of objects", async () => {
		expect((await run({ data: "nope" })).isError).toBe(true);
		const scalars = await run({ data: [1, 2, 3] });
		expect(scalars.isError).toBe(true);
		expect(scalars.content[0].text).toMatch(/array of objects/);
	});

	it("packs records as TSV with a single header row", async () => {
		const r = await run({ data: [{ a: 1, b: "x" }, { a: 2, b: "y" }] });
		expect(r.isError).toBeFalsy();
		const lines = r.content[0].text.split("\n");
		expect(lines[0]).toBe("a\tb");
		expect(lines[1]).toBe("1\tx");
		expect(lines[2]).toBe("2\ty");
		expect(r.content[0].text).toMatch(/\[packed 2 records as tsv/);
	});

	it("omits the savings note when note:false", async () => {
		const r = await run({ data: [{ a: 1, b: "x" }, { a: 2, b: "y" }], note: false });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("a\tb\n1\tx\n2\ty");
		expect(r.content[0].text).not.toMatch(/\[packed/);
	});

	it("handles a heterogeneous key union and csv/kv formats", async () => {
		const csv = await run({ data: [{ a: 1 }, { b: "has,comma" }], format: "csv" });
		const head = csv.content[0].text.split("\n")[0];
		expect(head).toBe("a,b");
		expect(csv.content[0].text).toContain('"has,comma"');
		const kv = await run({ data: [{ a: 1, b: "" }], format: "kv" });
		// Empty fields are dropped in kv form.
		expect(kv.content[0].text.startsWith("a=1")).toBe(true);
		expect(kv.content[0].text).not.toMatch(/^b=/m);
	});

	it("returns a friendly marker for an empty array", async () => {
		const r = await run({ data: [] });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("(empty array)");
	});
});
