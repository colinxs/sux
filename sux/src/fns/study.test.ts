import { afterEach, describe, expect, it, vi } from "vitest";

// The vault mirror (appendOnOracle + appendOnWhitelist) rides obsidian.run — mock it (its own
// suite covers it) so we test study's distillation, whitelist provenance, the pdf-text path, and
// the copyright invariant (only the compressed index is stored) without a configured vault.
vi.mock("./obsidian", () => ({ obsidian: { run: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })) } }));

// dropbox.ts's real hasDropbox/sharedLink hit the network (dropboxRpc) — mock so the
// Mode A path tests below (#768) exercise study's own branching, not Dropbox's HTTP API.
const dropboxMock = { hasDropbox: vi.fn((_env?: unknown) => false), sharedLink: vi.fn(async (_env?: unknown, _path?: unknown) => undefined as string | undefined) };
vi.mock("./dropbox", () => ({
	hasDropbox: (env: unknown) => dropboxMock.hasDropbox(env),
	sharedLink: (env: unknown, path: unknown) => dropboxMock.sharedLink(env, path),
}));

// The shared Mistral OCR engine (_ocr.ts) has its own suite — mock it here so study's
// pdf/document path is tested for how it COMPOSES on ocrDocument (url vs bytes), not for
// the OCR internals. Default resolves; per-test mockResolvedValueOnce/mockRejectedValueOnce.
const ocrMock = { ocrDocument: vi.fn(async (_env: unknown, _src: unknown) => "OCR_TEXT") };
vi.mock("./_ocr", () => ({
	ocrDocument: (env: unknown, src: unknown) => ocrMock.ocrDocument(env, src),
}));

import { DATA_CLOSE, DATA_OPEN } from "../ai";
import { maybeDecompressString } from "./_gzip";
import { study } from "./study";

const parse = (r: any) => JSON.parse(r.content[0].text);

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/** A minimal Map-backed OAUTH_KV (get/put/delete/list) matching the CF KV surface. */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true as const,
		})),
	};
}

/** env with the REAL guarded llm() driving a stubbed AI.run that answers by ROLE (the oracle-suite
 *  idiom). The pdf/document-extraction path rides the mocked _ocr engine above. */
function makeEnv(opts: { distill?: string } = {}) {
	const kv = makeKv();
	const run = vi.fn(async (_model: string, inputs: any) => {
		// oracle's learnTopic also embeds the distilled note into the retrievable-detail store —
		// that call shape is { text: [...] }, never { messages: [...] }.
		if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [0.1, 0.2, 0.3]) };
		const system: string = inputs.messages.find((m: any) => m.role === "system").content;
		if (/^Consolidate/.test(system)) return { response: "CONSOLIDATED-KB" };
		return { response: opts.distill ?? "DISTILLED-CHUNK" };
	});
	const AI: any = { run };
	return { env: { AI, OAUTH_KV: kv } as any, kv, run };
}

const kbFor = async (kv: ReturnType<typeof makeKv>, topic: string) => JSON.parse(await maybeDecompressString(kv.store.get(`sux:oracle:${topic}`)!));

afterEach(() => vi.clearAllMocks());

