// Document-expiry radar (#1148): sux's own motivating agenda examples (docs/design/
// personal-agent-roadmap.md ~L25-30) are things silently expiring, but that pattern was only
// wired for MyChart (Rx/labs) and Monarch (bills). Personal legal/ID documents (passport,
// driver's license, insurance card, warranty, registration) are the same shape and had zero
// detector/ingestion/schema anywhere in the tree. This mirrors _learning_folder.ts's proven
// Dropbox-folder-watch/dedup skeleton: a scanned photo dropped in a configured app-folder path
// gets OCR'd (ocr.ts), scanned for an expiry date near a cue word ("expires"/"valid until"/
// "renew by"), and recorded as a per-document vault note (frontmatter type + expiry). The
// agenda detector (_agenda.ts's detectDocumentExpiryDrops) then reads those notes back — it
// never needs Dropbox itself, so a note written by hand works identically to one this sweep
// wrote.
//
// FAIL-CLOSED: ingestion is dormant unless DOCUMENT_RADAR_ENABLED is set (mirrors
// _briefing/_agenda/_learning_folder). Only images (a photo of a document) are OCR'd — PDF text
// extraction is a separate concern (study.ts's extractDocText) this doesn't need.
import { type RtEnv } from "../registry";
import { hasDropbox, sharedLink } from "./dropbox";
import { dropboxRawUrl, errMsg } from "./_util";
import { ledger } from "../ledger";
import { ocr } from "./ocr";
import { obsidian } from "./obsidian";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** Ingestion (the Dropbox-folder OCR sweep) may run at all. */
export const hasDocumentRadar = (env: RtEnv): boolean => flagOn(env.DOCUMENT_RADAR_ENABLED) && hasDropbox(env);
/** Detection (reading tracked-document vault notes back for the agenda loop) only needs the
 *  flag — a note can exist because this sweep wrote it, or because a human wrote it by hand. */
export const documentRadarArmed = (env: RtEnv): boolean => flagOn(env.DOCUMENT_RADAR_ENABLED);

export const documentRadarPath = (env: RtEnv): string => String(env.DOCUMENT_RADAR_PATH ?? "/documents").trim() || "/documents";
export const documentRadarVaultFolder = (env: RtEnv): string => String(env.DOCUMENT_RADAR_VAULT_FOLDER ?? "Documents").trim() || "Documents";

// One run OCRs at most this many new photos — an unattended cron sweep should never fan out an
// unbounded number of Workers-AI vision calls in one tick.
const MAX_PER_RUN = 5;
const IMAGE_RE = /\.(jpe?g|png|heic|heif)$/i;

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number): string => String(n).padStart(2, "0");

/** Normalize one of a few common raw date spellings to YYYY-MM-DD, or null if unrecognized —
 *  deliberately conservative (three explicit shapes, not a general date parser) so a false
 *  match never silently becomes the wrong date. */
function normalizeDate(raw: string): string | null {
	const s = raw.trim();
	let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;
	m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (m) return `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
	m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
	if (m) {
		const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
		if (mo) return `${m[3]}-${pad(mo)}-${pad(Number(m[2]))}`;
	}
	return null;
}

const EXPIRY_CUE_RE = /\b(?:expires?|expiration\s*(?:date)?|exp\.?|valid\s+(?:thru|through|until|to)|renew(?:al)?\s*(?:by|date)?)\b\s*[:\-]?\s*/gi;
const DATE_SNIPPET_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/;

/** Find the first date near an expiry cue word ("expires"/"valid until"/"renew by"/…) in OCR'd
 *  document text — deliberately conservative (cue-word-adjacent only, not "any date in the
 *  text") so a document's issue date or the photo's own EXIF-adjacent text doesn't get mistaken
 *  for the expiry. */
export function findExpiryDate(text: string): string | null {
	EXPIRY_CUE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = EXPIRY_CUE_RE.exec(text))) {
		const snippet = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
		const dm = snippet.match(DATE_SNIPPET_RE);
		if (dm) {
			const norm = normalizeDate(dm[0]);
			if (norm) return norm;
		}
	}
	return null;
}

const DOC_TYPE_RULES: Array<[RegExp, string]> = [
	[/\bpassport\b/i, "passport"],
	[/driver'?s?\s+licen[sc]e/i, "drivers_license"],
	[/\b(insurance\s+card|policy\s+number|insurance\s+id)\b/i, "insurance"],
	[/\bwarrant(?:y|ies)\b/i, "warranty"],
	[/\b(vehicle\s+registration|registration\s+card|license\s+plate)\b/i, "registration"],
];

/** Guess a document type from its OCR'd text — deliberately conservative keyword rules (same
 *  precision-over-recall posture as _agenda.ts's mail cue regexes), falling back to a generic
 *  "document" label rather than guessing wrong. */
export function classifyDocType(text: string): string {
	for (const [re, label] of DOC_TYPE_RULES) if (re.test(text)) return label;
	return "document";
}

const slugify = (name: string): string =>
	name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "document";

function renderNote(opts: { sourcePath: string; name: string; docType: string; expiryDate: string | null }): string {
	const fm = [
		"---",
		"type: document_radar",
		"tags: [document, document-radar]",
		`document_type: ${opts.docType}`,
		opts.expiryDate ? `expiry_date: ${opts.expiryDate}` : "expiry_date:",
		`source_path: ${opts.sourcePath}`,
		"---",
	].join("\n");
	const body = `# ${opts.name}\n\nTracked by the document-expiry radar. ${opts.expiryDate ? `Expires ${opts.expiryDate}.` : "No expiry date could be read from the scan — edit this note's \`expiry_date\` frontmatter by hand."}\n`;
	return `${fm}\n\n${body}`;
}

