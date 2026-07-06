import { describe, expect, it } from "vitest";
import { plaintext } from "./plaintext";

const run = async (args: any) => {
	const r = await plaintext.run({} as any, args);
	return r;
};

describe("plaintext", () => {
	it("defonts and cleans by default", async () => {
		const r = await run({ text: "𝐇𝐞𝐥𝐥𝐨 Ｗｏｒｌｄ" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("Hello World");
	});

	it("honors form:none + defont:false to return verbatim", async () => {
		const r = await run({ text: "𝐇𝐢", form: "none", defont: false });
		expect(r.content[0].text).toBe("𝐇𝐢");
	});

	it("collapseWhitespace and trim when requested", async () => {
		const r = await run({ text: "  a    b  ", collapseWhitespace: true, trim: true });
		expect(r.content[0].text).toBe("a b");
	});

	it("rejects a bad form", async () => {
		const r = await run({ text: "x", form: "NFZ" });
		expect(r.isError).toBe(true);
	});

	it("rejects non-string text", async () => {
		const r = await run({ text: 5 });
		expect(r.isError).toBe(true);
	});

	it("is marked raw so the boundary does not double-normalize", () => {
		expect(plaintext.raw).toBe(true);
	});
});
