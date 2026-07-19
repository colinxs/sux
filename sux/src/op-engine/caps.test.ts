import { test, expect, vi } from "vitest";
import type { Caps, Handle } from "@suxos/lib";
import { makeCaps } from "./caps.js";
import type { RtEnv } from "../registry.js";

type FakeToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const labelMessages = vi.fn(async (_env: unknown, ids: string[], label: string, add: boolean): Promise<FakeToolResult> => ({ content: [{ type: "text", text: JSON.stringify({ labeled: ids.length, keyword: label, add }) }] }));
vi.mock("../mail-mcp.js", () => ({ labelMessages: (...args: [unknown, string[], string, boolean]) => labelMessages(...args) }));

const obsidianRun = vi.fn(async (_env: unknown, _args: unknown): Promise<FakeToolResult> => ({ content: [{ type: "text", text: "{}" }] }));
vi.mock("../fns/obsidian.js", () => ({ obsidian: { run: (...args: [unknown, unknown]) => obsidianRun(...args) } }));

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

test("mail-labels sink groups proposals by (label, add) and calls labelMessages once per group", async () => {
	labelMessages.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["mail-labels"].write(
		[
			{ id: "1", label: "junk", add: true, confidence: 0.9, reason: "x" },
			{ id: "2", label: "receipt", add: true, confidence: 0.85, reason: "y" },
			{ id: "3", label: "junk", add: true, confidence: 0.9, reason: "z" },
		],
		{} as Caps,
	);
	expect(labelMessages).toHaveBeenCalledTimes(2);
	expect(labelMessages).toHaveBeenCalledWith({}, ["1", "3"], "junk", true);
	expect(labelMessages).toHaveBeenCalledWith({}, ["2"], "receipt", true);
	expect(out).toEqual({ labeled: 3, groups: 2 });
});

test("mail-labels sink is a no-op on an empty batch (never an error)", async () => {
	labelMessages.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["mail-labels"].write([], {} as Caps);
	expect(labelMessages).not.toHaveBeenCalled();
	expect(out).toEqual({ labeled: 0, groups: 0 });
});

test("mail-labels sink fails loud when labelMessages reports an error", async () => {
	labelMessages.mockClear();
	labelMessages.mockResolvedValueOnce({ content: [{ type: "text", text: "[upstream_error] JMAP rejected the patch" }], isError: true });
	const { sinks } = makeCaps({} as unknown as RtEnv);
	await expect(sinks["mail-labels"].write([{ id: "1", label: "junk", add: true, confidence: 0.9, reason: "x" }], {} as Caps)).rejects.toThrow(/JMAP rejected the patch/);
});

test("mail-labels sink reads labelMessages' actual labeled/failed counts instead of assuming the whole group succeeded", async () => {
	labelMessages.mockClear();
	// A PARTIAL failure (2 of 3 ids updated) still comes back isError:false — only 1 of the
	// 3 ids in this group should count as labeled, not all 3.
	labelMessages.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ labeled: 1, keyword: "junk", add: true, failed: 2, errors: { "2": {}, "3": {} } }) }] });
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["mail-labels"].write(
		[
			{ id: "1", label: "junk", add: true, confidence: 0.9, reason: "x" },
			{ id: "2", label: "junk", add: true, confidence: 0.9, reason: "y" },
			{ id: "3", label: "junk", add: true, confidence: 0.9, reason: "z" },
		],
		{} as Caps,
	);
	expect(out).toEqual({ labeled: 1, groups: 1, failed: 2 });
});

test("vault-notes sink writes the merged content to `keep` and appends a pointer to each `archive` — never a delete", async () => {
	obsidianRun.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["vault-notes"].write(
		[{ keep: "Projects/project-alpha.md", archives: ["Archive/Project Alpha (2).md"], mergedContent: "merged body", key: "project alpha" }],
		{ clock: { now: () => 0 } } as unknown as Caps,
	);
	expect(obsidianRun).toHaveBeenCalledWith({}, { action: "write", path: "Projects/project-alpha.md", content: "merged body", backend: "git" });
	expect(obsidianRun).toHaveBeenCalledWith({}, { action: "append", path: "Archive/Project Alpha (2).md", content: expect.stringContaining("Merged into [[Projects/project-alpha.md]]"), backend: "git" });
	expect(obsidianRun).not.toHaveBeenCalledWith({}, expect.objectContaining({ action: "delete" }));
	expect(out).toEqual({ merged: 1, groups: 1 });
});

test("vault-notes sink applies a 3+ note group's single composed merge with ONE write to `keep` and an append to every archive", async () => {
	obsidianRun.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["vault-notes"].write(
		[{ keep: "Project (1).md", archives: ["Project (2).md", "Project.md"], mergedContent: "composed body", key: "project" }],
		{ clock: { now: () => 0 } } as unknown as Caps,
	);
	const writeCalls = obsidianRun.mock.calls.filter((c: any[]) => c[1].action === "write");
	expect(writeCalls).toHaveLength(1);
	expect(writeCalls[0][1]).toEqual({ action: "write", path: "Project (1).md", content: "composed body", backend: "git" });
	expect(obsidianRun).toHaveBeenCalledWith({}, { action: "append", path: "Project (2).md", content: expect.stringContaining("Merged into [[Project (1).md]]"), backend: "git" });
	expect(obsidianRun).toHaveBeenCalledWith({}, { action: "append", path: "Project.md", content: expect.stringContaining("Merged into [[Project (1).md]]"), backend: "git" });
	expect(out).toEqual({ merged: 1, groups: 1 });
});

