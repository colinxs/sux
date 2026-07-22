import { archiveCreate, putBytes } from "@suxos/lib";
import { hasAI, llm } from "../ai";
import { putPhi } from "../mychart";
import { makeCaps } from "../op-engine/caps";
import type { RtEnv } from "../registry";
import { embed } from "./_embed";
import { chunkText, distillProfile, newId, putChunk, type SourceChunk } from "./_source";
import { shrinkPdfImages } from "./_pdf_shrink";
import { errMsg, putBlob, sha256Hex } from "./_util";
import { ocrBytes } from "./_ocr";
import { DISTILL_SYSTEM } from "./oracle";
import { runVerb } from "./run";
import { docBytesToMarkdown, resolveDocSource } from "./study";

// _assimilate — the assimilation spine (v5 W2, #1283): ONE internal path every ingested
// document flows through — extract → distill → optimize-original → index — so any ingress
// (scan radar, mail, FHIR, tossed text) becomes semantically retrievable without its caller
// naming a topic. This is an INTERNAL MODULE, not a verb: no MCP surface, no new binding,
// no new store — it ORCHESTRATES four existing legs (the arc doc's "wire, don't design"):
//
//   1. extract  — study.ts's resolveDocSource/docBytesToMarkdown (PDFs/URLs/Dropbox paths)
//                 and _ocr.ts's Mistral OCR (images/docs); text passes through unchanged.
//   2. distill  — oracle.ts's DISTILL_SYSTEM through the guarded llm() <<<DATA>>> fence
//                 (learnTopic's ≤500-word-note tier), provenance stamped on every chunk;
//                 _source.ts's distillProfile is the rolling-summary tier (learnTopic's
//                 re-distill idea, generalized per-domain).
//   3. optimize-original — shrink hook (W4 #1276, seam below) → putBlob to R2 CAS for
//                 ordinary material; putPhi (private `phi/` prefix, NEVER a /s/ handle)
//                 for PHI. Dropbox stays the human home — this leg never touches it.
//   4. index    — _source.ts chunk+embed under namespaced domains `assim:<stream>`
//                 (assim:scan / assim:mail / assim:doc) and `phi:medical`, preserving
//                 #1242's namespace-isolation rule and the phi fence (#613).
//
// SAFETY (fail-closed): ASSIMILATE_ENABLED unset/"0"/"false"/"off" ⇒ the spine is a no-op
// that reports disabled — it never half-runs. Matches the CROSS_SEMANTIC_ENABLED bar
// exactly (a new class of unattended semantic write shouldn't arm itself just because
// AI + KV happen to be configured); the flip is Colin-only (arc doc §7 OPEN #5).
//
// FAILURE CONTRACT: extract+distill failures fail the call (the caller wraps — there is no
// distillate to protect yet). The archive and index legs are BEST-EFFORT: either failing
// degrades that leg (reported via `skipped`, logged) without corrupting the other or the
// primary distillate — "all archive/index legs best-effort; never fail the primary note."
//
// LONG INPUTS: a book-scale PDF auto-routes to the op-engine's Workflows runtime — the
// `assimilate-pdfs` walking skeleton (op-engine/registry.ts) is the home; the single PDF
// rides in as a one-entry zip (exactly the input shape that op's `unzip` head expects).
// Routing is automatic (byte threshold), never caller-picked. PHI NEVER routes durable:
// assimilate-pdfs fans out to the r2+vault sinks and pauses on a human `ask`, none of
// which is phi-fenced — oversize PHI processes inline instead (the distill input cap
// bounds the model cost regardless).
//
// All ingested material is UNTRUSTED (a scanned letter/email can embed "ignore your
// instructions…") — it only ever rides the guarded llm() as fenced data.

/** Fail-closed master switch — mirrors _cross_semantic.ts's flagOn: an explicit "0"/"false"/
 *  "off" stays off rather than arming on mere presence. */
