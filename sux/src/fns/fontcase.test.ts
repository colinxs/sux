import { describe, expect, it } from "vitest";
import { fontcase } from "./fontcase";

const run = (args: any) => fontcase.run({} as any, args);
const out = async (args: any) => (await run(args)).content[0].text;

describe("fontcase", () => {
	it("is raw so unicode-font output survives the MCP boundary", () => {
		expect(fontcase.raw).toBe(true);
		expect(fontcase.cacheable).toBe(true);
	});

	it("maps ASCII to bold unicode", async () => {
		expect(await out({ text: "Ab1", to: "bold" })).toBe("\u{1D400}\u{1D41B}\u{1D7CF}");
	});

	it("round-trips ASCII -> bold -> from:bold back to ASCII", async () => {
		const bold = await out({ text: "Hello World 42", to: "bold" });
		expect(bold).not.toBe("Hello World 42");
		const back = await out({ text: bold, to: "lower", from: "bold" });
		expect(back).toBe("hello world 42");
	});

	it("round-trips through several font styles back to ASCII", async () => {
		for (const style of ["italic", "fraktur", "double_struck", "monospace", "fullwidth"]) {
			const styled = await out({ text: "Test", to: style });
			expect(styled).not.toBe("Test");
			expect(await out({ text: styled, to: "upper", from: style })).toBe("TEST");
		}
	});

	it("produces distinct output for at least three font styles", async () => {
		const fraktur = await out({ text: "abc", to: "fraktur" });
		const sans = await out({ text: "abc", to: "sans" });
		const circled = await out({ text: "abc", to: "circled" });
		expect(fraktur).toBe("\u{1D51E}\u{1D51F}\u{1D520}");
		expect(sans).toBe("\u{1D5BA}\u{1D5BB}\u{1D5BC}");
		expect(circled).toBe("ⓐⓑⓒ");
	});

	it("small_caps maps lowercase", async () => {
		expect(await out({ text: "abc", to: "small_caps" })).toBe("ᴀʙᴄ");
	});

	it("handles every case family", async () => {
		const src = "hello world-example_test";
		expect(await out({ text: src, to: "lower" })).toBe("hello world-example_test");
		expect(await out({ text: src, to: "upper" })).toBe("HELLO WORLD-EXAMPLE_TEST");
		expect(await out({ text: src, to: "title" })).toBe("Hello World Example Test");
		expect(await out({ text: "hello world", to: "sentence" })).toBe("Hello world");
		expect(await out({ text: src, to: "snake" })).toBe("hello_world_example_test");
		expect(await out({ text: src, to: "kebab" })).toBe("hello-world-example-test");
		expect(await out({ text: src, to: "camel" })).toBe("helloWorldExampleTest");
		expect(await out({ text: src, to: "pascal" })).toBe("HelloWorldExampleTest");
		expect(await out({ text: src, to: "constant" })).toBe("HELLO_WORLD_EXAMPLE_TEST");
		expect(await out({ text: src, to: "dot" })).toBe("hello.world.example.test");
		expect(await out({ text: src, to: "path" })).toBe("hello/world/example/test");
	});

	it("splits camelCase and PascalCase into words", async () => {
		expect(await out({ text: "helloWorldHTTPServer", to: "snake" })).toBe("hello_world_http_server");
	});

	it("leaves unmapped characters unchanged in font styles", async () => {
		expect(await out({ text: "a-b", to: "bold" })).toBe("\u{1D41A}-\u{1D41B}");
	});

	it("maps reserved-hole letters to Letterlike Symbols, not unassigned code points", async () => {
		expect(await out({ text: "h", to: "italic" })).toBe("\u{210E}");
		expect(await out({ text: "Hello", to: "script" })).toBe(
			"\u{210B}\u{212F}\u{1D4C1}\u{1D4C1}\u{2134}",
		);
		expect(await out({ text: "CHRIZ", to: "fraktur" })).toBe(
			"\u{212D}\u{210C}\u{211C}\u{2111}\u{2128}",
		);
		expect(await out({ text: "RNZ", to: "double_struck" })).toBe(
			"\u{211D}\u{2115}\u{2124}",
		);
	});

	it("fails on unknown to", async () => {
		const r = await run({ text: "x", to: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown to/);
	});
});