test("vault-notes sink is a no-op on an empty batch (never an error)", async () => {
	obsidianRun.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["vault-notes"].write([], { clock: { now: () => 0 } } as unknown as Caps);
	expect(obsidianRun).not.toHaveBeenCalled();
	expect(out).toEqual({ merged: 0 });
});

test("vault-notes sink skips the append on a retry — `archive` already carries this item's merge pointer", async () => {
	obsidianRun.mockClear();
	obsidianRun.mockImplementation(async (_env: unknown, args: any) => {
		if (args.action === "read") return { content: [{ type: "text", text: "existing body\n\n> [!note] Merged into [[A.md]] by vault-consolidate-plan on 2024-01-01 — see there for the combined content." }] };
		return { content: [{ type: "text", text: "{}" }] };
	});
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["vault-notes"].write([{ keep: "A.md", archives: ["B.md"], mergedContent: "x", key: "k" }], { clock: { now: () => 0 } } as unknown as Caps);
	expect(out).toEqual({ merged: 1, groups: 1 });
	expect(obsidianRun).not.toHaveBeenCalledWith({}, expect.objectContaining({ action: "append" }));
});

test("vault-notes sink skips (doesn't throw) an item whose write fails, and counts it as failed", async () => {
	obsidianRun.mockClear();
	obsidianRun.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "conflict" }] });
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["vault-notes"].write([{ keep: "A.md", archives: ["B.md"], mergedContent: "x", key: "k" }], { clock: { now: () => 0 } } as unknown as Caps);
	expect(out).toEqual({ merged: 0, groups: 1, failed: 1 });
	expect(obsidianRun).toHaveBeenCalledTimes(1); // the append never runs once the write itself failed
});

test("related-links sink groups matches by vaultPath into ONE append-only 'Related' block, never a write/delete", async () => {
	obsidianRun.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["related-links"].write(
		[
			{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "Re: alpha kickoff", score: 0.9 },
			{ vaultPath: "Projects/alpha.md", domain: "files", key: "alpha/spec.md", label: "alpha/spec.md", score: 0.8 },
		],
		{} as Caps,
	);
	const appendCalls = obsidianRun.mock.calls.filter((c: any[]) => c[1].action === "append");
	expect(appendCalls).toHaveLength(1);
	expect(appendCalls[0][1]).toMatchObject({ path: "Projects/alpha.md", content: expect.stringContaining("Re: alpha kickoff") });
	expect(appendCalls[0][1]).toMatchObject({ content: expect.stringContaining("alpha/spec.md") });
	expect(obsidianRun).not.toHaveBeenCalledWith({}, expect.objectContaining({ action: "write" }));
	expect(obsidianRun).not.toHaveBeenCalledWith({}, expect.objectContaining({ action: "delete" }));
	expect(out).toEqual({ linked: 1, notes: 1 });
});

test("related-links sink is a no-op on an empty batch (never an error)", async () => {
	obsidianRun.mockClear();
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["related-links"].write([], {} as Caps);
	expect(obsidianRun).not.toHaveBeenCalled();
	expect(out).toEqual({ linked: 0 });
});

test("related-links sink skips the append on a retry — the note already carries this op's marker", async () => {
	obsidianRun.mockClear();
	obsidianRun.mockImplementation(async (_env: unknown, args: any) => {
		if (args.action === "read") return { content: [{ type: "text", text: "existing body\n\n<!-- cross-semantic-plan:related -->\n> [!note] Related\n> - 📧 old match" }] };
		return { content: [{ type: "text", text: "{}" }] };
	});
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["related-links"].write([{ vaultPath: "A.md", domain: "mail", key: "m1", label: "x", score: 0.9 }], {} as Caps);
	expect(out).toEqual({ linked: 0, notes: 1 });
	expect(obsidianRun).not.toHaveBeenCalledWith({}, expect.objectContaining({ action: "append" }));
});

test("related-links sink skips (doesn't throw) a note whose append fails, and counts it as failed", async () => {
	obsidianRun.mockClear();
	obsidianRun.mockImplementation(async (_env: unknown, args: any) => {
		if (args.action === "read") return { content: [{ type: "text", text: "" }] };
		if (args.action === "append") return { isError: true, content: [{ type: "text", text: "conflict" }] };
		throw new Error(`unexpected action ${args.action}`);
	});
	const { sinks } = makeCaps({} as unknown as RtEnv);
	const out = await sinks["related-links"].write([{ vaultPath: "A.md", domain: "mail", key: "m1", label: "x", score: 0.9 }], {} as Caps);
	expect(out).toEqual({ linked: 0, notes: 1, failed: 1 });
});
