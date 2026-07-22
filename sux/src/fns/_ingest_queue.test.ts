import { describe, expect, it, vi } from "vitest";

const dbx = vi.hoisted(() => ({ puts: [] as { path: string; size: number }[], usedPaths: new Set<string>() }));
vi.mock("./dropbox", () => ({
	hasDropbox: () => true,
	dropboxPut: vi.fn(async (_e: any, path: string, bytes: Uint8Array, opts?: { overwrite?: boolean }) => {
		let stored = path;
		if (opts?.overwrite === false && dbx.usedPaths.has(path)) {
			const dot = path.lastIndexOf(".");
			stored = dot === -1 ? `${path} (1)` : `${path.slice(0, dot)} (1)${path.slice(dot)}`;
		}
		dbx.usedPaths.add(stored);
		dbx.puts.push({ path: stored, size: bytes.length });
		return { path: stored, size: bytes.length, url: "https://dbx/x" };
	}),
}));
const vault = vi.hoisted(() => ({ writes: [] as { path: string; content: string }[], existing: [] as string[] }));
vi.mock("./obsidian", () => ({
	vaultCfg: (_e: any) => ({ repo: "me/vault" }),
	vaultPut: vi.fn(async (_e: any, _c: any, path: string, content: string) => {
		if (vault.existing.includes(path)) return { ok: false, exists: true, error: "exists" };
		vault.writes.push({ path, content: String(content) });
		return { ok: true, commit: "c1", created: true };
	}),
}));

// Drive the shared OCR engine (_ocr.ts) directly — extractScanText composes on ocrDocument, so we
// exercise the doc-with-text, image, keep, and extraction-failure paths through the real wiring.
// `text: null` models an image-only scan / unconfigured key (ocrDocument throws "no text").
const ocrM = vi.hoisted(() => ({ text: null as string | null, calls: 0 }));
vi.mock("./_ocr", () => ({
	ocrDocument: vi.fn(async () => {
		ocrM.calls++;
		if (ocrM.text == null) throw new Error("Mistral OCR returned no text.");
		return ocrM.text;
	}),
	// _assimilate.ts imports ocrBytes from ./_ocr; assimilation is dark in tests so it never runs.
	ocrBytes: vi.fn(async () => {
		throw new Error("Mistral OCR returned no text.");
	}),
}));

import { handleIngestBatch } from "./_ingest_queue";

const r2Stub = (objects: Record<string, Uint8Array>) => ({
	get: vi.fn(async (k: string) => (objects[k] ? { arrayBuffer: async () => objects[k].buffer } : null)),
	delete: vi.fn(async (k: string) => {
		delete objects[k];
	}),
});
const msg = (body: unknown) => {
	const m = {
		body,
		acked: false,
		retried: false,
		ack: () => {
			(m as any).acked = true;
		},
		retry: () => {
			(m as any).retried = true;
		},
	};
	return m as any;
};
const ev = (key: string) => ({ action: "PutObject", bucket: "sux-ingest", object: { key, size: 3, eTag: "e" }, eventTime: "2026-07-21T00:00:00Z" });

