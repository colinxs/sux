// Scan/document ingest intelligence (v5 W3, #1284) — the shared brain the scan queue
// consumer (_ingest_queue.ts) and the toss path (ingest.ts) both route a scanned/tossed
// document through, plus the one-shot backlog reprocess. It answers the two questions the
// arc's "single scan-assimilator" needs: (1) WHICH of the three handlings does this file
// want, and (2) what TEXT (if any) can we actually pull out of it — so the vault note the
// human reads becomes readable/searchable, not a bare link-only stub.
//
// THREE-WAY ROUTING (Colin's sharpened spec, 2026-07-22):
//   • "ocr"   — a document whose text matters (a court order, a letter, a form, a scan):
//               extract the full text into the note AND index it. The small-claims-order case.
//   • "keep"  — a PDF the user just wants KEPT (a manual, a reference, a big report): DON'T
//               force full-page OCR — save the (W4 #1276-optimized) original and index a
//               LIGHTWEIGHT filename signal so it's findable cheaply, without paying for OCR.
//   • "photo" — a photo/image: just save the file, no OCR (Colin: "if it's an image then
//               obviously just save the file").
// Detection is a CHEAP DETERMINISTIC classifier (filename cues + size), never an LLM call —
// with an explicit `mode` override so a caller can force one handling ("just save this one").
//
// EXTRACTION composes on the ONE shared OCR engine (`_ocr.ts`, #1334) — Mistral OCR
// (`mistral-ocr-latest`) is the single engine: it ingests a PDF NATIVELY (the bytes are
// content-addressed into R2 and Mistral fetches the handle), no image rasterization, the clean
// fix for "a scanned PDF isn't an image". There is deliberately NO second OCR path here (the
// former inline Mistral call + Workers-AI `toMarkdown` text-layer tier + llama-vision render
// seam were removed when OCR became first-class in #1334). Mistral unconfigured/failing/empty ⇒
// `ocrDocument` throws, which this module catches into `{ hasText: false }` — never a hard error.
//
// The honest contract (do not regress): a failed or empty extraction reads as "no text", NEVER
// as a silently-empty success. When OCR yields no real text (an image-only scan with no
// MISTRAL_API_KEY) the note carries a truthful "image-only scan — text extraction pending"
// marker plus the kept PDF link, and a later reprocess (once the key lands) upgrades it in place.
import type { RtEnv } from "../registry";
import { ocrDocument } from "./_ocr";
import { errMsg } from "./_util";

/** What the caller can force, or "auto" to let the classifier decide. */
export type ScanMode = "auto" | "ocr" | "keep" | "photo";
/** The resolved handling for one file. */
export type ScanClass = "ocr" | "keep" | "photo";

const IMAGE_RE = /\.(jpe?g|png|heic|heif|gif|webp|bmp|tiff?)$/i;
const PDF_RE = /\.pdf$/i;

/** Filename cues that a file's TEXT matters (route "ocr"). Colin's explicit list plus the
 *  common personal-legal/records shapes — deliberately precision-over-recall (a miss just
 *  routes to "keep", which still saves + indexes the file, never loses it). */
const OCR_CUE_RE =
	/\b(doc|document|scan|order|letter|notice|court|agreement|contract|claim|summons|subpoena|complaint|affidavit|deed|will|form|invoice|receipt|statement|bill|tax|w-?2|1099|lease|policy|record|memo|ruling|judgment|petition|filing)\b/i;
/** Filename cues that a PDF is bulk reference the user just wants KEPT (route "keep"). */
const KEEP_CUE_RE = /\b(manual|guide|handbook|reference|spec|specification|datasheet|brochure|catalog(?:ue)?|book|whitepaper|report|slides?|presentation|ebook)\b/i;

/** A large untitled PDF with no "needs-text" cue is treated as bulk reference (keep) rather
 *  than paying to OCR it. A cued scan (e.g. "scan_*.pdf") beats this regardless of size, so a
 *  big multi-page scan still routes "ocr". */
export const LARGE_KEEP_BYTES = 8 * 1024 * 1024;

/** Below this many non-whitespace characters, an extraction is treated as empty (a
 *  page-number/stray-glyph artifact, not real document text) so a near-empty OCR result never
 *  masquerades as a successful text pull. */
const MIN_TEXT_CHARS = 24;

export const isImageName = (name: string): boolean => IMAGE_RE.test(name);
export const isPdfName = (name: string): boolean => PDF_RE.test(name);

const dense = (s: string | null | undefined): boolean => !!s && s.replace(/\s+/g, "").length >= MIN_TEXT_CHARS;

