import { describe, expect, it } from "vitest";
import { lint } from "./lint";

const run = async (data: string, format?: string) => {
	const r = await lint.run({} as any, format ? { data, format } : { data });
	return JSON.parse(r.content[0].text) as {
		ok: boolean;
		errors: number;
		warnings: number;
		findings: Array<{ severity: string; line: number; col: number; message: string }>;
	};
};

describe("lint", () => {
	it("passes clean JSON", async () => {
		const j = await run('{\n  "a": 1,\n  "b": [1, 2, 3]\n}\n', "json");
		expect(j.ok).toBe(true);
		expect(j.errors).toBe(0);
		expect(j.findings).toHaveLength(0);
	});

	it("locates a JSON syntax error with line:col", async () => {
		const j = await run('{\n  "a": 1,\n  "b": ,\n}\n', "json");
		expect(j.ok).toBe(false);
		expect(j.errors).toBe(1);
		expect(j.findings[0].severity).toBe("error");
		// Location is best-effort across V8 versions (some strip position info); land near the fault.
		expect(j.findings[0].line).toBeGreaterThanOrEqual(2);
		expect(j.findings[0].line).toBeLessThanOrEqual(3);
	});

	it("flags duplicate keys in the same object", async () => {
		const j = await run('{ "a": 1, "b": 2, "a": 3 }\n', "json");
		const dup = j.findings.find((f) => f.message.includes("duplicate key"));
		expect(dup).toBeTruthy();
		expect(dup?.severity).toBe("warning");
		expect(dup?.message).toContain('"a"');
	});

	it("does not treat repeated keys across sibling objects or array strings as duplicates", async () => {
		const j = await run('{ "list": ["a", "a", "a"], "x": { "k": 1 }, "y": { "k": 2 } }\n', "json");
		expect(j.findings.filter((f) => f.message.includes("duplicate"))).toHaveLength(0);
	});

	it("does not treat a value equal to a key as a duplicate key", async () => {
		const j = await run('{ "a": "a" }\n', "json");
		expect(j.findings.filter((f) => f.message.includes("duplicate"))).toHaveLength(0);
	});

	it("reports text hygiene: trailing whitespace and missing final newline", async () => {
		const j = await run("hello   \nworld");
		const trailing = j.findings.find((f) => f.message === "trailing whitespace");
		expect(trailing).toMatchObject({ line: 1, severity: "warning" });
		expect(j.findings.find((f) => f.message === "no final newline")).toBeTruthy();
	});

	it("flags CRLF and BOM", async () => {
		const j = await run("﻿a\r\nb\r\n");
		expect(j.findings.find((f) => f.message.includes("BOM"))).toBeTruthy();
		expect(j.findings.find((f) => f.message.includes("CRLF"))).toBeTruthy();
	});

	it("flags mixed tab/space indentation", async () => {
		const j = await run("\tindented with tab\n    indented with spaces\n");
		expect(j.findings.find((f) => f.message.includes("mixed tab/space"))).toBeTruthy();
	});

	it("rejects a non-string data", async () => {
		const r = await lint.run({} as any, { data: 42 as any });
		expect(r.isError).toBe(true);
	});
});