describe("study — learn (text)", () => {
	it("distills caller-supplied text into a WHITELISTED oracle topic and reports how to query it", async () => {
		const { env, kv, run } = makeEnv();
		const r = await study.run(env, { source: "Opposite action means acting opposite to an unjustified emotion's urge.", kind: "text", topic: "dbt", title: "DBT Skills Manual" });
		expect(r.isError).toBeFalsy();

		const j = parse(r);
		expect(j).toMatchObject({ action: "learn", topic: "dbt", kind: "text", title: "DBT Skills Manual", whitelisted: true, segments: 1, chunk_count: 1 });
		expect(j.query_hint).toMatch(/oracle\(.*topic: "dbt"/);
		expect(j.undo_hint).toBe('study({ action: "forget", topic: "dbt" })');

		// The raw material rode the guarded llm() — fenced as untrusted data, instruction in system.
		const { messages } = run.mock.calls[0][1] as any;
		const user = messages.find((m: any) => m.role === "user").content;
		expect(user).toContain(DATA_OPEN);
		expect(user).toContain(DATA_CLOSE);
		expect(user).toContain("Opposite action means acting opposite");

		// Stored under the oracle key space, marked whitelisted with provenance.
		const stored = await kbFor(kv, "dbt");
		expect(stored.whitelist).toMatchObject({ kind: "text", via: "study", title: "DBT Skills Manual" });
		expect(stored.whitelist.source).toMatch(/^inline text \(\d+ chars\)$/);
		expect(typeof stored.whitelist.learned_at).toBe("number");
	});

	it("copyright: stores only the compressed distillation, never a verbatim reproduction", async () => {
		const { env, kv } = makeEnv();
		const verbatim = "The exact sentence from the book that must NEVER be stored verbatim in the KB.";
		await study.run(env, { source: verbatim, kind: "text", topic: "book" });

		const stored = await kbFor(kv, "book");
		// The KB holds the distilled note, not the source text; there is no full-text field.
		expect(stored.distilled).toBe("DISTILLED-CHUNK");
		expect(stored.chunks).toEqual(["DISTILLED-CHUNK"]);
		expect(stored.text).toBeUndefined();
		expect(stored.fulltext).toBeUndefined();
		expect(JSON.stringify(stored)).not.toContain(verbatim);
	});

	it("a book-sized source is split into bounded segments → a multi-note KB (not just its first pages)", async () => {
		const { env, kv, run } = makeEnv();
		const para = `${"knowledge ".repeat(200)}\n\n`; // ~2.2k chars/paragraph
		const big = para.repeat(20); // ~44k chars → several 18k segments
		run.mockImplementation(async (_m: string, inputs: any) => {
			const system: string = inputs.messages.find((m: any) => m.role === "system").content;
			return { response: /^Consolidate/.test(system) ? "CONSOLIDATED-KB" : "SEG-NOTE" };
		});

		const j = parse(await study.run(env, { source: big, kind: "text", topic: "manual" }));
		expect(j.segments).toBeGreaterThan(1);
		expect(j.chunk_count).toBeGreaterThan(1);
		const stored = await kbFor(kv, "manual");
		expect(stored.chunks.length).toBe(j.segments);
		expect(stored.whitelist.kind).toBe("text");
	});
});

describe("study — learn (url / pdf)", () => {
	it("auto-detects a plain URL, hands it to oracle to fetch + distill, and whitelists it", async () => {
		const { env, kv } = makeEnv();
		fetchMock.mockImplementation(async () => new Response("A whitelisted article the user has the right to use.", { status: 200, headers: { "content-type": "text/plain" } }));

		const j = parse(await study.run(env, { source: "https://example.com/my-article", topic: "art" }));
		expect(j).toMatchObject({ kind: "url", whitelisted: true, source: "https://example.com/my-article" });
		expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/my-article");
		const stored = await kbFor(kv, "art");
		expect(stored.whitelist.kind).toBe("url");
		expect(stored.sources).toEqual(["https://example.com/my-article"]);
	});

	it("auto-detects a .pdf URL, OCRs it via the shared Mistral engine (url input), then distills", async () => {
		const { env, kv } = makeEnv();
		ocrMock.ocrDocument.mockResolvedValueOnce("# Chapter 1\n\nExtracted PDF prose about distress tolerance.");

		const j = parse(await study.run(env, { source: "https://example.com/dbt.pdf", topic: "dbt" }));
		expect(j).toMatchObject({ kind: "pdf", whitelisted: true, title: "dbt.pdf" });
		// An http(s) source is handed to Mistral by URL (it fetches the doc itself), not pre-downloaded.
		expect(ocrMock.ocrDocument).toHaveBeenCalledTimes(1);
		expect(ocrMock.ocrDocument.mock.calls[0][1]).toEqual({ url: "https://example.com/dbt.pdf" });

		// The distill saw the OCR'd text, fenced as data.
		const distillUser = (env.AI.run.mock.calls[0][1].messages.find((m: any) => m.role === "user").content) as string;
		expect(distillUser).toContain("Extracted PDF prose about distress tolerance");
		const stored = await kbFor(kv, "dbt");
		expect(stored.whitelist).toMatchObject({ kind: "pdf", via: "study" });
	});

	it("source_label overrides the inferred provenance source (the sweep→study call shape, #822)", async () => {
		const { env, kv } = makeEnv();
		ocrMock.ocrDocument.mockResolvedValueOnce("Notes from a Dropbox-sourced PDF, fetched via a shared link.");

		// A Dropbox shared link (http(s) URL) — same shape _learning_folder.ts hands study —
		// but with an explicit source_label so the KB records the dropbox: path, not the URL.
		const j = parse(
			await study.run(env, { source: "https://www.dropbox.com/s/xyz/report.pdf?dl=1", kind: "pdf", topic: "reports", source_label: "dropbox:/learning/report.pdf" }),
		);
		expect(j).toMatchObject({ kind: "pdf", whitelisted: true, source: "dropbox:/learning/report.pdf" });
		const stored = await kbFor(kv, "reports");
		expect(stored.whitelist).toMatchObject({ source: "dropbox:/learning/report.pdf" });
		expect(ocrMock.ocrDocument).toHaveBeenCalledTimes(1);
	});

	it("a pdf source with OCR unconfigured fails cleanly, telling the caller to pass extracted text", async () => {
		const { env } = makeEnv();
		ocrMock.ocrDocument.mockRejectedValueOnce(new Error("Mistral OCR is not configured — set MISTRAL_API_KEY (wrangler secret put MISTRAL_API_KEY)."));
		const r = await study.run(env, { source: "https://example.com/scan.pdf", topic: "x" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(r.content[0].text).toMatch(/MISTRAL_API_KEY|extract the text yourself/i);
	});

	it("a Dropbox app-folder path (Mode A) is read via a shared link before requiring Mode B (#768)", async () => {
		const { env, kv } = makeEnv();
		dropboxMock.hasDropbox.mockReturnValue(true);
		dropboxMock.sharedLink.mockResolvedValue("https://www.dropbox.com/s/abc/notes.pdf?dl=0");
		fetchMock.mockImplementation(async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }));
		ocrMock.ocrDocument.mockResolvedValueOnce("Notes from the app-folder file.");

		const j = parse(await study.run(env, { source: "/notes.pdf", topic: "notes" }));
		expect(j).toMatchObject({ kind: "pdf", whitelisted: true });
		expect(dropboxMock.sharedLink).toHaveBeenCalledWith(env, "/notes.pdf");
		// The raw-download URL (dl=1), not the HTML preview link, is what study fetched to get the bytes.
		expect(String(fetchMock.mock.calls[0][0])).toContain("dl=1");
		// A Dropbox path has no re-fetchable URL — the bytes are OCR'd (ocrDocument({bytes})), not the URL.
		expect(ocrMock.ocrDocument).toHaveBeenCalledTimes(1);
		expect((ocrMock.ocrDocument.mock.calls[0][1] as any).bytes).toBeInstanceOf(Uint8Array);
		const stored = await kbFor(kv, "notes");
		expect(stored.whitelist).toMatchObject({ kind: "pdf", via: "study" });
	});

	it("a Dropbox path with neither Mode A nor Mode B configured fails cleanly", async () => {
		const { env } = makeEnv();
		dropboxMock.hasDropbox.mockReturnValue(false);
		const r = await study.run(env, { source: "/notes.pdf", topic: "notes" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/app-folder Dropbox binding|Mode B/i);
	});
});

describe("study — learn archive (#1209 three-sink ingestion)", () => {
	function withR2(env: any) {
		const objects = new Map<string, unknown>();
		const R2 = { put: vi.fn(async (key: string, body: unknown) => void objects.set(key, body)) };
		return { env: { ...env, R2 }, R2, objects };
	}

	it("defaults to archive:true (#1239) — a plain learn call still produces the three-sink shape", async () => {
		const { env: base } = makeEnv();
		const { env, R2 } = withR2(base);
		const j = parse(await study.run(env, { source: "Opposite action.", kind: "text", topic: "dbt" }));
		expect(j.archived).toMatchObject({ vault_note: "Knowledge/Distilled/dbt.md" });
		expect(R2.put).toHaveBeenCalledTimes(1);
	});

	it("archive:false opts out — no R2/vault-note side effects, no `archived` field noise beyond undefined", async () => {
		const { env: base } = makeEnv();
		const { env, R2 } = withR2(base);
		const j = parse(await study.run(env, { source: "Opposite action.", kind: "text", topic: "dbt", archive: false }));
		expect(j.archived).toBeUndefined();
		expect(R2.put).not.toHaveBeenCalled();
	});

	it("archive:true on a text source archives the material to R2 and writes a Knowledge/Distilled insight card", async () => {
		const { env: base, kv } = makeEnv();
		const { env, R2 } = withR2(base);

		const j = parse(await study.run(env, { source: "Opposite action means acting opposite to an unjustified emotion's urge.", kind: "text", topic: "dbt", title: "DBT Skills Manual", archive: true }));
		expect(j.archived).toMatchObject({ vault_note: "Knowledge/Distilled/DBT Skills Manual.md" });
		expect(j.archived.r2).toMatchObject({ sha256: expect.any(String), size: expect.any(Number) });
		expect(R2.put).toHaveBeenCalledTimes(1);

		const obsidian = (await import("./obsidian")).obsidian;
		const writeCall = (obsidian.run as any).mock.calls.find((c: any[]) => c[1]?.action === "write");
		expect(writeCall[1].path).toBe("Knowledge/Distilled/DBT Skills Manual.md");
		expect(writeCall[1].content).toContain("DISTILLED-CHUNK");
		expect(writeCall[1].content).toContain(j.archived.r2.url);

		const stored = await kbFor(kv, "dbt");
		expect(JSON.stringify(stored)).not.toContain("Opposite action means acting opposite"); // still never a verbatim KB copy
	});

	it("archive:true structures the insight card into core-models/techniques/when-to-use/notable-passages (#1239)", async () => {
		const { env: base, run } = makeEnv();
		const { env } = withR2(base);
		run.mockImplementation(async (_m: string, inputs: any) => {
			if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [0.1, 0.2, 0.3]) };
			const system: string = inputs.messages.find((m: any) => m.role === "system").content;
			if (/^Consolidate/.test(system)) return { response: "CONSOLIDATED-KB" };
			if (/^Reorganize/.test(system)) return { response: "## Core models\n- opposite action\n\n## Techniques\n- practice\n\n## When to use\n- unjustified emotion\n\n## Notable passages\n> acting opposite to an unjustified emotion's urge" };
			return { response: "DISTILLED-CHUNK" };
		});

		const j = parse(await study.run(env, { source: "Opposite action means acting opposite to an unjustified emotion's urge.", kind: "text", topic: "dbt", archive: true }));
		const obsidian = (await import("./obsidian")).obsidian;
		const writeCall = (obsidian.run as any).mock.calls.find((c: any[]) => c[1]?.action === "write");
		expect(writeCall[1].content).toContain("## Core models");
		expect(writeCall[1].content).toContain("## Techniques");
		expect(writeCall[1].content).toContain("## When to use");
		expect(writeCall[1].content).toContain("## Notable passages");
		expect(j.archived.vault_note).toBeTruthy();
	});

	it("archive:true falls back to the raw distilled note when the structuring call returns nothing", async () => {
		const { env: base, run } = makeEnv();
		const { env } = withR2(base);
		run.mockImplementation(async (_m: string, inputs: any) => {
			if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [0.1, 0.2, 0.3]) };
			const system: string = inputs.messages.find((m: any) => m.role === "system").content;
			if (/^Consolidate/.test(system)) return { response: "CONSOLIDATED-KB" };
			if (/^Reorganize/.test(system)) return { response: "" }; // structuring hiccup — empty response
			return { response: "DISTILLED-CHUNK" };
		});

		const j = parse(await study.run(env, { source: "Opposite action.", kind: "text", topic: "dbt", archive: true }));
		const obsidian = (await import("./obsidian")).obsidian;
		const writeCall = (obsidian.run as any).mock.calls.find((c: any[]) => c[1]?.action === "write");
		expect(writeCall[1].content).toContain("DISTILLED-CHUNK"); // fell back to the raw distilled note
		expect(j.archived.vault_note).toBeTruthy();
	});

	it("archive:true best-effort degrades cleanly when R2 isn't bound — learn still succeeds", async () => {
		const { env } = makeEnv(); // no R2
		const r = await study.run(env, { source: "text material", kind: "text", topic: "t", archive: true });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j.whitelisted).toBe(true);
		expect(j.archived.r2).toBeUndefined();
		expect(j.archived.skipped).toBeTruthy();
	});

	it("archive:true on a Dropbox-path pdf still archives the original bytes to R2 (#1239 — Mode A)", async () => {
		const { env: base } = makeEnv();
		const { env, R2 } = withR2(base);
		dropboxMock.hasDropbox.mockReturnValue(true);
		dropboxMock.sharedLink.mockResolvedValue("https://www.dropbox.com/s/abc/notes.pdf?dl=0");
		fetchMock.mockImplementation(async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }));
		ocrMock.ocrDocument.mockResolvedValueOnce("Notes from the app-folder file.");

		const j = parse(await study.run(env, { source: "/notes.pdf", topic: "notes", archive: true }));
		expect(j.archived.r2).toMatchObject({ sha256: expect.any(String), size: expect.any(Number) });
		expect(j.archived.skipped).toBeUndefined();
		// Only the archive leg writes to R2 here — the OCR engine (which would also putBlob to mint a
		// Mistral URL) is mocked out, so R2.put is the single archive write.
		expect(R2.put).toHaveBeenCalledTimes(1);
	});
});