export type DocumentRadarEntry = { path: string; name: string };

export type DocumentRadarDeps = {
	listFolder: (env: RtEnv) => Promise<DocumentRadarEntry[]>;
	shareUrl: (env: RtEnv, path: string) => Promise<string | undefined>;
	ocrImage: (env: RtEnv, url: string) => Promise<string | undefined>;
	writeNote: (env: RtEnv, path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
};

async function defaultListFolder(env: RtEnv): Promise<DocumentRadarEntry[]> {
	const { dropbox } = await import("./dropbox");
	const path = documentRadarPath(env);
	const entries: DocumentRadarEntry[] = [];
	let cursor: string | undefined;
	do {
		const r = await dropbox.run(env, cursor ? { op: "list", path, cursor } : { op: "list", path });
		if (r.isError) throw new Error(r.content?.[0]?.text ?? `dropbox list failed for ${path}`);
		const j = JSON.parse(r.content?.[0]?.text ?? "{}");
		for (const e of j.entries ?? []) {
			if (e.kind === "file" && IMAGE_RE.test(String(e.name ?? ""))) entries.push({ path: String(e.path), name: String(e.name) });
		}
		cursor = j.has_more ? j.cursor : undefined;
	} while (cursor);
	return entries;
}

async function defaultOcrImage(env: RtEnv, url: string): Promise<string | undefined> {
	const r = await ocr.run(env, { url, prompt: "Transcribe all text in this image exactly, including any expiration/validity/renewal date." });
	if (r.isError) return undefined;
	const text = r.content?.[0]?.text ?? "";
	return text && text !== "(no text found)" ? text : undefined;
}

async function defaultWriteNote(env: RtEnv, path: string, content: string): Promise<{ ok: boolean; error?: string }> {
	const r = await obsidian.run(env, { action: "write", path, content, backend: "git" });
	if (r.isError) return { ok: false, error: r.content?.[0]?.text };
	return { ok: true };
}

export function defaultDeps(): DocumentRadarDeps {
	return { listFolder: defaultListFolder, shareUrl: sharedLink, ocrImage: defaultOcrImage, writeNote: defaultWriteNote };
}

export type DocumentRadarResult = { dormant?: true; folder?: string; total?: number; processed?: string[]; skipped?: string[]; errors?: string[] };

/** List the document-radar folder, OCR whatever hasn't been ingested yet (ledger-deduped, like
 *  _learning_folder.ts's oracle-based dedup but keyed directly off the idempotency ledger since
 *  there's no existing "already studied" store to diff against here), and write one vault note
 *  per new scan — the actual reconciliation the issue asks for. */
export async function runDocumentRadarSync(env: RtEnv, deps: DocumentRadarDeps = defaultDeps()): Promise<DocumentRadarResult> {
	if (!hasDocumentRadar(env)) return { dormant: true };

	const folder = documentRadarPath(env);
	const vaultFolder = documentRadarVaultFolder(env);
	const entries = await deps.listFolder(env);
	const led = ledger(env, "document_radar");

	const processed: string[] = [];
	const skipped: string[] = [];
	const errors: string[] = [];
	let budget = MAX_PER_RUN;

	for (const entry of entries) {
		if (await led.seen(entry.path)) continue;
		if (budget <= 0) {
			skipped.push(entry.path);
			continue;
		}
		budget--;
		try {
			const url = await deps.shareUrl(env, entry.path);
			if (!url) {
				errors.push(`${entry.path}: could not mint a shared link`);
				continue;
			}
			const text = await deps.ocrImage(env, dropboxRawUrl(url));
			if (!text) {
				errors.push(`${entry.path}: OCR returned no text`);
				continue;
			}
			const docType = classifyDocType(text);
			const expiryDate = findExpiryDate(text);
			const notePath = `${vaultFolder}/${slugify(entry.name)}.md`;
			const w = await deps.writeNote(env, notePath, renderNote({ sourcePath: entry.path, name: entry.name, docType, expiryDate }));
			if (!w.ok) {
				errors.push(`${entry.path}: ${w.error ?? "vault write failed"}`);
				continue;
			}
			await led.mark(entry.path);
			processed.push(entry.path);
		} catch (e) {
			errors.push(`${entry.path}: ${errMsg(e)}`);
		}
	}

	return { folder, total: entries.length, processed, skipped, ...(errors.length ? { errors } : {}) };
}

export type TrackedDocumentRef = { path: string; docType?: string; expiryDate?: string; label?: string };

/** Read tracked-document vault notes back (this sweep's own writes, or a hand-written note with
 *  the same frontmatter shape) for the agenda detector — a plain scanVault + frontmatter filter,
 *  same shape as _agenda.ts's other vault-derived detector inputs. */
export async function listTrackedDocuments(env: RtEnv, cap = 200): Promise<TrackedDocumentRef[]> {
	if (!documentRadarArmed(env)) return [];
	const { scanVault } = await import("../vault-mcp");
	const { records } = await scanVault(env, documentRadarVaultFolder(env), cap);
	return records
		.filter((r) => r.fm?.type === "document_radar")
		.map((r) => ({
			path: r.path,
			docType: typeof r.fm.document_type === "string" ? r.fm.document_type : undefined,
			expiryDate: typeof r.fm.expiry_date === "string" && r.fm.expiry_date ? r.fm.expiry_date : undefined,
			label: typeof r.fm.document_type === "string" ? r.fm.document_type : undefined,
		}));
}
