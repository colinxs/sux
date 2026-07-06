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

	it("rejects a non-array calls value", async () => {
		const r = await batch.run({} as any, { tool: "hash", calls: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/`calls` must be an array/);
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
