import { describe, expect, it, vi } from "vitest";

// Stub FUNCTIONS with a few deterministic tools so we test pipe's plumbing,
// not real fns. `echo` returns its `text`; `upper` uppercases {{prev}}; `jsonify`
// emits JSON; `boom` errors.
vi.mock("./index", () => ({
	FUNCTIONS: [
		{ name: "echo", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: String(a.text ?? "") }] }) },
		{ name: "upper", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: String(a.text ?? "").toUpperCase() }] }) },
		{ name: "jsonify", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify({ title: a.text, n: 2 }) }] }) },
		{ name: "boom", run: async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }) },
	],
}));

import { pipe } from "./pipe";

const out = async (steps: any[]) => JSON.parse((await pipe.run({} as any, { steps })).content[0].text);

describe("pipe", () => {
	it("threads {{prev}} from one step's output into the next", async () => {
		const r = await out([{ tool: "echo", args: { text: "hi" } }, { tool: "upper", args: { text: "{{prev}}" } }]);
		expect(r.output).toBe("HI");
		expect(r.steps).toHaveLength(2);
		expect(r.steps[1].ok).toBe(true);
	});

	it("pulls a field with {{prev.path}} when the prior output is JSON", async () => {
		const r = await out([{ tool: "jsonify", args: { text: "Doc" } }, { tool: "upper", args: { text: "{{prev.title}}" } }]);
		expect(r.output).toBe("DOC");
	});

	it("stops at the first failing step and reports where", async () => {
		const r = await out([{ tool: "echo", args: { text: "a" } }, { tool: "boom" }, { tool: "upper", args: { text: "{{prev}}" } }]);
		expect(r.output).toBeNull();
		expect(r.stopped_at).toBe(1);
		expect(r.steps).toHaveLength(2);
		expect(r.steps[1].ok).toBe(false);
	});

	it("rejects unknown tools and self-recursion", async () => {
		expect((await pipe.run({} as any, { steps: [{ tool: "nope" }] })).content[0].text).toMatch(/unknown tool/);
		expect((await pipe.run({} as any, { steps: [{ tool: "pipe" }] })).content[0].text).toMatch(/refusing/);
		expect((await pipe.run({} as any, { steps: [] })).isError).toBe(true);
	});

	it("leaves args without tokens untouched", async () => {
		const r = await out([{ tool: "echo", args: { text: "literal {{ not a token" } }]);
		expect(r.output).toBe("literal {{ not a token");
	});
});
