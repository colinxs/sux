// Ingest routing modes (#1357): the ONE routing layer shared by every ingest source — the
// Dropbox app-folder watcher and the ingest@suxos.net email door (both #1355) so far, with the
// scan-share queue (_scan_ingest.ts/_ingest_queue.ts) free to adopt it later without change here.
// KISS, deterministic first: explicit (a subfolder name / an email subject prefix) always beats
// inferred, and the smart-detect fallback is a pure ext table — never an LLM call to decide.
//
// Image handling deliberately does NOT match this issue's original "OCR jpg/png/heic, else a
// photo note" sketch — _scan_ingest.ts's classifyScan (Colin's SHARPENED same-day spec, 2026-07-22)
// already settled this for the sibling scan pipeline: "if it's an image then obviously just save
// the file", no OCR. Routing an image to "archive" here keeps the two pipelines' behavior
// consistent instead of re-litigating a decision that was just made.
import type { RtEnv } from "../registry";
import { extractScanText } from "./_scan_ingest";
import { dropboxPut, hasDropbox } from "./dropbox";
import { errMsg, putBlob, vaultToday } from "./_util";

export const INGEST_ROUTE_MODES = ["extract", "summarize", "archive"] as const;
export type IngestRouteMode = (typeof INGEST_ROUTE_MODES)[number];

const isRouteMode = (v: unknown): v is IngestRouteMode => (INGEST_ROUTE_MODES as readonly string[]).includes(String(v ?? "").trim().toLowerCase());

// pdf/docx/txt/md → extract (their text is the point). Everything else (images, audio, unknown) →
// archive: save + index by filename, never a blind OCR/transcode attempt on a format that isn't
// text-bearing by nature. Audio gets no transcription pipeline yet (#1357: "if the pipeline
// exists" — it doesn't in this repo), so it archives too.
const DOC_EXT_RE = /\.(pdf|docx?|txt|md)$/i;
const PLAIN_TEXT_EXT_RE = /\.(txt|md)$/i;

/**
 * Resolve the handling for one ingest item. `explicit` is the caller's subfolder name (Dropbox
 * `ingest/extract/…`) or subject-line prefix (`extract:`/`summarize:`/`archive:`) — when it
 * names a real mode it wins outright, no smart-detect. Otherwise: extract for text-bearing doc
 * formats, archive for everything else (images/audio/unrecognized).
 */
export function classifyIngestRoute(name: string, opts: { explicit?: string } = {}): IngestRouteMode {
	if (isRouteMode(opts.explicit)) return String(opts.explicit).trim().toLowerCase() as IngestRouteMode;
	return DOC_EXT_RE.test(name) ? "extract" : "archive";
}

/** A durable home the caller already minted for the original bytes (e.g. the Dropbox watcher's
 *  source file, left in place until the sweep moves it) — routeIngestItem reuses this instead of
 *  re-uploading a second copy. Omit it and routeIngestItem stores one itself (the email door's
 *  case: the attachment has no home yet). */
export type IngestRouteBlobRef = { link: string; placement: string };

export type IngestRouteInput = {
	name: string;
	bytes: Uint8Array;
	/** Explicit override (subfolder name / subject prefix); unset or not a real mode → smart-detect. */
	mode?: string;
	/** Human-readable provenance line for the note (e.g. "Dropbox ingest/extract/foo.pdf" or "email from x@y.com"). */
	source: string;
	title?: string;
	tags?: string[];
	blobRef?: IngestRouteBlobRef;
};

export type IngestRouteResult = {
	mode: IngestRouteMode;
	notePath?: string;
	hasText: boolean;
	blob: IngestRouteBlobRef;
};

/** Injectable seams (mirrors _email_ingest.ts's EmailIngestDeps DI shape) so the branching logic
 *  is unit-testable without real vault/Dropbox/R2/AI bindings. */
export type IngestRouteDeps = {
	extractText: (env: RtEnv, name: string, bytes: Uint8Array) => Promise<{ text?: string; hasText: boolean; error?: string }>;
	summarize: (env: RtEnv, text: string) => Promise<string | undefined>;
	storeOriginal: (env: RtEnv, name: string, bytes: Uint8Array) => Promise<IngestRouteBlobRef>;
	ingestText: (env: RtEnv, args: { text: string; title?: string; tags?: string[] }) => Promise<{ ok: boolean; note?: string; error?: string }>;
};