/**
 * The 3-way classifier — deterministic, no model call. An explicit `mode` (not "auto") wins
 * outright. Otherwise: an image is a "photo"; a PDF routes by filename cue (needs-text → ocr,
 * bulk-reference → keep), then by size (large & uncued → keep), defaulting to "ocr" because the
 * common case ("usually it's docs") wants its text.
 */
export function classifyScan(name: string, opts: { mode?: ScanMode; size?: number } = {}): ScanClass {
	const mode = opts.mode ?? "auto";
	if (mode !== "auto") return mode;
	if (isImageName(name)) return "photo";
	// A non-PDF, non-image toss (e.g. a .docx) still routes by cue like a PDF would.
	if (KEEP_CUE_RE.test(name) && !OCR_CUE_RE.test(name)) return "keep";
	if (OCR_CUE_RE.test(name)) return "ocr";
	if (typeof opts.size === "number" && opts.size > LARGE_KEEP_BYTES) return "keep";
	return "ocr";
}

// ── Extraction (composes on the shared _ocr.ts Mistral engine) ───────────────────────────

export type ScanExtract = {
	/** Real document text — present ONLY when OCR produced text that passed the quality gate. */
	text?: string;
	/** True iff `text` is real page text (not an empty/near-empty extraction). */
	hasText: boolean;
	/** Which engine produced the text (always "mistral" — the single OCR engine, #1334). */
	via?: string;
	/** Populated when OCR failed / was unconfigured / yielded no text — surfaced in the honest marker. */
	error?: string;
};

/** The OCR seam: given document bytes, return the extracted text or throw. Defaults to the ONE
 *  shared Mistral engine (`_ocr.ocrDocument` — content-addresses the bytes into R2 and OCRs the
 *  handle); injectable so tests drive the extraction + quality gate without real bindings or network. */
export type ScanOcr = (env: RtEnv, name: string, bytes: Uint8Array) => Promise<string>;

const defaultOcr: ScanOcr = (env, _name, bytes) => ocrDocument(env, { bytes });

/**
 * Best-effort text extraction via the shared OCR engine. NEVER throws — an OCR failure, an
 * unconfigured key, or an empty/near-empty result all come back as `{ hasText: false }` (with
 * `error` for the honest note) so the caller can write a note either way. Only the "ocr" branch
 * calls this; "keep"/"photo" never pay for OCR.
 */
export async function extractScanText(env: RtEnv, name: string, bytes: Uint8Array, opts: { ocr?: ScanOcr } = {}): Promise<ScanExtract> {
	const ocr = opts.ocr ?? defaultOcr;
	try {
		const text = (await ocr(env, name, bytes)).trim();
		if (dense(text)) return { text, hasText: true, via: "mistral" };
		return { hasText: false };
	} catch (e) {
		// e.g. ocrDocument throws "Mistral OCR returned no text." for an image-only scan with no
		// key, or an API/network error — record it for the honest marker; never propagate.
		return { hasText: false, error: errMsg(e) };
	}
}

// ── Note rendering ───────────────────────────────────────────────────────────────────────

export type ScanNoteInput = {
	title: string;
	name: string;
	cls: ScanClass;
	link: string;
	dropboxPath: string;
	size?: number;
	source: string;
	extract?: ScanExtract;
	/** Extra provenance lines (e.g. "Reprocessed: <iso>"). */
	extraProvenance?: string[];
};

// Cap the embedded text so a huge multi-page transcription can't bloat one Inbox note past the
// vault's comfort zone — the full document always stays linked (Dropbox) and indexed.
const NOTE_TEXT_MAX = 80_000;
const clampText = (s: string): string => (s.length > NOTE_TEXT_MAX ? `${s.slice(0, NOTE_TEXT_MAX)}\n\n…[truncated — see the linked PDF for the full document]` : s);

/** The one lightweight, human-safe signal line for a scan — its filename. Used for the "keep"
 *  branch and to keep an un-OCR'able scan findable by name (the Workers-AI metadata block that
 *  once enriched this is gone with the toMarkdown tier — OCR is now the only text path, #1334). */
function metaSignal(name: string): string {
	return name;
}

/**
 * Render the vault-note body for one scanned/tossed file, branch-aware and HONEST:
 *  - photo         → link the image, nothing more.
 *  - keep          → link the saved PDF + a lightweight filename signal (no full-text OCR).
 *  - ocr + text    → link the PDF + embed the extracted "## Extracted text".
 *  - ocr + no text → link the PDF + a truthful "image-only scan, text extraction pending" note.
 * The Dropbox link + `Dropbox:` provenance line are preserved on every branch (they are the
 * durable home the confirm-before-delete contract guarantees).
 */
