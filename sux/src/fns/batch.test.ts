import { describe, expect, it } from "vitest";
import { batch } from "./batch";

// batch dynamically imports ./index (the full registry). We drive it with
// `hash` — a pure, network-free tool — so the test stays hermetic.

describe("batch", () => {
	it("rejects an unknown tool", async () => {
		const r = await batch.run({} as any, { tool: "does_not_exist", calls: [{}] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown tool/);
	});

	it("runs a tool over many argument sets", async () => {
		const r = await batch.run({} as any, {
			tool: "hash",
			calls: [{ text: "a" }, { text: "b" }],
		});
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.tool).toBe("hash");
		expect(out.results).toHaveLength(2);
		expect(out.results[0].ok).toBe(true);
		expect(out.results[0].text).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
		expect(out.results[1].ok).toBe(true);
		expect(out.results[0].text).not.toBe(out.results[1].text);
	});

	it("tolerates per-item failure without sinking the batch", async () => {
		const r = await batch.run({} as any, {
			tool: "hash",
			calls: [{ text: "ok" }, { algo: "bogus" }],
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.results[0].ok).toBe(true);
		expect(out.results[1].ok).toBe(false);
		expect(out.results[1].error).toMatch(/Unknown algo/);
	});

	it("rejects when neither a valid calls array nor over+args is given", async () => {
		const r = await batch.run({} as any, { tool: "hash", calls: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `calls`.*or `over`/);
	});

	it("rejects more than 100 calls (amplification cap)", async () => {
		const calls = Array.from({ length: 101 }, (_, i) => ({ text: String(i) }));
		const r = await batch.run({} as any, { tool: "hash", calls });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Too many calls: 101 \(max 100/);
	});

	it("accepts exactly 100 calls", async () => {
		const calls = Array.from({ length: 100 }, (_, i) => ({ text: String(i) }));
		const r = await batch.run({} as any, { tool: "hash", calls });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).results).toHaveLength(100);
	});

	it("bounds the fan-out product when mapping a nested fan-out tool (pipe)", async () => {
		// batch{tool:'pipe'} would let 100 calls × 25 pipe steps = 2500 tool runs;
		// the nested cap holds it to 25 pipe calls (25 × 25 = 625 max).
		const calls = Array.from({ length: 26 }, () => ({ steps: [{ tool: "hash", args: { text: "x" } }] }));
		const over = await batch.run({} as any, { tool: "pipe", calls });
		expect(over.isError).toBe(true);
		expect(over.content[0].text).toMatch(/Too many calls for nested fan-out tool 'pipe': 26 \(max 25/);
		// Exactly 25 nested pipe calls is allowed (each pipe runs one hash step).
		const ok25 = await batch.run({} as any, { tool: "pipe", calls: calls.slice(0, 25) });
		expect(ok25.isError).toBeFalsy();
		const out = JSON.parse(ok25.content[0].text);
		expect(out.results).toHaveLength(25);
		expect(out.results[0].ok).toBe(true);
	});

	it("reduce defaults to none — output is unchanged", async () => {
		const base = await batch.run({} as any, { tool: "hash", calls: [{ text: "a" }, { text: "b" }] });
		const explicit = await batch.run({} as any, { tool: "hash", calls: [{ text: "a" }, { text: "b" }], reduce: "none" });
		const outBase = JSON.parse(base.content[0].text);
		const outExplicit = JSON.parse(explicit.content[0].text);
		expect(outBase).toEqual(outExplicit);
		expect(outBase).not.toHaveProperty("reduced");
		expect(outBase.results).toHaveLength(2);
	});

	it("rejects an unknown reduce mode", async () => {
		const r = await batch.run({} as any, { tool: "hash", calls: [{ text: "a" }], reduce: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown reduce 'bogus'/);
	});

	it("reduce:concat joins the ok results' text", async () => {
		const r = await batch.run({} as any, {
			tool: "hash",
			calls: [{ text: "a" }, { text: "b" }],
			reduce: "concat",
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.results).toHaveLength(2);
		expect(out.reduced).toBe(`${out.results[0].text}\n\n---\n\n${out.results[1].text}`);
	});

	it("reduce:concat skips failed items but keeps them in results", async () => {
		const r = await batch.run({} as any, {
			tool: "hash",
			calls: [{ text: "ok" }, { algo: "bogus" }],
			reduce: "concat",
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.results).toHaveLength(2);
		expect(out.results[1].ok).toBe(false);
		// Only the one ok result is in the reduction (no separator, no failed text).
		expect(out.reduced).toBe(out.results[0].text);
	});

	it("include_results:false drops the per-item array on a pure reduce", async () => {
		const r = await batch.run({} as any, {
			tool: "hash",
			calls: [{ text: "a" }, { text: "b" }],
			reduce: "concat",
			include_results: false,
		});
		const out = JSON.parse(r.content[0].text);
		expect(out).not.toHaveProperty("results");
		expect(out.tool).toBe("hash");
		expect(typeof out.reduced).toBe("string");
	});

	it("reduce:summarize feeds ok results to Workers AI", async () => {
		const seen: string[] = [];
		const env = {
			AI: {
				run: async (_model: string, inputs: any) => {
					seen.push(String(inputs?.messages?.[1]?.content ?? ""));
					return { response: "SYNTHESIZED" };
				},
			},
		};
		const r = await batch.run(env as any, {
			tool: "hash",
			calls: [{ text: "a" }, { text: "b" }],
			reduce: "summarize",
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.reduced).toBe("SYNTHESIZED");
		expect(out.results).toHaveLength(2);
		// The joined ok text was handed to the model.
		expect(seen[0]).toContain(out.results[0].text);
		expect(seen[0]).toContain(out.results[1].text);
	});

	it("reduce:summarize falls back to concat when AI isn't configured", async () => {
		const r = await batch.run({} as any, {
			tool: "hash",
			calls: [{ text: "a" }, { text: "b" }],
			reduce: "summarize",
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.reduced).toContain(out.results[0].text);
		expect(out.reduced).toContain(out.results[1].text);
		expect(out.reduced).toMatch(/summarize skipped/);
	});
});

import { fillItemsTokens, fillToken, pluckItems } from "./batch";

describe("batch map/reduce templating", () => {
	it("fillToken injects {{item}} whole (keeps type) and {{item.path}} inline", () => {
		expect(fillToken({ url: "{{item}}" }, "item", "https://x")).toEqual({ url: "https://x" });
		expect(fillToken({ v: "{{item}}" }, "item", { a: 1 })).toEqual({ v: { a: 1 } }); // whole-value keeps object
		expect(fillToken({ s: "id-{{item.id}}" }, "item", { id: 7 })).toEqual({ s: "id-7" });
		expect(fillToken({ nested: [{ u: "{{item}}" }] }, "item", "z")).toEqual({ nested: [{ u: "z" }] });
	});

	it("pluckItems collects a field across JSON outputs, or the whole array", () => {
		const items = ['{"url":"/s/a","n":1}', '{"url":"/s/b","n":2}', "not-json"];
		expect(pluckItems(items, "url")).toEqual(["/s/a", "/s/b"]); // non-JSON dropped
		expect(pluckItems(items)).toBe(items); // no path → whole array
	});

	it("fillItemsTokens replaces {{items.path}} with the plucked array (whole-value)", () => {
		const items = ['{"url":"/s/a"}', '{"url":"/s/b"}'];
		expect(fillItemsTokens({ sources: "{{items.url}}" }, items)).toEqual({ sources: ["/s/a", "/s/b"] });
		expect(fillItemsTokens({ all: "{{items}}" }, items)).toEqual({ all: items });
	});
});

describe("batch over + reduce_with (map-reduce composition)", () => {
	it("maps an args template over `over` (equivalent to explicit calls)", async () => {
		const viaOver = await batch.run({} as any, { tool: "hash", over: ["a", "b"], args: { text: "{{item}}" } });
		const viaCalls = await batch.run({} as any, { tool: "hash", calls: [{ text: "a" }, { text: "b" }] });
		expect(JSON.parse(viaOver.content[0].text).results).toEqual(JSON.parse(viaCalls.content[0].text).results);
	});

	it("requires an args template when `over` is given", async () => {
		const r = await batch.run({} as any, { tool: "hash", over: ["a"] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires an `args` template/);
	});

	it("reduce_with runs a reducer once over the mapped outputs", async () => {
		// Map hash over two items, then hash the joined array of results → one hash.
		const r = await batch.run({} as any, {
			tool: "hash",
			over: ["a", "b"],
			args: { text: "{{item}}" },
			reduce_with: { tool: "hash", args: { text: "joined:{{items}}" } },
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.reduced_with).toBe("hash");
		expect(out.reduced).toMatch(/^[0-9a-f]{64}$/);
		// The reduce hashed the array of the two item hashes → differs from either.
		expect(out.reduced).not.toBe(out.results[0].text);
		expect(out.results).toHaveLength(2);
	});

	it("reports an unknown reduce_with tool", async () => {
		const r = await batch.run({} as any, { tool: "hash", calls: [{ text: "a" }], reduce_with: { tool: "nope" } });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/reduce_with: unknown tool/);
	});
});