describe("handleIngestBatch", () => {
	it("scan/ object → dropbox + vault note + R2 delete + ack", async () => {
		const objects = { "scan/2026/07/scan_20260721.pdf": new Uint8Array([1, 2, 3]) };
		const r2 = r2Stub(objects);
		const m = msg(ev("scan/2026/07/scan_20260721.pdf"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		expect(dbx.puts[0].path).toBe("/Scans/2026/07/scan_20260721.pdf");
		expect(vault.writes[0].path).toMatch(/^Inbox\/scan-.*scan_20260721-e\.md$/);
		expect(vault.writes[0].content).toContain("source: ");
		expect(r2.delete).toHaveBeenCalledWith("scan/2026/07/scan_20260721.pdf");
		expect(m.acked).toBe(true);
	});

	it("missing object (re-delivery after delete) acks without writes", async () => {
		const before = dbx.puts.length;
		const m = msg(ev("scan/2026/07/gone.pdf"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2Stub({}) } as any);
		expect(dbx.puts.length).toBe(before);
		expect(m.acked).toBe(true);
	});

	it("existing vault note (partial re-delivery) still deletes + acks", async () => {
		vault.existing.push("Inbox/scan-2026-07-21 dup-e.md");
		const objects = { "scan/2026/07/dup.pdf": new Uint8Array([9]) };
		const r2 = r2Stub(objects);
		const m = msg(ev("scan/2026/07/dup.pdf"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		expect(m.acked).toBe(true);
		expect(r2.delete).toHaveBeenCalled();
	});

	it("unknown prefix retries (→ DLQ after max_retries), never deletes", async () => {
		const r2 = r2Stub({ "mystery/x.bin": new Uint8Array([0]) });
		const m = msg(ev("mystery/x.bin"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		expect(m.retried).toBe(true);
		expect(r2.delete).not.toHaveBeenCalled();
	});

	it("same R2 key + day + stem but different bytes (scanner filename reuse) writes distinct Dropbox paths and distinct vault notes, never clobbers (#1267)", async () => {
		const key = "scan/2026/07/scan0001.pdf";
		const evA = { action: "PutObject", bucket: "sux-ingest", object: { key, size: 3, eTag: "aaa11111" }, eventTime: "2026-07-21T00:00:00Z" };
		const evB = { action: "PutObject", bucket: "sux-ingest", object: { key, size: 3, eTag: "bbb22222" }, eventTime: "2026-07-21T00:00:00Z" };
		const beforePuts = dbx.puts.length;
		const beforeWrites = vault.writes.length;

		await handleIngestBatch({ messages: [msg(evA)] } as any, { INGEST_R2: r2Stub({ [key]: new Uint8Array([1, 2, 3]) }) } as any);
		await handleIngestBatch({ messages: [msg(evB)] } as any, { INGEST_R2: r2Stub({ [key]: new Uint8Array([9, 9, 9]) }) } as any);

		const puts = dbx.puts.slice(beforePuts);
		const writes = vault.writes.slice(beforeWrites);
		expect(puts).toHaveLength(2);
		expect(puts[0].path).toBe("/Scans/2026/07/scan0001.pdf");
		expect(puts[1].path).not.toBe(puts[0].path);
		expect(writes).toHaveLength(2);
		expect(writes[0].path).not.toBe(writes[1].path);
	});

	it("document scan WITH a text layer → note embeds the extracted text (#1284)", async () => {
		ocrM.text = "Superior Court of Washington, Small Claims. Judgment for plaintiff, case 25-2-12345.";
		ocrM.calls = 0;
		const r2 = r2Stub({ "scan/2026/07/order.pdf": new Uint8Array([1, 2, 3]) });
		const m = msg(ev("scan/2026/07/order.pdf"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		const w = vault.writes[vault.writes.length - 1];
		expect(w.content).toContain("## Extracted text");
		expect(w.content).toContain("Superior Court");
		expect(w.content).toContain("tags: [capture, scan, scan-ocr]");
		expect(r2.delete).toHaveBeenCalledWith("scan/2026/07/order.pdf");
		expect(m.acked).toBe(true);
	});

	it("image scan → saved with NO forced OCR (photo branch)", async () => {
		ocrM.text = "SHOULD NOT BE CALLED";
		ocrM.calls = 0;
		const r2 = r2Stub({ "scan/2026/07/photo.jpg": new Uint8Array([9]) });
		const m = msg(ev("scan/2026/07/photo.jpg"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		const w = vault.writes[vault.writes.length - 1];
		expect(w.content).toContain("Scanned image:");
		expect(w.content).toContain("scan-photo");
		expect(w.content).not.toContain("## Extracted text");
		expect(ocrM.calls).toBe(0); // a photo never pays for extraction
		expect(m.acked).toBe(true);
	});

	it("keep-class reference PDF → saved + signal-indexed, no full-text OCR (#1284 branch 2)", async () => {
		ocrM.text = "SHOULD NOT BE CALLED"; // keep never OCRs
		ocrM.calls = 0;
		const r2 = r2Stub({ "scan/2026/07/router-manual.pdf": new Uint8Array([7, 7]) });
		const m = msg(ev("scan/2026/07/router-manual.pdf"));
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		const w = vault.writes[vault.writes.length - 1];
		expect(w.content).toContain("scan-keep");
		expect(w.content).toContain("Saved PDF");
		expect(w.content).toContain("## Signal");
		expect(w.content).not.toContain("## Extracted text");
		expect(ocrM.calls).toBe(0); // a keep reference never pays for OCR
		expect(m.acked).toBe(true);
	});

	it("extraction failure → note still written (fail-open), still deletes + acks", async () => {
		ocrM.text = null; // ocrDocument throws "no text"; Mistral unconfigured in tests
		const objects = { "scan/2026/07/doc.pdf": new Uint8Array([5]) };
		const r2 = r2Stub(objects);
		const m = msg(ev("scan/2026/07/doc.pdf"));
		const before = vault.writes.length;
		await handleIngestBatch({ messages: [m] } as any, { INGEST_R2: r2 } as any);
		expect(vault.writes.length).toBe(before + 1);
		const w = vault.writes[vault.writes.length - 1];
		expect(w.content).toContain("image-only scan"); // honest marker, never fake/metadata text
		expect(w.content).not.toContain("## Extracted text");
		expect(r2.delete).toHaveBeenCalledWith("scan/2026/07/doc.pdf");
		expect(m.acked).toBe(true);
	});
});
