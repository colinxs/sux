import { test, expect } from "vitest";
import type { Caps, Handle } from "@suxos/lib";
import { makeCaps } from "./caps.js";
import type { RtEnv } from "../registry.js";

// Fake R2: just enough of the head/get/put surface makeSinks touches.
test("sinks re-address a Handle (r2 -> published/) and a {summaryHandle} (vault -> vault/)", async () => {
	const objs = new Map<string, Uint8Array>();
	const R2 = {
		head: async (k: string) => (objs.has(k) ? {} : null),
		get: async (k: string) => (objs.has(k) ? { arrayBuffer: async () => objs.get(k)!.buffer } : null),
		put: async (k: string, v: Uint8Array) => void objs.set(k, v),
	};
	const handle: Handle = { r2Key: "cas/abc", sha256: "abc", type: "text/plain", size: 5 };
	objs.set(handle.r2Key, new TextEncoder().encode("hello"));

	const { sinks } = makeCaps({ R2 } as unknown as RtEnv);
	await sinks.r2.write(handle, {} as Caps);
	await sinks.vault.write({ summaryHandle: handle }, {} as Caps);

	expect(objs.has(`published/${handle.sha256}`)).toBe(true);
	expect(objs.has(`vault/${handle.sha256}`)).toBe(true);
});

// The op's `extract` leaf (suxlib domain/text.ts) calls `caps.llm.markdownFromPdf(bytes)`
// and expects the converted markdown string back. `workersAiLlm` wires that to the real
// Workers-AI `env.AI.toMarkdown` surface — a fake AI binding here proves the call shape and
// that we return the ConversionResponse's `data`, without needing real Workers-AI creds
// (which is exactly why the e2e harness omits the AI binding — see cluster-E report).
test("markdownFromPdf: converts PDF bytes via env.AI.toMarkdown and returns the markdown `data`", async () => {
	const seen: Array<{ name: string; type: string; bytes: Uint8Array }> = [];
	const AI = {
		async toMarkdown(doc: { name: string; blob: Blob }) {
			seen.push({ name: doc.name, type: doc.blob.type, bytes: new Uint8Array(await doc.blob.arrayBuffer()) });
			return { id: "r1", name: doc.name, mimeType: "application/pdf", format: "markdown" as const, tokens: 7, data: "# Title\n\nbody" };
		},
	};
	const { llm } = makeCaps({ AI } as unknown as RtEnv);

	const pdf = new TextEncoder().encode("%PDF-1.7 …bytes…");
	const md = await llm.markdownFromPdf(pdf);

	// Returns the converted markdown carried in the ConversionResponse `data` field.
	expect(md).toBe("# Title\n\nbody");
	// Sent the PDF BY VALUE as a single-document Blob to the toMarkdown surface (not the
	// run()/text-prompt path used by summarize) — one call, correct content type + bytes.
	expect(seen).toHaveLength(1);
	expect(seen[0].type).toBe("application/pdf");
	expect(Array.from(seen[0].bytes)).toEqual(Array.from(pdf));
});

// A ConversionResponse with format:"error" carries no `data` — fail LOUD so a corrupt/
// unsupported PDF surfaces as a run error instead of silently assimilating a bad extraction.
test("markdownFromPdf: fails loud when toMarkdown returns a format:'error' result", async () => {
	const AI = {
		async toMarkdown(doc: { name: string; blob: Blob }) {
			return { id: "r1", name: doc.name, mimeType: "application/pdf", format: "error" as const, error: "unsupported or corrupt PDF" };
		},
	};
	const { llm } = makeCaps({ AI } as unknown as RtEnv);
	await expect(llm.markdownFromPdf(new Uint8Array([1, 2, 3]))).rejects.toThrow(/unsupported or corrupt PDF/);
});

// Same fail-loud convention as the store/sinks: a missing binding throws WHEN CALLED (never a
// silent no-op), with a message that names the exact binding/method the operator must add.
test("markdownFromPdf: fails loud when the AI binding is absent", async () => {
	const { llm } = makeCaps({} as unknown as RtEnv);
	await expect(llm.markdownFromPdf(new Uint8Array([1]))).rejects.toThrow(/env\.AI\.toMarkdown/);
});
