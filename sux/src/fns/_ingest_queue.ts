// General ingest queue consumer — fed by R2 event notifications on the
// sux-ingest transit bucket (docs/design/scan-to-vault-pipeline.md, suxrouter).
// Dispatches on key prefix; scans are tenant #1. Lifecycle: scan → vault →
// forget — the R2 object is deleted only after BOTH durable homes (Dropbox
// file + vault note) are confirmed, so every failure mode leaves the scan
// sitting in the previous stage, retrying. Unknown prefixes retry until DLQ
// (visible, never silently dropped).
import type { RtEnv } from "../registry";
import { dropboxPut, hasDropbox } from "./dropbox";
import { vaultCfg, vaultPut } from "./obsidian";
import { vaultInboxDir } from "./_vaultpaths";
import { assimilate, hasAssimilate } from "./_assimilate";
import { classifyScan, extractScanText, indexSignal, renderScanBody, type ScanExtract } from "./_scan_ingest";
import { shrinkPdfImages } from "./_pdf_shrink";

type R2Event = { action?: string; bucket?: string; object?: { key?: string; size?: number; eTag?: string }; eventTime?: string };

export async function handleIngestBatch(batch: MessageBatch<unknown>, env: RtEnv): Promise<void> {
	for (const m of batch.messages) {
		let done = false;
		try {
			done = await handleOne(env, (m.body ?? {}) as R2Event);
		} catch (e) {
			console.warn(`ingest-queue: ${String((e as Error)?.message ?? e)}`);
		}
		if (done) m.ack();
		else m.retry();
	}
}

async function handleOne(env: RtEnv, ev: R2Event): Promise<boolean> {
	const key = ev.object?.key ?? "";
	if (!key.startsWith("scan/")) {
		console.warn(`ingest-queue: unknown key prefix, retrying toward DLQ: ${JSON.stringify(key)}`);
		return false;
	}
	if (!env.INGEST_R2) {
		console.warn("ingest-queue: INGEST_R2 binding missing — retrying");
		return false;
	}
	const obj = await env.INGEST_R2.get(key);
	if (!obj) return true; // already processed — idempotent re-delivery after delete
	const bytes = new Uint8Array(await obj.arrayBuffer());
	const name = key.split("/").pop() ?? "scan.pdf";

	// 1. Dropbox app folder — the human-facing durable home. overwrite:false so a
	// recycled R2 key (e.g. the producer's scanner reusing a basename within the
	// same calendar month, #1267) autorenames instead of clobbering an earlier
	// scan's only durable copy; `put.path` reflects whatever name actually landed.
	// Redelivery of the SAME object is still idempotent because a true redelivery
	// only reaches this put when the earlier attempt failed before the note write
	// below (step 2) — the worst case of a genuine redelivery hitting `add` mode is
	// a harmless orphan duplicate, never data loss.
	if (!hasDropbox(env)) {
		console.warn("ingest-queue: Dropbox not configured — retrying");
		return false;
	}
	// Classify up front (photo | keep | ocr) so a "keep" reference is stored OPTIMIZED (W4 #1276
	// image recompression, fail-open → the original bytes when it can't help) — Colin's "give me
	// a pdf, just save it optimized + indexed" branch. `ocr`/`photo` store the original: OCR
	// wants the full-fidelity page, and a photo is saved as-is.
	const cls = classifyScan(name, { size: bytes.length });
	let shrinkProvenance: string[] = [];
	let toStore = bytes;
	if (cls === "keep") {
		const shr = await shrinkPdfImages(env, bytes);
		// shrinkPdfImages returns an ArrayBuffer-backed Uint8Array (original input or pdf-lib save());
		// the cast only satisfies workers-types' Uint8Array<ArrayBuffer> generic, no runtime effect.
		toStore = shr.bytes as Uint8Array<ArrayBuffer>;
		if (shr.shrunk) shrinkProvenance = [`- Optimized: recompressed ${shr.imagesRecompressed} image(s), ${shr.inputBytes}→${shr.outputBytes} bytes`];
	}
	const dbxPath = `/Scans/${key.slice("scan/".length)}`;
	const put = await dropboxPut(env, dbxPath, toStore, { overwrite: false });
	if ("error" in put) {
		console.warn(`ingest-queue: dropbox put failed: ${put.error}`);
		return false;
	}

	// 2. Vault note — path keyed on the object name PLUS a content discriminator
	// (the R2 event's own eTag) so two distinct same-day/same-stem scans (the
	// filename-reuse case above) each get their own note instead of the second
	// silently no-op'ing on `exists:true`. Redelivery of the *same* object carries
	// the same eTag → same path → still idempotent.
	const cfg = vaultCfg(env);
	if ("error" in cfg) {
		console.warn(`ingest-queue: vault not configured: ${cfg.error} — retrying`);
		return false;
	}
	const day = (ev.eventTime ?? new Date().toISOString()).slice(0, 10);
	const stem = name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
	const etag = (ev.object?.eTag ?? "").replace(/[^a-f0-9]/gi, "").slice(0, 8);
	const notePath = `${vaultInboxDir(env)}/scan-${day} ${stem}${etag ? `-${etag}` : ""}.md`;

	// Extract text — best-effort + FAIL-OPEN: a landed scan note is better than a lost one, so
	// extraction NEVER blocks the durable write. A failure degrades to the honest "image-only /
	// pending" note (Dropbox already holds the file), never a retry of the whole scan. Only the
	// `ocr` class pays for OCR (the shared Mistral engine, #1334); `keep` is indexed by its
	// filename signal without OCR, and `photo` skips extraction entirely.
	let extract: ScanExtract | undefined;
	try {
		if (cls === "ocr") extract = await extractScanText(env, name, bytes);
	} catch (e) {
		console.warn(`ingest-queue: scan extraction failed for ${name} (note kept) — ${String((e as Error)?.message ?? e)}`);
	}
	const body = renderScanBody({
		title: `Scan ${day} — ${stem}`,
		name,
		cls,
		link: put.url ?? "",
		dropboxPath: put.path,
		size: put.size,
		source: `hp-m479fdw scan ${name}`,
		extract,
		extraProvenance: shrinkProvenance,
	});
	const note = [
		"---",
		"type: capture",
		`created: ${new Date().toISOString()}`,
		`source: ${JSON.stringify(`hp-m479fdw scan ${name}`)}`,
		`tags: [capture, scan, scan-${cls}]`,
		"---",
		"",
		body,
	].join("\n");
	const w = await vaultPut(env, cfg, notePath, note, `sux: scan ingest ${name}`, { failIfExists: true });
	if (!w.ok && !w.exists) {
		console.warn(`ingest-queue: vault note failed: ${w.error}`);
		return false;
	}

	// Assimilation spine (#1284 arc acceptance: the scan becomes `oracle ask`-queryable). Dark +
	// best-effort: a no-op unless ASSIMILATE_ENABLED, it REUSES the text already extracted above
	// (no double-extraction) and NEVER blocks the confirm-before-delete contract — an index
	// failure must not resurrect a scan whose two durable homes (Dropbox + vault) are both set.
	if (w.ok) {
		const signal = indexSignal({ cls, name, extract });
		if (signal && hasAssimilate(env)) {
			try {
				await assimilate(env, { source: notePath, text: signal, kind: "text", domain: "scan" });
			} catch (e) {
				console.warn(`ingest-queue: assimilate failed for ${notePath} (note kept) — ${String((e as Error)?.message ?? e)}`);
			}
		}
	}

	// 3. Forget: both durable homes confirmed — drop the transit copy.
	await env.INGEST_R2.delete(key);
	return true;
}
