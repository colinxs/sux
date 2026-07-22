import { describe, expect, it, vi } from "vitest";
import { classifyDocType, findExpiryDate, hasDocumentRadar, listTrackedDocuments, runDocumentRadarSync } from "./_document_radar";

function kvStub() {
	const map = new Map<string, string>();
	return { get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ OAUTH_KV: kvStub(), ...extra }) as any;

describe("findExpiryDate", () => {
	it("finds an ISO date near an 'expires' cue", () => {
		expect(findExpiryDate("UNITED STATES PASSPORT\nExpires: 2031-04-12\nSex M")).toBe("2031-04-12");
	});

	it("finds a slash date near a 'valid until' cue", () => {
		expect(findExpiryDate("Valid until 04/12/2031 — do not photocopy")).toBe("2031-04-12");
	});

	it("finds a month-name date near a 'renew by' cue", () => {
		expect(findExpiryDate("Registration must renew by Apr. 12, 2031 or expires")).toBe("2031-04-12");
	});

	it("returns null when no cue word is present", () => {
		expect(findExpiryDate("Issued 2020-01-01 to John Smith, no cue here")).toBeNull();
	});

	it("returns null when a cue word has no adjacent date", () => {
		expect(findExpiryDate("This document expires at the discretion of the issuer")).toBeNull();
	});
});

describe("classifyDocType", () => {
	it("classifies a passport", () => {
		expect(classifyDocType("UNITED STATES OF AMERICA PASSPORT")).toBe("passport");
	});
	it("classifies a driver's license", () => {
		expect(classifyDocType("WASHINGTON STATE DRIVER LICENSE")).toBe("drivers_license");
	});
	it("falls back to 'document' when nothing matches", () => {
		expect(classifyDocType("some unrelated scanned text")).toBe("document");
	});
});

