import { describe, expect, it, vi } from "vitest";

// `seen` must be hoisted so the vi.mock factory (also hoisted) can close over it.
const seen = vi.hoisted(() => ({ args: [] as any[] }));

// Stub FUNCTIONS with a few deterministic tools so we test pipe's plumbing,
// not real fns. `echo` returns its `text`; `upper` uppercases {{prev}}; `jsonify`
// emits JSON; `boom` errors; `throws` throws; `dump`/`rawdump` echo their args as
// JSON (non-raw vs raw); `spy` records the args it received and emits text with
// a zero-width space.
vi.mock("./index", () => ({
	FUNCTIONS: [
		{ name: "echo", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: String(a.text ?? "") }] }) },
		{ name: "upper", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: String(a.text ?? "").toUpperCase() }] }) },
		{ name: "jsonify", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify({ title: a.text, n: 2 }) }] }) },
		{ name: "boom", run: async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }) },
		{ name: "bigboom", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: String(a.text ?? "") }], isError: true }) },
		{
			name: "throws",
			run: async () => {
				throw new Error("exploded");
			},
		},
		{ name: "dump", run: async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify(a) }] }) },
		{ name: "rawdump", raw: true, run: async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify(a) }] }) },
		{
			name: "spy",
			run: async (_e: any, a: any) => {
				seen.args.push(a);
				return { content: [{ type: "text", text: "x\u200By" }] };
			},
		},
	],
}));

import { batch } from "./batch";
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

	it("catches a throwing tool and reports a structured stopped_at", async () => {
		const r = await out([{ tool: "echo", args: { text: "a" } }, { tool: "throws" }]);
		expect(r.output).toBeNull();
		expect(r.stopped_at).toBe(1);
		expect(r.steps).toHaveLength(2);
		expect(r.steps[1]).toMatchObject({ step: 1, tool: "throws", ok: false, error: "exploded" });
	});

	it("rejects unknown tools, self-recursion, and nested batch", async () => {
		expect((await pipe.run({} as any, { steps: [{ tool: "nope" }] })).content[0].text).toMatch(/unknown tool/);
		expect((await pipe.run({} as any, { steps: [{ tool: "pipe" }] })).content[0].text).toMatch(/refusing/);
		expect((await pipe.run({} as any, { steps: [{ tool: "batch" }] })).content[0].text).toMatch(/refusing/);
		expect((await pipe.run({} as any, { steps: [] })).isError).toBe(true);
	});

	it("rejects more than 25 steps (amplification cap) but accepts exactly 25", async () => {
		const step = { tool: "echo", args: { text: "x" } };
		const over = await pipe.run({} as any, { steps: Array.from({ length: 26 }, () => step) });
		expect(over.isError).toBe(true);
		expect(over.content[0].text).toMatch(/Too many steps: 26 \(max 25/);
		const at = await pipe.run({} as any, { steps: Array.from({ length: 25 }, () => step) });
		expect(at.isError).toBeFalsy();
		expect(JSON.parse(at.content[0].text).steps).toHaveLength(25);
	});

	it("leaves args without tokens untouched", async () => {
		const r = await out([{ tool: "echo", args: { text: "literal {{ not a token" } }]);
		expect(r.output).toBe("literal {{ not a token");
	});

	it("substitutes {{prev}} inside nested objects and arrays", async () => {
		const r = await out([
			{ tool: "echo", args: { text: "https://x.test/a" } },
			{ tool: "dump", args: { sources: [{ url: "{{prev}}" }], meta: { note: "from {{prev}}" } } },
		]);
		const got = JSON.parse(r.output);
		expect(got.sources[0].url).toBe("https://x.test/a");
		expect(got.meta.note).toBe("from https://x.test/a");
	});

	it("substitutes {{prev.path}} into nested args", async () => {
		const r = await out([
			{ tool: "jsonify", args: { text: "Doc" } },
			{ tool: "dump", args: { fields: { title: "{{prev.title}}" }, tags: ["n={{prev.n}}"] } },
		]);
		const got = JSON.parse(r.output);
		expect(got.fields.title).toBe("Doc");
		expect(got.tags[0]).toBe("n=2");
	});

	it("substitutes an embedded {{prev}} inside a longer string", async () => {
		const r = await out([{ tool: "echo", args: { text: "world" } }, { tool: "echo", args: { text: "Summary: {{prev}}" } }]);
		expect(r.output).toBe("Summary: world");
	});

	it("substitutes '' for {{prev.path}} when prev is not JSON", async () => {
		const r = await out([{ tool: "echo", args: { text: "not json" } }, { tool: "echo", args: { text: "[{{prev.title}}]" } }]);
		expect(r.output).toBe("[]");
	});

	it("normalizes args and output for non-raw steps (boundary parity)", async () => {
		seen.args.length = 0;
		const r = await out([{ tool: "spy", args: { text: "a\u200Bb\uFEFFc" } }]);
		expect(seen.args[0].text).toBe("abc"); // ZWSP/BOM stripped before a non-raw fn sees them
		expect(r.output).toBe("xy"); // spy emits "x\u200By"; close-side normalization strips it
		expect(r.steps[0].text).toBe("xy");
	});

	it("leaves raw fns byte-exact: no arg or output normalization", async () => {
		const r = await out([{ tool: "rawdump", args: { data: "a\u200Bb", nested: ["\uFEFFc"] } }]);
		const got = JSON.parse(r.output);
		expect(got.data).toBe("a\u200Bb");
		expect(got.nested[0]).toBe("\uFEFFc");
	});

	it("truncates intermediate step texts to a preview while output keeps the full final text", async () => {
		const big = "z".repeat(2_000);
		const r = await out([{ tool: "echo", args: { text: big } }, { tool: "upper", args: { text: "{{prev}}" } }]);
		// steps[] carries previews only…
		expect(r.steps[0].text.length).toBeLessThan(600);
		expect(r.steps[0].text).toContain("truncated at 500 bytes");
		expect(r.steps[0].text.startsWith("z".repeat(500))).toBe(true);
		// …but the full text still threads through {{prev}} and lands in output.
		expect(r.output).toBe("Z".repeat(2_000));
	});

	it("keeps failed-step error text in full (no preview clamp)", async () => {
		const bigErr = "e".repeat(1_500);
		const r = await out([{ tool: "echo", args: { text: bigErr } }, { tool: "bigboom", args: { text: "{{prev}}" } }]);
		expect(r.steps[1].error).toBe(bigErr);
	});

	it("parses prev as JSON at most once per step across many token-bearing strings", async () => {
		const parse = vi.spyOn(JSON, "parse");
		try {
			const raw = await pipe.run({} as any, {
				steps: [
					{ tool: "jsonify", args: { text: "Doc" } },
					{ tool: "dump", args: { a: "{{prev.title}}", b: "n={{prev.n}}", nested: { c: "{{prev.title}}/{{prev.n}}" } } },
				],
			});
			// Only the {{prev.path}} substitution parses prev — once, shared step-wide.
			const prevParses = parse.mock.calls.filter(([s]) => s === '{"title":"Doc","n":2}');
			expect(prevParses).toHaveLength(1);
			const r = JSON.parse(raw.content[0].text);
			const got = JSON.parse(r.output);
			expect(got.a).toBe("Doc");
			expect(got.b).toBe("n=2");
			expect(got.nested.c).toBe("Doc/2");
		} finally {
			parse.mockRestore();
		}
	});

	it("is itself raw (like batch) so index.ts leaves composed byte-exact data alone", () => {
		expect(pipe.raw).toBe(true);
		expect(batch.raw).toBe(true);
	});
});