export function renderScanBody(input: ScanNoteInput): string {
	const { name, cls, link, dropboxPath, size } = input;
	const linkLine = /^https?:/i.test(link) ? `[${name}](${link})` : `\`${link}\``;
	const provenance = [
		"## Provenance",
		`- Source: ${input.source}`,
		`- Dropbox: \`${dropboxPath}\`${typeof size === "number" ? ` (${size} bytes)` : ""}`,
		`- Scan class: ${cls}${input.extract?.via ? ` · extracted via ${input.extract.via}` : ""}`,
		...(input.extraProvenance ?? []),
	];

	if (cls === "photo") {
		return [`# ${input.title}`, "", `Scanned image: ${linkLine}`, "", ...provenance, ""].join("\n");
	}

	if (cls === "keep") {
		return [
			`# ${input.title}`,
			"",
			`Saved PDF (optimized where possible; not full-text OCR'd): ${linkLine}`,
			"",
			"> Reference document — findable by filename; open the PDF for its contents.",
			"",
			"## Signal",
			"",
			metaSignal(name),
			"",
			...provenance,
			"",
		].join("\n");
	}

	// cls === "ocr"
	if (input.extract?.hasText && input.extract.text) {
		return [
			`# ${input.title}`,
			"",
			`Scanned document: ${linkLine}`,
			"",
			"## Extracted text",
			"",
			clampText(input.extract.text),
			"",
			...provenance,
			"",
		].join("\n");
	}

	// ocr wanted, but no text came back (image-only scan / OCR unconfigured) — be truthful, keep the PDF + signal.
	const why = input.extract?.error ? ` (${input.extract.error})` : "";
	return [
		`# ${input.title}`,
		"",
		`Scanned document: ${linkLine}`,
		"",
		`> No text could be extracted — this is an image-only scan or OCR is unconfigured${why}. The PDF is saved and linked above; full-text extraction is pending an OCR provider (set MISTRAL_API_KEY, then reprocess) or a re-scan as a searchable PDF.`,
		"",
		"## Signal",
		"",
		metaSignal(name),
		"",
		...provenance,
		"",
	].join("\n");
}

/** The text handed to the assimilation spine for indexing (dark unless ASSIMILATE_ENABLED).
 *  Real page text for an OCR'd doc; a lightweight filename signal otherwise, so even a kept
 *  reference or an un-OCR'able scan stays retrievable by name. `undefined` ⇒ nothing worth
 *  indexing (a bare photo). */
export function indexSignal(input: { cls: ScanClass; name: string; extract?: ScanExtract }): string | undefined {
	if (input.cls === "photo") return undefined;
	if (input.cls === "ocr" && input.extract?.hasText && input.extract.text) return input.extract.text;
	return metaSignal(input.name);
}

// ── Backlog reprocess (the 7 already-scanned docs) ───────────────────────────────────────