describe("hasDocumentRadar gating", () => {
	it("dormant without the flag even with Dropbox configured", () => {
		expect(hasDocumentRadar(env({ DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" }))).toBe(false);
	});
	it("dormant without Dropbox even with the flag set", () => {
		expect(hasDocumentRadar(env({ DOCUMENT_RADAR_ENABLED: "1" }))).toBe(false);
	});
});

describe("runDocumentRadarSync", () => {
	it("dormant ⇒ no-op", async () => {
		const r = await runDocumentRadarSync(env());
		expect(r).toEqual({ dormant: true });
	});

	it("OCRs new images, writes one vault note per document, and ledgers what it processed", async () => {
		const e = env({ DOCUMENT_RADAR_ENABLED: "1", DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" });
		const writeNote = vi.fn(async (_env: unknown, _path: string, _content: string) => ({ ok: true }));
		const deps = {
			listFolder: vi.fn(async () => [{ path: "/documents/passport.jpg", name: "passport.jpg" }]),
			shareUrl: vi.fn(async () => "https://dropbox.example/s/abc"),
			ocrImage: vi.fn(async () => "PASSPORT\nExpires: 2031-04-12"),
			extractPdfText: vi.fn(async () => undefined),
			writeNote,
			readNote: vi.fn(async () => undefined),
		};
		const r = await runDocumentRadarSync(e, deps);
		expect(r.processed).toEqual(["/documents/passport.jpg"]);
		expect(writeNote).toHaveBeenCalledTimes(1);
		expect(writeNote.mock.calls[0]?.[1]).toBe("Documents/passport.md");
		expect(writeNote.mock.calls[0]?.[2]).toContain("document_type: passport");
		expect(writeNote.mock.calls[0]?.[2]).toContain("expiry_date: 2031-04-12");

		// A second run with the same entry is a no-op (ledger-deduped).
		const r2 = await runDocumentRadarSync(e, deps);
		expect(r2.processed).toEqual([]);
		expect(writeNote).toHaveBeenCalledTimes(1);
	});

	it("records an error and skips the note write when OCR finds no text", async () => {
		const e = env({ DOCUMENT_RADAR_ENABLED: "1", DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" });
		const writeNote = vi.fn(async (_env: unknown, _path: string, _content: string) => ({ ok: true }));
		const r = await runDocumentRadarSync(e, {
			listFolder: vi.fn(async () => [{ path: "/documents/blank.jpg", name: "blank.jpg" }]),
			shareUrl: vi.fn(async () => "https://dropbox.example/s/abc"),
			ocrImage: vi.fn(async () => undefined),
			extractPdfText: vi.fn(async () => undefined),
			writeNote,
			readNote: vi.fn(async () => undefined),
		});
		expect(r.processed).toEqual([]);
		expect(r.errors?.[0]).toContain("OCR returned no text");
		expect(writeNote).not.toHaveBeenCalled();
	});

	it("routes a .pdf entry through extractPdfText instead of OCR (#1153)", async () => {
		const e = env({ DOCUMENT_RADAR_ENABLED: "1", DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" });
		const writeNote = vi.fn(async (_env: unknown, _path: string, _content: string) => ({ ok: true }));
		const ocrImage = vi.fn(async () => undefined);
		const extractPdfText = vi.fn(async () => "VEHICLE REGISTRATION\nExpires: 2031-04-12");
		const r = await runDocumentRadarSync(e, {
			listFolder: vi.fn(async () => [{ path: "/documents/registration.pdf", name: "registration.pdf" }]),
			shareUrl: vi.fn(async () => "https://dropbox.example/s/abc"),
			ocrImage,
			extractPdfText,
			writeNote,
			readNote: vi.fn(async () => undefined),
		});
		expect(r.processed).toEqual(["/documents/registration.pdf"]);
		expect(extractPdfText).toHaveBeenCalledWith(e, "/documents/registration.pdf");
		expect(ocrImage).not.toHaveBeenCalled();
		expect(writeNote.mock.calls[0]?.[2]).toContain("expiry_date: 2031-04-12");
	});

	it("preserves a hand-entered expiry_date when a re-process finds no date (#1154)", async () => {
		const e = env({ DOCUMENT_RADAR_ENABLED: "1", DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" });
		const writeNote = vi.fn(async (_env: unknown, _path: string, _content: string) => ({ ok: true }));
		const readNote = vi.fn(async () => "---\ntype: document_radar\nexpiry_date: 2031-04-12\n---\n\n# passport\n");
		const r = await runDocumentRadarSync(e, {
			listFolder: vi.fn(async () => [{ path: "/documents/passport.jpg", name: "passport.jpg" }]),
			shareUrl: vi.fn(async () => "https://dropbox.example/s/abc"),
			ocrImage: vi.fn(async () => "PASSPORT no date this time"),
			extractPdfText: vi.fn(async () => undefined),
			writeNote,
			readNote,
		});
		expect(r.processed).toEqual(["/documents/passport.jpg"]);
		expect(readNote).toHaveBeenCalledWith(e, "Documents/passport.md");
		expect(writeNote.mock.calls[0]?.[2]).toContain("expiry_date: 2031-04-12");
	});

	it("archives the original scan to R2 and includes the extracted text in the note (#1200)", async () => {
		const e = env({ DOCUMENT_RADAR_ENABLED: "1", DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" });
		const writeNote = vi.fn(async (_env: unknown, _path: string, _content: string) => ({ ok: true }));
		const storeOriginal = vi.fn(async () => "https://suxos.net/s/abc123");
		const r = await runDocumentRadarSync(e, {
			listFolder: vi.fn(async () => [{ path: "/documents/note.jpg", name: "note.jpg" }]),
			shareUrl: vi.fn(async () => "https://dropbox.example/s/abc"),
			ocrImage: vi.fn(async () => "Buy milk on the way home."),
			extractPdfText: vi.fn(async () => undefined),
			writeNote,
			readNote: vi.fn(async () => undefined),
			storeOriginal,
		});
		expect(r.processed).toEqual(["/documents/note.jpg"]);
		expect(storeOriginal).toHaveBeenCalledWith(e, expect.stringContaining("dropbox.example"), "image/jpeg");
		expect(writeNote.mock.calls[0]?.[2]).toContain("original_ref: https://suxos.net/s/abc123");
		expect(writeNote.mock.calls[0]?.[2]).toContain("## Extracted text");
		expect(writeNote.mock.calls[0]?.[2]).toContain("Buy milk on the way home.");
	});

	it("still writes a note when storeOriginal is absent or fails (#1200 best-effort)", async () => {
		const e = env({ DOCUMENT_RADAR_ENABLED: "1", DROPBOX_TOKEN: "t", DROPBOX_APP_FOLDER: "f" });
		const writeNote = vi.fn(async (_env: unknown, _path: string, _content: string) => ({ ok: true }));
		const r = await runDocumentRadarSync(e, {
			listFolder: vi.fn(async () => [{ path: "/documents/note.jpg", name: "note.jpg" }]),
			shareUrl: vi.fn(async () => "https://dropbox.example/s/abc"),
			ocrImage: vi.fn(async () => "Buy milk on the way home."),
			extractPdfText: vi.fn(async () => undefined),
			writeNote,
			readNote: vi.fn(async () => undefined),
		});
		expect(r.processed).toEqual(["/documents/note.jpg"]);
		expect(writeNote.mock.calls[0]?.[2]).not.toContain("original_ref:");
		expect(writeNote.mock.calls[0]?.[2]).toContain("Buy milk on the way home.");
	});
});

describe("listTrackedDocuments", () => {
	it("returns [] when the flag is unset, without touching the vault", async () => {
		expect(await listTrackedDocuments(env())).toEqual([]);
	});
});
