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
});