async function defaultExtractText(env: RtEnv, name: string, bytes: Uint8Array): Promise<{ text?: string; hasText: boolean; error?: string }> {
	if (PLAIN_TEXT_EXT_RE.test(name)) {
		const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes).trim();
		return { text, hasText: text.length > 0 };
	}
	return extractScanText(env, name, bytes);
}

async function defaultSummarize(env: RtEnv, text: string): Promise<string | undefined> {
	const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Array<{ name: string; run: (env: RtEnv, args: unknown) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> }> };
	const summarize = FUNCTIONS.find((f) => f.name === "summarize");
	if (!summarize) return undefined;
	const r = await summarize.run(env, { text, style: "paragraph" });
	if (r.isError) return undefined;
	return (r.content?.[0]?.text ?? "").trim() || undefined;
}

async function defaultStoreOriginal(env: RtEnv, name: string, bytes: Uint8Array): Promise<IngestRouteBlobRef> {
	const date = vaultToday(env.VAULT_TZ);
	if (hasDropbox(env)) {
		const up = await dropboxPut(env, `/ingest/attachments/${date}-${name}`, bytes, { overwrite: false });
		if (!("error" in up)) return { link: up.url ?? up.path, placement: "dropbox" };
	}
	const ref = await putBlob(env, bytes, "application/octet-stream");
	return { link: ref.url, placement: "r2" };
}

async function defaultIngestText(env: RtEnv, args: { text: string; title?: string; tags?: string[] }): Promise<{ ok: boolean; note?: string; error?: string }> {
	const { ingest } = await import("./ingest");
	const r = await ingest.run(env, args);
	if (r.isError) return { ok: false, error: r.content?.[0]?.text };
	try {
		const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
		return { ok: true, note: typeof parsed?.note === "string" ? parsed.note : undefined };
	} catch {
		return { ok: true };
	}
}

export function defaultIngestRouteDeps(): IngestRouteDeps {
	return { extractText: defaultExtractText, summarize: defaultSummarize, storeOriginal: defaultStoreOriginal, ingestText: defaultIngestText };
}

/**
 * Route one ingest item end-to-end: classify → (extract/summarize text) → store the original →
 * write a provenance-stamped vault note (via `ingest`'s own text path, so dedup/assimilate/
 * signal-logging all apply for free) → return the outcome. NEVER throws — extraction failures
 * degrade to an honest "no text extracted" note rather than losing the file (the original is
 * always stored first). Only a vault-write failure (the durable home itself) propagates, since a
 * caller (the Dropbox sweep, the email handler) needs to know whether it's safe to move/ack.
 */
export async function routeIngestItem(env: RtEnv, input: IngestRouteInput, deps: IngestRouteDeps = defaultIngestRouteDeps()): Promise<IngestRouteResult> {
	const mode = classifyIngestRoute(input.name, { explicit: input.mode });
	const title = input.title || input.name;

	let text: string | undefined;
	let hasText = false;
	if (mode !== "archive") {
		try {
			const ex = await deps.extractText(env, input.name, input.bytes);
			if (ex.hasText && ex.text) {
				text = ex.text;
				hasText = true;
			}
		} catch (e) {
			console.warn(`ingest-route: extraction failed for ${input.name} (archiving instead) — ${errMsg(e)}`);
		}
	}

	let summary: string | undefined;
	if (mode === "summarize" && hasText && text) {
		summary = await deps.summarize(env, text).catch(() => undefined);
	}

	const blob = input.blobRef ?? (await deps.storeOriginal(env, input.name, input.bytes));
	const link = /^https?:/i.test(blob.link) ? `[${input.name}](${blob.link})` : `\`${blob.link}\``;

	const bodyLines = [`**Source:** ${input.source}`, `**Mode:** ${mode}`, `**File:** ${link} (${blob.placement})`, ""];
	if (summary) bodyLines.push("## Summary", "", summary, "", "## Full text", "", text!, "");
	else if (hasText && text) bodyLines.push("## Extracted text", "", text, "");
	else if (mode !== "archive") bodyLines.push("> No text could be extracted — the original file is saved above.", "");

	const w = await deps.ingestText(env, { text: bodyLines.join("\n"), title, tags: ["ingest", `ingest-${mode}`, ...(input.tags ?? [])] });
	if (!w.ok) throw new Error(w.error ?? "ingest route: vault write failed");
	return { mode, notePath: w.note, hasText, blob };
}
