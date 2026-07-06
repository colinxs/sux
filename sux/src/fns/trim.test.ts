import { describe, expect, it } from "vitest";
import { trim } from "./trim";

const run = async (args: any) => (await trim.run({} as any, args)).content[0].text;
const err = async (args: any) => (await trim.run({} as any, args)).isError;

describe("trim", () => {
	it("removes N chars from the end by default", async () => {
		expect(await run({ text: "hello!!!", remove: 3 })).toBe("hello");
	});

	it("removes from the start", async () => {
		expect(await run({ text: ">>>hello", remove: 3, side: "start" })).toBe("hello");
	});

	it("removes from both ends", async () => {
		expect(await run({ text: "[[core]]", remove: 2, side: "both" })).toBe("core");
	});

	it("hard-limits to N chars without an ellipsis", async () => {
		expect(await run({ text: "abcdefgh", limit: 4 })).toBe("abcd");
		expect(await run({ text: "ab", limit: 4 })).toBe("ab");
	});

	it("trims document whitespace and finds edges by default", async () => {
		expect(await run({ text: "\n\n  hello world   \n\n\n" })).toBe("hello world");
	});

	it("strips trailing whitespace per line and drops blank edge lines", async () => {
		expect(await run({ text: "\n\nline one   \nline two\t\n\n" })).toBe("line one\nline two");
	});

	it("dedents common leading indentation when asked", async () => {
		expect(await run({ text: "    a\n      b\n    c", dedent: true })).toBe("a\n  b\nc");
	});

	it("side:start keeps leading blank lines off but leaves the tail; side:end vice versa", async () => {
		// Per-line trailing whitespace is always stripped; `side` governs the outer edge.
		expect(await run({ text: "\n\n  x\n\n", side: "start" })).toBe("x");
		expect(await run({ text: "  x", side: "start" })).toBe("x");
		expect(await run({ text: "  x", side: "end" })).toBe("  x");
	});

	it("rejects both remove and limit", async () => {
		expect(await err({ text: "x", remove: 1, limit: 1 })).toBe(true);
	});

	it("rejects a negative remove and non-string text", async () => {
		expect(await err({ text: "x", remove: -1 })).toBe(true);
		expect(await err({ text: 5 })).toBe(true);
	});
});
