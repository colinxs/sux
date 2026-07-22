import { describe, expect, it, vi } from "vitest";
import { classifyIngestRoute, routeIngestItem, type IngestRouteDeps } from "./_ingest_route";

const env = {} as any;

function fakeDeps(overrides: Partial<IngestRouteDeps> = {}): IngestRouteDeps {
	return {
		extractText: vi.fn(async () => ({ hasText: false })),
		summarize: vi.fn(async () => undefined),
		storeOriginal: vi.fn(async () => ({ link: "https://dropbox.example/original.pdf", placement: "dropbox" })),
		ingestText: vi.fn(async (_env, args) => ({ ok: true, note: `Inbox/2026-01-01 ${args.title}.md` })),
		...overrides,
	};
}

describe("classifyIngestRoute", () => {
	it("explicit mode always wins, case-insensitive", () => {
		expect(classifyIngestRoute("whatever.pdf", { explicit: "ARCHIVE" })).toBe("archive");
		expect(classifyIngestRoute("photo.jpg", { explicit: "extract" })).toBe("extract");
		expect(classifyIngestRoute("notes.txt", { explicit: "summarize" })).toBe("summarize");
	});

	it("ignores an explicit value that isn't a real mode", () => {
		expect(classifyIngestRoute("report.pdf", { explicit: "bogus" })).toBe("extract");
	});

	it("smart-detects text-bearing doc extensions as extract", () => {
		for (const name of ["report.pdf", "letter.docx", "memo.doc", "notes.txt", "readme.md"]) {
			expect(classifyIngestRoute(name)).toBe("extract");
		}
	});

	it("smart-detects images/audio/unknown as archive", () => {
		for (const name of ["photo.jpg", "photo.png", "photo.heic", "song.mp3", "clip.wav", "data.zip", "noext"]) {
			expect(classifyIngestRoute(name)).toBe("archive");
		}
	});
});

describe("routeIngestItem", () => {
	it("archive mode never calls extractText and stores the original", async () => {
		const deps = fakeDeps();
		const bytes = new TextEncoder().encode("hello");
		const r = await routeIngestItem(env, { name: "photo.jpg", bytes, source: "test" }, deps);
		expect(deps.extractText).not.toHaveBeenCalled();
		expect(deps.storeOriginal).toHaveBeenCalledWith(env, "photo.jpg", bytes);
		expect(r.mode).toBe("archive");
		expect(r.hasText).toBe(false);
		expect(r.blob.placement).toBe("dropbox");
	});

	it("extract mode embeds extracted text in the note when available", async () => {
		const deps = fakeDeps({ extractText: vi.fn(async () => ({ text: "the full document text", hasText: true })) });
		await routeIngestItem(env, { name: "report.pdf", bytes: new Uint8Array(), source: "test" }, deps);
		const call = (deps.ingestText as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(call.text).toContain("## Extracted text");
		expect(call.text).toContain("the full document text");
		expect(call.tags).toContain("ingest-extract");
	});

	it("extract mode degrades to an honest no-text note on extraction failure — never throws", async () => {
		const deps = fakeDeps({ extractText: vi.fn(async () => { throw new Error("OCR unconfigured"); }) });
		const r = await routeIngestItem(env, { name: "report.pdf", bytes: new Uint8Array(), source: "test" }, deps);
		expect(r.hasText).toBe(false);
		const call = (deps.ingestText as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(call.text).toContain("No text could be extracted");
	});

	it("summarize mode calls summarize only when text was actually extracted", async () => {
		const deps = fakeDeps({
			extractText: vi.fn(async () => ({ text: "long document body", hasText: true })),
			summarize: vi.fn(async () => "a short summary"),
		});
		await routeIngestItem(env, { name: "report.pdf", bytes: new Uint8Array(), source: "test", mode: "summarize" }, deps);
		expect(deps.summarize).toHaveBeenCalledWith(env, "long document body");
		const call = (deps.ingestText as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(call.text).toContain("## Summary");
		expect(call.text).toContain("a short summary");
		expect(call.text).toContain("## Full text");
	});

	it("summarize mode skips summarize() when no text was extracted", async () => {
		const deps = fakeDeps();
		await routeIngestItem(env, { name: "report.pdf", bytes: new Uint8Array(), source: "test", mode: "summarize" }, deps);
		expect(deps.summarize).not.toHaveBeenCalled();
	});

	it("reuses a caller-supplied blobRef instead of storing a second copy", async () => {
		const deps = fakeDeps();
		const blobRef = { link: "/Apps/sux/ingest/foo.pdf", placement: "dropbox" };
		const r = await routeIngestItem(env, { name: "foo.pdf", bytes: new Uint8Array(), source: "test", blobRef }, deps);
		expect(deps.storeOriginal).not.toHaveBeenCalled();
		expect(r.blob).toBe(blobRef);
	});

	it("propagates a vault-write failure (the caller needs to know it's unsafe to move/ack)", async () => {
		const deps = fakeDeps({ ingestText: vi.fn(async () => ({ ok: false, error: "vault down" })) });
		await expect(routeIngestItem(env, { name: "photo.jpg", bytes: new Uint8Array(), source: "test" }, deps)).rejects.toThrow("vault down");
	});
});