describe("study — list / forget (the copyright audit + reversibility)", () => {
	it("list surfaces only the whitelisted topics with provenance", async () => {
		const { env, kv } = makeEnv();
		// One whitelisted (studied) topic and one plain oracle topic sharing the key space.
		kv.store.set("sux:oracle:dbt", JSON.stringify({ distilled: "d", chunks: ["c"], sources: ["s"], updated_at: 5, whitelist: { source: "book.pdf", kind: "pdf", via: "study", learned_at: 5, title: "DBT" } }));
		kv.store.set("sux:oracle:trivia", JSON.stringify({ distilled: "d", chunks: ["c"], sources: ["s"], updated_at: 6 }));

		const j = parse(await study.run(env, { action: "list" }));
		expect(j.count).toBe(1);
		expect(j.topics).toHaveLength(1);
		expect(j.topics[0]).toMatchObject({ topic: "dbt", chunk_count: 1 });
		expect(j.topics[0].whitelist).toMatchObject({ kind: "pdf", title: "DBT" });
	});

	it("forget deletes the whitelisted KB (reversible: the git-versioned vault mirror stays)", async () => {
		const { env, kv } = makeEnv();
		await study.run(env, { source: "some owned material", kind: "text", topic: "dbt" });
		expect(kv.store.has("sux:oracle:dbt")).toBe(true);

		const j = parse(await study.run(env, { action: "forget", topic: "dbt" }));
		expect(j).toMatchObject({ action: "forget", topic: "dbt", forgotten: true });
		expect(kv.store.has("sux:oracle:dbt")).toBe(false);
		expect(j.note).toMatch(/git is the vault undo/);
	});
});

describe("study — guards", () => {
	it("bad_input without a source", async () => {
		const { env } = makeEnv();
		const r = await study.run(env, { topic: "t" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
	});

	it("bad_input without a topic", async () => {
		const { env } = makeEnv();
		const r = await study.run(env, { source: "hi" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
	});

	it("not_configured without the AI binding", async () => {
		const r = await study.run({ OAUTH_KV: makeKv() } as any, { source: "hi", kind: "text", topic: "t" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
	});

	it("bad_input on an unknown action", async () => {
		const { env } = makeEnv();
		const r = await study.run(env, { action: "obliterate", topic: "t" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
	});

	it("is stateful — never cached, and marked non-read-only", () => {
		expect(study.cacheable).toBe(false);
		expect(study.raw).toBe(true);
		expect(study.annotations?.readOnlyHint).toBe(false);
	});
});