export type ScanNoteRef = { path: string; content: string };
export type ReprocessDeps = {
	/** List existing scan notes (path + body). Default: obsidian git-list the inbox + read each. */
	listScanNotes: (env: RtEnv) => Promise<ScanNoteRef[]>;
	/** Resolve a Dropbox `/Scans/…` path to its original bytes. Default: study.resolveDocSource. */
	resolveBytes: (env: RtEnv, dropboxPath: string) => Promise<{ name: string; bytes: Uint8Array }>;
	/** Overwrite a note's content. Default: obsidian git write. */
	writeNote: (env: RtEnv, path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
	/** OCR seam (defaults to the shared Mistral engine). */
	ocr?: ScanOcr;
};

// Pull the Dropbox `/Scans/…` path a scan stub recorded (either the `Dropbox path:`/`Dropbox:`
// line this consumer writes, or a raw `/Scans/…` mention) plus its human link, so a reprocess
// can re-fetch the bytes without depending on the note's filename (which is etag-discriminated).
const DROPBOX_PATH_RE = /Dropbox(?:\s*path)?:\s*`([^`]+)`/i;
const SCANS_PATH_RE = /`(\/Scans\/[^`]+)`/i;
const LINK_RE = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/;
const FM_SPLIT_RE = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/;

function scanDropboxPath(content: string): string | undefined {
	const a = DROPBOX_PATH_RE.exec(content);
	if (a && a[1].startsWith("/Scans/")) return a[1];
	const b = SCANS_PATH_RE.exec(content);
	return b ? b[1] : undefined;
}

async function defaultListScanNotes(env: RtEnv): Promise<ScanNoteRef[]> {
	const { obsidian } = await import("./obsidian");
	const { vaultInboxDir } = await import("./_vaultpaths");
	const inbox = vaultInboxDir(env);
	const lr = await obsidian.run(env, { action: "list", path: inbox, backend: "git" } as never);
	if (lr.isError) throw new Error(lr.content?.[0]?.text ?? "vault list failed");
	const notes: string[] = (() => {
		try {
			return (JSON.parse(lr.content?.[0]?.text ?? "{}").notes as string[]) ?? [];
		} catch {
			return [];
		}
	})();
	const scanNotes = notes.filter((p) => /(^|\/)scan-\d{4}-\d{2}-\d{2}\b/.test(p) && p.endsWith(".md"));
	const out: ScanNoteRef[] = [];
	for (const path of scanNotes) {
		const r = await obsidian.run(env, { action: "read", path, backend: "git" } as never);
		if (!r.isError) out.push({ path, content: r.content?.[0]?.text ?? "" });
	}
	return out;
}

async function defaultResolveBytes(env: RtEnv, dropboxPath: string): Promise<{ name: string; bytes: Uint8Array }> {
	const { resolveDocSource } = await import("./study");
	const r = await resolveDocSource(env, dropboxPath);
	if (!r.bytes?.length) throw new Error(`could not resolve bytes for ${dropboxPath}`);
	return { name: r.name, bytes: r.bytes };
}

async function defaultWriteNote(env: RtEnv, path: string, content: string): Promise<{ ok: boolean; error?: string }> {
	const { obsidian } = await import("./obsidian");
	const r = await obsidian.run(env, { action: "write", path, content, backend: "git" } as never);
	return r.isError ? { ok: false, error: r.content?.[0]?.text } : { ok: true };
}

function defaultReprocessDeps(): ReprocessDeps {
	return { listScanNotes: defaultListScanNotes, resolveBytes: defaultResolveBytes, writeNote: defaultWriteNote };
}

export type ReprocessResult = {
	total: number;
	extracted: string[]; // note paths that GAINED real text this run
	rewritten: string[]; // note paths rewritten (text or refreshed honest marker)
	skipped: string[]; // already had "## Extracted text", or not a scan note
	errors: string[];
};

/**
 * Sweep every existing scan stub and re-run extraction over its Dropbox original, rewriting the
 * note body in place (frontmatter preserved). Idempotent + upgrade-friendly: a note that already
 * holds "## Extracted text" is skipped; an image-only stub with the honest "pending" marker is
 * retried, so once MISTRAL_API_KEY lands a single reprocess upgrades the whole backlog. Every
 * note is independent + best-effort — one failure never aborts the sweep. A "keep"/"photo" note
 * is never OCR'd; only an "ocr"-class scan pays for extraction.
 */
export async function reprocessScanBacklog(env: RtEnv, deps: ReprocessDeps = defaultReprocessDeps()): Promise<ReprocessResult> {
	const res: ReprocessResult = { total: 0, extracted: [], rewritten: [], skipped: [], errors: [] };
	const notes = await deps.listScanNotes(env);
	for (const note of notes) {
		const dbxPath = scanDropboxPath(note.content);
		if (!dbxPath) {
			res.skipped.push(note.path); // scan-prefixed but not an ingest scan stub
			continue;
		}
		res.total++;
		if (note.content.includes("## Extracted text")) {
			res.skipped.push(note.path); // already carries real text — nothing to upgrade
			continue;
		}
		try {
			const { name, bytes } = await deps.resolveBytes(env, dbxPath);
			const cls = classifyScan(name, { size: bytes.length });
			const extract = cls === "ocr" ? await extractScanText(env, name, bytes, { ocr: deps.ocr }) : undefined;
			const linkM = LINK_RE.exec(note.content);
			const fmM = FM_SPLIT_RE.exec(note.content);
			const fm = fmM ? fmM[1] : "";
			const titleM = /^#\s+(.+)$/m.exec(fmM ? fmM[2] : note.content);
			const title = titleM ? titleM[1].trim() : name;
			const body = renderScanBody({
				title,
				name,
				cls,
				link: linkM ? linkM[1] : dbxPath,
				dropboxPath: dbxPath,
				size: bytes.length,
				source: "scan reprocess",
				extract,
				extraProvenance: [`- Reprocessed: ${new Date().toISOString()}`],
			});
			const content = fm ? `${fm.replace(/\n+$/, "\n")}\n${body}` : body;
			const w = await deps.writeNote(env, note.path, content);
			if (!w.ok) {
				res.errors.push(`${note.path}: ${w.error ?? "write failed"}`);
				continue;
			}
			res.rewritten.push(note.path);
			if (extract?.hasText) res.extracted.push(note.path);
		} catch (e) {
			res.errors.push(`${note.path}: ${errMsg(e)}`);
		}
	}
	return res;
}