const flagOn = (v: string | undefined): boolean => {
	const s = (v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off";
};
export const hasAssimilate = (env: RtEnv): boolean => flagOn(env.ASSIMILATE_ENABLED);

/** Above this many original-document bytes, a PDF routes to the durable Workflows runtime
 *  instead of transcribing inline — book-scale OCR + a full embed pass won't fit the
 *  synchronous request budget. Exported for the threshold test. */
export const ASSIMILATE_DURABLE_BYTES = 8 * 1024 * 1024;

/** Distill input cap — the oracle.ts DISTILL_INPUT_CAP convention (bounds one model pass). */
const DISTILL_INPUT_CAP = 24_000;

export type AssimilateKind = "text" | "pdf" | "image";
/** The ingress streams the arc doc names (§2.1): scan/mail/doc land under `assim:<stream>`;
 *  medical is ALWAYS the phi-fenced `phi:medical` — there is no non-phi medical domain. */
export type AssimilateStream = "scan" | "mail" | "doc" | "medical";

export type AssimilateInput = {
	/** Provenance label — a URL, Dropbox path, `mail:<jmap-id>`, or a freeform caller tag.
	 *  Stamped onto every stored chunk (`title`) so a retrieved passage stays citable. */
	source: string;
	/** Pre-extracted text (kind "text", or a caller that already transcribed). */
	text?: string;
	/** Original document/image bytes (kind "pdf"/"image"); resolved from `source` when absent. */
	bytes?: Uint8Array;
	contentType?: string;
	kind: AssimilateKind;
	domain: AssimilateStream;
	/** PHI-adjacent material: index under `phi:medical`, archive under the private R2 `phi/`
	 *  prefix (never a public /s/ handle), never route durable. Implied by domain "medical". */
	phi?: boolean;
};

export type AssimilateResult =
	| { status: "disabled"; note: string }
	| { status: "routed_durable"; instanceId: string; note: string }
	| {
			status: "assimilated";
			source: string;
			domain: string;
			source_id: string;
			distilled: string;
			indexed: { chunks: number; skipped?: string };
			archived: { r2_key?: string; sha256?: string; size?: number; skipped?: string };
	  };

/** The one KV/index namespace decision (#1242's isolation rule): PHI-adjacent material lives
 *  under `phi:medical`, everything else under `assim:<stream>` — a spine domain can never
 *  alias an advise bare-string domain or an `oracle:<topic>` KB. */
export function assimDomain(stream: AssimilateStream, phi?: boolean): string {
	return phi || stream === "medical" ? "phi:medical" : `assim:${stream}`;
}

/** Wrap the single oversize PDF as a one-entry zip and start the durable `assimilate-pdfs`
 *  walking skeleton on it (unzip → bounded extract fan-out → reconcile → human review →
 *  summarize → r2+vault sinks). Returns the instance handle the caller polls via `run`. */
async function routeDurable(env: RtEnv, name: string, bytes: Uint8Array): Promise<AssimilateResult> {
	const entry = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
	const zip = archiveCreate("zip", [{ name: entry, data: bytes }]);
	const handle = await putBytes(makeCaps(env).store, zip, "application/zip");
	const r = (await runVerb({ op: "assimilate-pdfs", input: handle, mode: "durable" }, env)) as { instanceId: string };
	console.log(`assimilate: routed book-scale input (${bytes.length} bytes) durable instance=${r.instanceId}`);
	return {
		status: "routed_durable",
		instanceId: r.instanceId,
		note: `Input is book-scale (${bytes.length} bytes > ${ASSIMILATE_DURABLE_BYTES}) — routed to the durable assimilate-pdfs workflow. Poll run{action:"status"} for the result.`,
	};
}

/** EXTRACT: resolve the input to prose. Text passes through; a PDF/URL/Dropbox source rides
 *  study.ts's resolution + Mistral OCR; an image rides _ocr.ts's Mistral OCR. Book-scale PDF bytes are
 *  detected here — after resolution, before the expensive transcription — and reported for
 *  the durable route. Throws (caller wraps) when nothing extractable is found. */
async function extractLeg(
	env: RtEnv,
	input: AssimilateInput,
): Promise<{ text?: string; bytes?: Uint8Array; name: string; oversize?: boolean }> {
	const fallbackName = input.source.split("/").pop() || "document";
	if (input.kind === "text" || typeof input.text === "string") {
		const text = String(input.text ?? "").trim();
		if (!text) throw new Error("assimilate: kind 'text' needs non-empty `text`.");
		return { text, bytes: input.bytes, name: fallbackName };
	}
	if (input.kind === "image") {
		if (!input.bytes?.length) throw new Error("assimilate: kind 'image' needs `bytes`.");
		let text: string;
		try {
			text = (await ocrBytes(env, input.bytes, { image: true })).trim();
		} catch (e) {
			throw new Error(`assimilate: OCR extracted no text from '${fallbackName}' (${errMsg(e)}).`);
		}
		if (!text) throw new Error(`assimilate: OCR extracted no text from '${fallbackName}'.`);
		return { text, bytes: input.bytes, name: fallbackName };
	}
	// kind "pdf": bytes given directly (radar/mail hand them over), else resolved from source.
	let bytes = input.bytes;
	let name = fallbackName;
	if (!bytes?.length) {
		const resolved = await resolveDocSource(env, input.source);
		name = resolved.name;
		if (typeof resolved.text === "string") return { text: resolved.text, name }; // already textual
		bytes = resolved.bytes;
	}
	if (!bytes?.length) throw new Error(`assimilate: could not resolve bytes for '${input.source}'.`);
	if (bytes.length > ASSIMILATE_DURABLE_BYTES) return { bytes, name, oversize: true };
	return { text: await docBytesToMarkdown(env, name, bytes), bytes, name };
}

/** OPTIMIZE-ORIGINAL (best-effort): archive the original bytes. PHI → the private `phi/`
 *  R2 prefix via putPhi (no /s/ handle is ever minted, #613); everything else → the R2 CAS
 *  via putBlob (cas/<sha256>, dedup by content). W4's pdf shrink (#1276) slots in HERE,
 *  before the write, when it lands — best-effort like the rest of this leg. Dropbox roles
 *  are untouched: R2 is the machine archive, Dropbox stays the human home. */
async function archiveLeg(
	env: RtEnv,
	opts: { phi: boolean; name: string; bytes?: Uint8Array; contentType: string },
): Promise<{ r2_key?: string; sha256?: string; size?: number; skipped?: string }> {
	if (!opts.bytes?.length) return { skipped: "no original bytes (text input)" };
	try {
		// W4 optimize-original (#1276): store the OPTIMIZED original — recompress a PDF's
		// embedded raster images before the CAS write so the archive tier stays cheap
		// (arc doc G4). Best-effort by construction: shrinkPdfImages returns the ORIGINAL
		// bytes unchanged on any no-gain/failure, so the archive never breaks and the
		// document is never lost. Applies to PHI too (still through putPhi below). The
		// human-home copy (Dropbox) is untouched — this is the machine archive tier only.
		let bytes = opts.bytes;
		if (opts.contentType === "application/pdf") {
			const shr = await shrinkPdfImages(env, bytes);
			if (shr.shrunk) {
				bytes = shr.bytes;
				console.log(`assimilate: pdf image-shrink ${shr.inputBytes}→${shr.outputBytes} bytes (${shr.imagesRecompressed} image(s))`);
			}
		}
		if (opts.phi) {
			// Content-addressed under phi/ (sha-prefixed key) so a re-assimilated document is
			// idempotent, mirroring the CAS layout — but through putPhi, which never mints the
			// public /s/ handle putBlob does (#613's fence is exactly that difference).
			const sha256 = await sha256Hex(bytes);
			const key = await putPhi(env, `assimilate/${sha256}-${opts.name}`, bytes, opts.contentType);
			return { r2_key: key, sha256, size: bytes.length };
		}
		const ref = await putBlob(env, bytes, opts.contentType);
		return { r2_key: ref.key, sha256: ref.sha256, size: ref.size };
	} catch (e) {
		const skipped = `archive skipped: ${errMsg(e)}`;
		console.log(`assimilate: ${skipped}`);
		return { skipped };
	}
}

/** INDEX (best-effort): split the DISTILLATE (never the verbatim source — corpus growth stays
 *  sublinear in ingested bytes) into passages, embed, and store under the spine domain via
 *  _source.ts's chunk substrate; then refresh the domain's rolling-summary Profile
 *  (distillProfile — learnTopic's re-distill tier, generalized). A profile hiccup only
 *  degrades the summary tier; the retrievable chunks already landed. */
async function indexLeg(
	env: RtEnv,
	opts: { domain: string; source: string; source_id: string; distilled: string },
): Promise<{ chunks: number; skipped?: string }> {
	try {
		const passages = chunkText(opts.distilled);
		if (!passages.length) return { chunks: 0, skipped: "distillate produced no indexable passages" };
		const vecs = await embed(env, passages);
		const ts = Date.now();
		for (let i = 0; i < passages.length; i++) {
			const c: SourceChunk = {
				id: newId(),
				source_id: opts.source_id,
				domain: opts.domain,
				authority: "contextual",
				title: opts.source,
				text: passages[i],
				embedding: vecs[i],
				ts: ts + i,
			};
			await putChunk(env, c);
		}
		try {
			await distillProfile(env, opts.domain);
		} catch (e) {
			console.log(`assimilate: profile refresh skipped for domain=${opts.domain}: ${errMsg(e)}`);
		}
		return { chunks: passages.length };
	} catch (e) {
		const skipped = `index skipped: ${errMsg(e)}`;
		console.log(`assimilate: ${skipped}`);
		return { chunks: 0, skipped };
	}
}

/**
 * THE spine: one ingested document in, one distillate + archived original + retrievable
 * passages out. Disabled (fail-closed) ⇒ reports so without touching anything. Book-scale
 * PDFs route durable (non-PHI only). Throws only when extract/distill can't produce the
 * primary distillate — archive/index legs degrade independently, never fatally.
 */
export async function assimilate(env: RtEnv, input: AssimilateInput): Promise<AssimilateResult> {
	if (!hasAssimilate(env)) {
		return {
			status: "disabled",
			note: "assimilate is disabled — set ASSIMILATE_ENABLED to run the ingestion spine (extract → distill → archive → index). Fail-closed: nothing runs until the flag is set, and the flip is Colin-only (v5 arc §7).",
		};
	}
	if (!hasAI(env)) throw new Error("assimilate needs the Workers AI binding (distill + embed).");
	const domain = assimDomain(input.domain, input.phi);
	const phi = domain.startsWith("phi:");
	const contentType = input.contentType ?? (input.kind === "pdf" ? "application/pdf" : input.kind === "image" ? "application/octet-stream" : "text/plain");

	// 1. extract (throws on failure — nothing to protect yet)
	const ex = await extractLeg(env, input);
	if (ex.oversize) {
		if (!phi && env.OP_WORKFLOW) return routeDurable(env, ex.name, ex.bytes!);
		// PHI never rides the durable path (r2+vault sinks + ask gate aren't phi-fenced);
		// without the Workflow binding there's no durable runtime to route to. Either way:
		// transcribe inline — the distill cap bounds the model pass regardless.
		ex.text = await docBytesToMarkdown(env, ex.name, ex.bytes!);
	}

	// 2. distill (guarded llm — the material is untrusted, fenced as data; throws on empty)
	const distilled = (await llm(env, DISTILL_SYSTEM, String(ex.text).slice(0, DISTILL_INPUT_CAP), 800, "assimilate a document")).trim();
	if (!distilled) throw new Error("assimilate distilled an empty note — retry.");

	// 3 + 4. archive + index — independent, best-effort, never fatal
	const source_id = newId();
	const archived = await archiveLeg(env, { phi, name: ex.name, bytes: ex.bytes, contentType });
	const indexed = await indexLeg(env, { domain, source: input.source, source_id, distilled });

	console.log(
		`assimilate: source=${input.source} domain=${domain} chunks=${indexed.chunks}${indexed.skipped ? " (index degraded)" : ""}${archived.skipped ? " (archive degraded)" : ""}`,
	);
	return { status: "assimilated", source: input.source, domain, source_id, distilled, indexed, archived };
}
