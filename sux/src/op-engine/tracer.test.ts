import { test, expect } from "vitest";
import { MemoryStore, runInline, putBytes, type Caps, type Handle, type Llm, type SinkTarget } from "@suxos/lib";
import { zipSync, strToU8 } from "fflate";
import { registry } from "./registry.js";

// TRACER BULLET (Tier 1, deterministic node vitest) — the acceptance floor for the
// SuxOS v2 op-engine walking skeleton. Proves the REAL registered `assimilate-pdfs`
// op composes end-to-end through the inline runtime: a 2-entry zip fans out to two
// `extract`s under a bounded limiter, reconciles into one master, passes the human
// `ask` (an inline no-op), summarizes, and fans the result out to two sinks — with
// heavy content moving BY REFERENCE (Handles) at every hop, never inlined bytes.
//
// Everything non-deterministic is faked: a MemoryStore-backed content store, a fake
// Llm (real Workers-AI `markdownFromPdf` throws "not wired"), and two capturing sinks.
// The op tree comes from the registry FACTORY, so this exercises the shipped op, and
// each run mints a fresh `aimd` limiter (the per-run-limiter fix, asserted below).

// Records every put so the reconciled master can be observed directly as a Handle.
class CapturingStore extends MemoryStore {
	puts: Array<{ type: string; handle: Handle }> = [];
	async put(bytes: Uint8Array, type: string): Promise<Handle> {
		const handle = await super.put(bytes, type);
		this.puts.push({ type, handle });
		return handle;
	}
}

test("tracer bullet: zip → extract×2 → reconcile → ask → summarize → 2 sinks → abstract", async () => {
	const store = new CapturingStore();

	// Fake Llm: `markdownFromPdf` echoes the (arbitrary, Llm-faked) fixture bytes as a
	// markdown heading and counts its calls (the fan-out fingerprint); `summarize`
	// captures the master text it is handed and returns a fixed abstract.
	const extractInputs: string[] = [];
	const summarizeInputs: string[] = [];
	const fakeLlm: Llm = {
		async markdownFromPdf(bytes: Uint8Array): Promise<string> {
			const text = new TextDecoder().decode(bytes);
			extractInputs.push(text);
			return `# ${text}`;
		},
		async summarize(text: string): Promise<string> {
			summarizeInputs.push(text);
			return "assimilated-master-abstract";
		},
	};

	const r2Writes: any[] = [];
	const vaultWrites: any[] = [];
	const sinks: Record<string, SinkTarget> = {
		r2: { name: "r2", write: async (v: any) => (r2Writes.push(v), v) },
		vault: { name: "vault", write: async (v: any) => (vaultWrites.push(v), v) },
	};

	const caps: Caps = { store, llm: fakeLlm, clock: { now: () => 0 }, sinks };

	// Fixture: a 2-entry zip staged into the store as the op's input Handle. Contents
	// are arbitrary — the Llm is faked, so these need not be real PDFs.
	const zipBytes = zipSync({ "a.pdf": strToU8("PDF-A-CONTENT"), "b.pdf": strToU8("PDF-B-CONTENT") });
	const zipHandle = await putBytes(store, zipBytes, "application/zip");

	const result = await runInline(registry["assimilate-pdfs"](), zipHandle, caps);

	// (1) The abstract is produced and threaded to the pipe's output.
	expect(result.abstract).toBe("assimilated-master-abstract");

	// (2) BOTH sinks received exactly one write, and it is the pipe's terminal value
	//     (sink returns its input unchanged — a fan-out, not a transform).
	expect(r2Writes).toHaveLength(1);
	expect(vaultWrites).toHaveLength(1);
	expect(r2Writes[0]).toBe(result);
	expect(vaultWrites[0]).toBe(result);

	// (3) `extract` ran once per zip entry (fan-out over 2), covering both PDFs.
	expect(extractInputs.sort()).toEqual(["PDF-A-CONTENT", "PDF-B-CONTENT"]);

	// (4) Reconcile produced a faithful union of BOTH extracted markdowns, and handed
	//     it to summarize as TEXT resolved from a Handle (not inlined into the pipe).
	expect(summarizeInputs).toHaveLength(1);
	expect(summarizeInputs[0]).toContain("# PDF-A-CONTENT");
	expect(summarizeInputs[0]).toContain("# PDF-B-CONTENT");

	// (5) The reconciled master moved BY REFERENCE — bytes never inlined. Observe it
	//     directly in the store: it is the only put carrying faithfulUnion's source
	//     markers, and it is a content-addressed Handle (r2Key + 64-hex sha256).
	let master: Handle | undefined;
	for (const p of store.puts) {
		if (new TextDecoder().decode(await store.get(p.handle)).includes("<!-- source:")) master = p.handle;
	}
	expect(master).toBeDefined();
	expect(master!.r2Key).toMatch(/^cas\//);
	expect(master!.sha256).toMatch(/^[0-9a-f]{64}$/);

	// The summary artifact is likewise a Handle, not inlined text.
	expect(result.summaryHandle.r2Key).toMatch(/^cas\//);
});

test("assimilate-pdfs mints a FRESH map limiter per run (no shared module-level state)", () => {
	const a = registry["assimilate-pdfs"]() as Extract<ReturnType<(typeof registry)["assimilate-pdfs"]>, { tag: "pipe" }>;
	const b = registry["assimilate-pdfs"]() as Extract<ReturnType<(typeof registry)["assimilate-pdfs"]>, { tag: "pipe" }>;
	const mapA = a.steps[1];
	const mapB = b.steps[1];
	expect(mapA.tag).toBe("map");
	expect(mapB.tag).toBe("map");
	if (mapA.tag === "map" && mapB.tag === "map") expect(mapA.concurrency).not.toBe(mapB.concurrency);
});
