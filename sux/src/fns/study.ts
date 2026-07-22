import { hasAI, llm } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { appendOnWhitelist } from "./_kb";
import { hasDropboxFull, normFull, readFull } from "./_dropbox-full";
import { hasDropbox, sharedLink } from "./dropbox";
import { dropboxRawUrl, errMsg, fromB64, isHttpUrl, isHttpUrlStr, loadBytes, oj, putBlob } from "./_util";
import { obsidian } from "./obsidian";
import { shrinkPdfImages } from "./_pdf_shrink";
import { wayback } from "./wayback";
import { KV_PREFIX, loadKb, learnTopic, oracle, type Whitelist } from "./oracle";

// study — the WHITELISTED-KNOWLEDGE verb. You hand sux material you OWN or have the right to
// use ("whitelisted"); it DISTILLS it into a compressed knowledge index and then WEIGHTS that
// material ABOVE the model's own knowledge and web research when answering. This is assisted
// note-taking over an owned document (a compressed index, never a verbatim reproduction) — NOT
// training on copyrighted data, NOT scraping.
//
// Reuse spine (do NOT reinvent distillation): the KB is an `oracle` topic KB — study calls
// oracle's `learnTopic()` and stamps a WHITELIST provenance marker onto it, so oracle's own
// answer path and `recall`'s oracle source both see it and rank it above model + web. The
// user's uploaded file stays where it is (their personal copy); study stores ONLY the distilled
// index + a git-versioned provenance ledger line (the auditable copyright story).
//
// COPYRIGHT / SAFETY (hard): study only ever distills the material the caller SUPPLIES — it
// fetches EXACTLY the one url/path given and never crawls or expands to find a work. It stores
// the compressed distillation, never a full-text clone. Writes are additive + reversible (KV KB
// + vault appends, git = the undo; `action:"forget"` removes the KB). No send, nothing irreversible.

/** How the source material is supplied. `auto` (default) infers from the source string. */
type Kind = "text" | "url" | "pdf" | "auto";

/** Below this the material is one distill pass; above it we split into bounded segments so a
 *  real book/manual builds a multi-note KB (oracle re-distills the rolling set) rather than
 *  distilling only its opening pages. Kept under oracle's DISTILL_INPUT_CAP (24k). */
const SEGMENT_CHARS = 18_000;
/** Cap the segments so "study a whole book" stays bounded (and inside oracle's MAX_CHUNKS). */
const MAX_SEGMENTS = 8;

/** Infer the source kind from the string: an http(s) URL ending .pdf → pdf, other http(s) → url,
 *  a leading-slash/~ file path or a bare *.pdf name → pdf (a vault/Dropbox upload), else inline text. */
function detectKind(source: string): "text" | "url" | "pdf" {
	const s = source.trim();
	if (isHttpUrl(s)) return /\.pdf(\?|#|$)/i.test(s) ? "pdf" : "url";
	if (/^[/~]/.test(s) || /\.pdf$/i.test(s)) return "pdf";
	return "text";
}

/** Split oversized material into ≤MAX_SEGMENTS paragraph-aligned pieces of ~SEGMENT_CHARS each, so
 *  each becomes one oracle distill pass. Short material is a single segment (one pass, unchanged).
 *  Once the segment cap is reached the remaining paragraphs are swept into the final segment (which
 *  learnTopic then bounds to its own DISTILL_INPUT_CAP), so no text is silently dropped or duplicated. */
function segments(text: string): string[] {
	const t = text.trim();
	if (t.length <= SEGMENT_CHARS) return [t];
	const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i < paras.length; i++) {
		const para = paras[i];
		if (cur && cur.length + para.length + 2 > SEGMENT_CHARS) {
			out.push(cur);
			cur = "";
			if (out.length >= MAX_SEGMENTS - 1) {
				cur = paras.slice(i).join("\n\n"); // final segment sweeps up the rest
				break;
			}
		}
		cur = cur ? `${cur}\n\n${para}` : para;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/** The source-resolution half of `extractDocText` (#1283 hoist — the assimilation spine needs
 *  bytes BEFORE deciding whether to transcribe inline or route a book-scale input durable): an
 *  http(s) url or a Dropbox file path (Mode A shared link preferred, Mode B fallback) is read to
 *  bytes; an already-textual Dropbox file short-circuits to `text`. Throws (caller wraps) when
 *  the source can't be read. */
export async function resolveDocSource(env: RtEnv, source: string): Promise<{ name: string; bytes?: Uint8Array; text?: string }> {
	const s = source.trim();
	let bytes: Uint8Array;
	let name: string;

	if (isHttpUrlStr(s)) {
		const loaded = await loadBytes(env, { url: s });
		bytes = loaded.bytes;
		try {
			name = decodeURIComponent(new URL(s).pathname.split("/").filter(Boolean).pop() ?? "") || "document.pdf";
		} catch {
			name = "document.pdf";
		}
	} else {
		// A Dropbox path the user uploaded. Prefer Mode A (the app-folder credential most
		// deployments actually have configured, #768) via a shared link forced to a raw
		// download; only require Mode B (whole-account) when Mode A isn't configured or the
		// path isn't reachable through it (e.g. a path outside the app folder).
		const path = s;
		let modeAUrl: string | undefined;
		if (hasDropbox(env)) {
			try {
				modeAUrl = await sharedLink(env, path.startsWith("/") ? path : `/${path}`);
			} catch {
				modeAUrl = undefined; // fall through to Mode B
			}
		}
		if (modeAUrl) {
			bytes = (await loadBytes(env, { url: dropboxRawUrl(modeAUrl) })).bytes;
			name = path.split("/").pop() || "document.pdf";
		} else {
			if (!hasDropboxFull(env)) {
				throw new Error(`Reading '${s}' needs the app-folder Dropbox binding (for a path in /Apps/…) or the whole-Dropbox (Mode B) binding (DROPBOX_FULL_*). Pass an http(s) URL, or extract the text yourself and study it as { kind: "text" }.`);
			}
			const p = normFull(s);
			const rd = await readFull(env, p);
			name = String(rd.path ?? p).split("/").pop() || "document.pdf";
			if (typeof rd.text === "string") return { text: rd.text, name }; // already textual — no transcription needed
			if (rd.too_large_to_inline && typeof rd.temporary_link === "string") {
				bytes = (await loadBytes(env, { url: rd.temporary_link })).bytes; // stream the big file via its temp link
			} else if (typeof rd.base64 === "string") {
				bytes = fromB64(rd.base64);
			} else {
				throw new Error(`Could not read bytes for '${s}' from Dropbox.`);
			}
		}
	}
	return { name, bytes };
}

/** The transcription half of `extractDocText` (#1283 hoist — callers that already hold document
 *  bytes, e.g. the assimilation spine fed by radar/mail, transcribe without re-deriving Mode A/B
 *  source resolution). Throws (caller wraps) when the toMarkdown binding is unavailable or the
 *  document yields no text. */
export async function docBytesToMarkdown(env: RtEnv, name: string, bytes: Uint8Array): Promise<string> {
	// Workers-AI document conversion (PDF/office/image → markdown, OCR included). Feature-detected:
	// the older AI binding only declares run(), and vitest has no real binding — so a missing
	// toMarkdown is a clean "extract it yourself" error, never a throw the caller can't act on.
	const ai = env.AI as unknown as { toMarkdown?: (docs: Array<{ name: string; blob: Blob }>) => Promise<Array<{ data?: string }> | { data?: string }> };
	if (typeof ai?.toMarkdown !== "function") {
		throw new Error("PDF text extraction needs the Workers-AI toMarkdown binding. Extract the text yourself and study it as { kind: \"text\" }.");
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any — Blob accepts a BufferSource at runtime; the Worker types omit the BlobPart alias.
	const res = await ai.toMarkdown([{ name, blob: new Blob([bytes] as any, { type: "application/pdf" }) }]);
	const md = (Array.isArray(res) ? res[0]?.data : (res as { data?: string })?.data) ?? "";
	const text = String(md).trim();
	if (!text) throw new Error(`Extracted no text from '${name}'. If it is a scanned image PDF, OCR it first and study the text as { kind: "text" }.`);
	return text;
}

/** Resolve a pdf/document source to text. An http(s) url or a Dropbox file path (Mode B) is read
 *  to bytes, then Workers-AI `toMarkdown` transcribes the document (native PDF text + image OCR).
 *  A textual Dropbox file is returned as-is. Throws (caller wraps) when the source can't be read or
 *  the toMarkdown binding is unavailable — the caller is told to pass the extracted `text` instead. */
export async function extractDocText(env: RtEnv, source: string): Promise<{ text: string; name: string; bytes?: Uint8Array }> {
	const resolved = await resolveDocSource(env, source);
	if (typeof resolved.text === "string") return { text: resolved.text, name: resolved.name };
	const text = await docBytesToMarkdown(env, resolved.name, resolved.bytes!);
	// bytes are the ORIGINAL document bytes (pre-transcription) — archiveKnowledge's R2 leg for a
	// Dropbox-path pdf (#1239) reuses these instead of re-deriving Mode A/B, since a Dropbox path
	// has no directly re-fetchable URL of its own.
	return { text, name: resolved.name, bytes: resolved.bytes };
}

/** List every whitelisted oracle topic with its provenance — the audit view of what's been studied. */
export async function listWhitelisted(env: RtEnv): Promise<Array<{ topic: string; whitelist: Whitelist; chunk_count: number; updated_at: number }>> {
	const kv = env.OAUTH_KV;
	if (!kv) return [];
	const topics: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: KV_PREFIX, cursor });
		for (const k of page.keys) topics.push(k.name.slice(KV_PREFIX.length));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	const out: Array<{ topic: string; whitelist: Whitelist; chunk_count: number; updated_at: number }> = [];
	for (const topic of topics) {
		const kb = await loadKb(env, topic);
		if (kb?.whitelist) out.push({ topic, whitelist: kb.whitelist, chunk_count: kb.chunks.length, updated_at: kb.updated_at });
	}
	out.sort((a, b) => a.topic.localeCompare(b.topic));
	return out;
}

type ArchiveResult = {
	r2?: { url: string; sha256: string; size: number };
	/** The optimize-original leg (#1276): a PDF's image-recompressed copy, archived
	 *  ALONGSIDE the authoritative original in `r2`. Present only when the shrink
	 *  actually reduced size; both sha256 handles are recorded, original stays canonical. */
	optimized?: { url: string; sha256: string; size: number; images: number; saved_pct: number };
	wayback?: string;
	vault_note?: string;
	skipped?: string;
};

const INSIGHT_CARD_SYSTEM =
	"Reorganize the following distilled knowledge notes into a per-book insight card using exactly these four markdown headings, in this order: \"## Core models\", \"## Techniques\", \"## When to use\", \"## Notable passages\". Bullet points under each heading, drawn ONLY from the material given — never invent anything not present in it. Under \"## Notable passages\", quote 2-4 short (<=30 words) excerpts verbatim from the material, each as a blockquote line starting with \"> \". If a heading has nothing to say from the material, write \"(none)\" under it rather than inventing content. Output ONLY the four headings and their content — no preamble, no closing remarks.";

/** Reorganize a topic's rolling distilled note into the #1209/#1239 per-book insight-card shape
 *  (core models · techniques · when-to-use · notable passages) instead of embedding the flat
 *  distillation blob. Best-effort: falls back to the raw distilled text (today's shape) when AI
 *  is unavailable or the call fails/returns empty — never blocks the archive it's part of. Quotes
 *  are drawn from the already-distilled note (not the original material, never persisted), so
 *  they aren't page-cited — the pipeline has no page-boundary tracking to cite truthfully. */
async function structureInsightCard(env: RtEnv, distilled: string): Promise<string> {
	if (!hasAI(env)) return distilled;
	try {
		const card = (await llm(env, INSIGHT_CARD_SYSTEM, distilled.slice(0, 6_000), 900, "structure insight card")).trim();
		return card || distilled;
	} catch {
		return distilled;
	}
}

/** The other two legs of the #1184 W4 three-sink ingestion pipeline (learnTopic's oracle chunk
 *  store is already the "full text into a messy model" leg — this only adds the two MISSING
 *  legs): archive the original bytes to R2 (a Dropbox-path pdf's bytes are supplied by the
 *  caller via `sourceBytes` — extractDocText already fetched them once for transcription, #1239
 *  — so this never re-derives Mode A/B credentials itself), fire a best-effort Wayback snapshot
 *  for a url source, and write a per-book insight-card note (core models · techniques ·
 *  when-to-use · notable passages, via `structureInsightCard`, #1239). Every step is
 *  independently best-effort: an archive-leg failure must never fail the underlying
 *  distill/whitelist the caller already got. */
async function archiveKnowledge(
	env: RtEnv,
	opts: {
		topic: string;
		title?: string;
		sourceLabel: string;
		resolvedKind: "text" | "url" | "pdf";
		rawSource: string;
		material: string;
		distilled: string;
		sourceBytes?: Uint8Array;
	},
): Promise<ArchiveResult> {
	const result: ArchiveResult = {};

	try {
		let bytes: Uint8Array | undefined;
		let contentType = "text/plain; charset=utf-8";
		if (opts.resolvedKind === "text") {
			bytes = new TextEncoder().encode(opts.material);
		} else if (opts.resolvedKind === "pdf" && opts.sourceBytes) {
			bytes = opts.sourceBytes; // pre-fetched pdf bytes (http or Dropbox path, #1239)
			contentType = "application/pdf";
		} else if (isHttpUrlStr(opts.rawSource)) {
			bytes = (await loadBytes(env, { url: opts.rawSource })).bytes;
			contentType = opts.resolvedKind === "pdf" ? "application/pdf" : "text/html; charset=utf-8";
		}
		if (bytes) {
			const ref = await putBlob(env, bytes, contentType);
			result.r2 = { url: ref.url, sha256: ref.sha256, size: ref.size };
			// Optimize-original leg (#1276): a PDF also gets an image-recompressed copy
			// archived beside the authoritative original — BOTH sha256 handles are recorded
			// (r2 = original, canonical; optimized = the cheaper archive tier). Best-effort:
			// shrinkPdfImages never throws and returns the original bytes on any no-gain/
			// failure, so a shrink that doesn't help simply omits `optimized`.
			if (contentType === "application/pdf") {
				const shr = await shrinkPdfImages(env, bytes);
				if (shr.shrunk) {
					const oref = await putBlob(env, shr.bytes, "application/pdf");
					result.optimized = {
						url: oref.url,
						sha256: oref.sha256,
						size: oref.size,
						images: shr.imagesRecompressed,
						saved_pct: Number((((shr.inputBytes - shr.outputBytes) / shr.inputBytes) * 100).toFixed(1)),
					};
				}
			}
		} else {
			result.skipped = "source bytes were not directly fetchable here — not archived to R2.";
		}
	} catch (e) {
		result.skipped = `R2 archive failed: ${errMsg(e)}`;
	}

	if (opts.resolvedKind === "url" && isHttpUrlStr(opts.rawSource)) {
		try {
			const wb = await wayback.run(env, { url: opts.rawSource });
			if (!wb.isError) {
				const j = JSON.parse(wb.content?.[0]?.text ?? "{}");
				if (j?.available && typeof j.url === "string") result.wayback = j.url;
			}
		} catch {
			// Wayback is a nice-to-have snapshot, never load-bearing for the archive.
		}
	}

	try {
		const slug = (opts.title ?? opts.topic).trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || opts.topic;
		const path = `Knowledge/Distilled/${slug}.md`;
		const card = await structureInsightCard(env, opts.distilled);
		const body = [
			"---",
			"type: distilled-knowledge",
			`topic: ${opts.topic}`,
			`source: ${opts.sourceLabel}`,
			`created: ${new Date().toISOString()}`,
			"---",
			"",
			`# ${opts.title ?? opts.topic}`,
			"",
			card,
			"",
			"## Provenance",
			`- Source: ${opts.sourceLabel}`,
			`- R2 archive: ${result.r2 ? result.r2.url : "(not archived)"}`,
			...(result.optimized ? [`- Optimized (image-shrunk) archive: ${result.optimized.url} (${result.optimized.saved_pct}% smaller, ${result.optimized.images} image(s); original above stays authoritative)`] : []),
			...(result.wayback ? [`- Wayback: ${result.wayback}`] : []),
			`- Query: oracle({ problem: "…", topic: "${opts.topic}" })`,
			"",
		].join("\n");
		const r = await obsidian.run(env, { action: "write", path, content: body, backend: "git" });
		if (!r.isError) result.vault_note = path;
	} catch (e) {
		result.skipped = result.skipped ? `${result.skipped}; insight card failed: ${errMsg(e)}` : `insight card failed: ${errMsg(e)}`;
	}

	return result;
}

export const study: Fn = {
	name: "study",
	cost: 4,
	cacheable: false,
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"Learn WHITELISTED material — a document you OWN or have the right to use — into a compressed knowledge base that sux WEIGHTS ABOVE its own knowledge and web research when answering. Assisted note-taking over an owned source (a distilled index, never a verbatim copy) — not training, not scraping. " +
		"`source` is the material; `kind`: text (verbatim body, e.g. a PDF you extracted) | url (http(s) article/page/.txt, fetched + distilled) | pdf (an http(s) URL to a PDF, or a Dropbox file path you uploaded — transcribed via Workers-AI toMarkdown) | auto (default — infers from `source`). " +
		"`topic` (required) namespaces the knowledge base (it becomes a whitelisted `oracle` topic). `title` labels the provenance. It distills into an oracle topic KB and stamps a whitelist marker, so `oracle({problem,topic})` and `recall` both rank it above the model + [web]. " +
		"`action`: learn (default) → distill + whitelist; list → the studied (whitelisted) topics + provenance (the copyright audit); forget → delete one topic's KB (reversible; the git-versioned vault mirror stays as history). " +
		"COPYRIGHT-CLEAN: only the material you supply is distilled (it fetches exactly the one url/path — never crawls to find a work), and only the compressed index is stored, never a full-text clone. Additive + reversible. Query with oracle/recall. Needs the Workers-AI binding; pdf-from-file needs DROPBOX_FULL_*. Stateful — never cached. " +
		"`archive` (default true, #1239): also fan out to the two other knowledge-ingestion sinks — the original source bytes (url/pdf-via-url/pdf-via-Dropbox-path/text) archived privately to R2, a best-effort Wayback snapshot for a url source, and a per-book insight-card note (core models · techniques · when-to-use · notable passages) written to Knowledge/Distilled/<topic>.md, with provenance links. Best-effort: an archive failure never fails the underlying distill/whitelist. Pass `archive:false` to skip it.",
		inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			source: { type: "string", description: "The material: inline text, an http(s) URL, an http(s) URL to a PDF, or a Dropbox file path you uploaded." },
			kind: { type: "string", enum: ["text", "url", "pdf", "auto"], default: "auto", description: "How to read `source` (default auto: infers url/pdf/text)." },
			topic: { type: "string", description: "The knowledge-base namespace (a whitelisted oracle topic). Required for learn/forget." },
			title: { type: "string", description: "A human label for the source, recorded in the provenance ledger." },
			source_label: {
				type: "string",
				description:
					"Override the provenance `source` string that gets stamped/dedup-matched instead of inferring it from `source` (e.g. a caller resolving a Dropbox file to an http(s) URL to fetch its bytes, but wanting the KB to record `dropbox:<path>` for dedup).",
			},
			action: { type: "string", enum: ["learn", "list", "forget"], default: "learn", description: "learn (default) | list (audit the whitelisted topics) | forget (delete a topic's KB)." },
				archive: { type: "boolean", default: true, description: "Also archive the source to R2 (+ Wayback for a url) and write a Knowledge/Distilled/<topic>.md insight-card note (the three-sink ingestion pipeline). Best-effort. Default on (#1239) — pass false to skip." },
		},
	},
	raw: true,
	run: async (env: RtEnv, args: any) => {
		const action = String(args?.action ?? "learn").trim().toLowerCase();
		const topic = String(args?.topic ?? "").trim();

		try {
			if (action === "list") {
				const studied = await listWhitelisted(env);
				return ok(oj({ action, count: studied.length, topics: studied }));
			}

			if (action === "forget") {
				if (!topic) return failWith("bad_input", 'action=forget requires a `topic` — the whitelisted knowledge base to delete.');
				// Delegate to oracle's forget (same KV key space) — reversible: the git-versioned
				// vault mirror (sux/Knowledge.md, sux/Whitelisted.md) stays as legible history.
				const r = await oracle.run(env, { action: "forget", topic });
				if (r.isError) return r;
				const j = (() => {
					try {
						return JSON.parse(r.content?.[0]?.text ?? "{}");
					} catch {
						return {};
					}
				})();
				return ok(oj({ action, topic, forgotten: Boolean(j.forgotten), note: "removed the whitelisted KB from KV; the git-versioned vault mirror remains as history (git is the vault undo)." }));
			}

			if (action !== "learn") return failWith("bad_input", `Unknown action '${action}'. Use learn | list | forget.`);

			// ---- learn ----
			const rawSource = typeof args?.source === "string" ? args.source : "";
			if (!rawSource.trim()) return failWith("bad_input", "study needs a `source` — the material to learn (text, url, or pdf).");
			if (!topic) return failWith("bad_input", "study needs a `topic` — the knowledge base to file this whitelisted material under.");
			if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler) — needed to distill the material.');

			const kind: Kind = ["text", "url", "pdf", "auto"].includes(String(args?.kind)) ? (String(args.kind) as Kind) : "auto";
			const resolved = kind === "auto" ? detectKind(rawSource) : kind;
			const title = String(args?.title ?? "").trim() || undefined;

			// Resolve the material to the text (or url) oracle's learnTopic will distill.
			// - url: hand the URL straight to learnTopic (oracle fetches HTML/txt + readability).
			// - pdf: transcribe the document to text here, then distill the text.
			// - text: the caller-supplied body (this is how a PDF you already extracted is studied).
			let material: string;
			let sourceLabel: string;
			let extractedName: string | undefined;
			let sourceBytes: Uint8Array | undefined;
			if (resolved === "url") {
				material = rawSource.trim();
				sourceLabel = material; // oracle records the URL as the KB source
			} else if (resolved === "pdf") {
				const ex = await extractDocText(env, rawSource);
				material = ex.text;
				extractedName = ex.name;
				sourceBytes = ex.bytes;
				sourceLabel = isHttpUrl(rawSource) ? rawSource.trim() : `dropbox:${normFull(rawSource)}`;
			} else {
				material = rawSource;
				sourceLabel = `inline text (${material.length} chars)`;
			}
			const sourceLabelOverride = typeof args?.source_label === "string" ? args.source_label.trim() : "";
			if (sourceLabelOverride) sourceLabel = sourceLabelOverride;

			const provenance: Whitelist = { source: sourceLabel, kind: resolved, learned_at: Date.now(), via: "study", ...(title ? { title } : extractedName ? { title: extractedName } : {}) };

			// Distill. A url is one learnTopic pass (oracle fetches it). Text/pdf material is split into
			// bounded segments so a whole book builds a multi-note KB; each pass carries the SAME
			// provenance so the topic is (and stays) whitelisted. Only the compressed distillation is
			// ever stored — the extracted/supplied full text is transient and never persisted.
			const parts = resolved === "url" ? [material] : segments(material);
			let last: { chunk_count: number; distilled: string; whitelisted: boolean } | undefined;
			for (const part of parts) {
				last = await learnTopic(env, topic, part, provenance);
			}
			if (!last) return failWith("upstream_error", "study distilled nothing — retry.");

			// Git-versioned provenance ledger — the auditable copyright story (provenance only, no text).
			const provenance_logged = await appendOnWhitelist(env, topic, sourceLabel, resolved, provenance.title);

			// The three-sink ingestion pipeline (#1184 W4) is on by default (#1239) — pass
			// `archive:false` to skip it and keep a `learn` call to one oracle distill pass.
			const archived =
				args?.archive !== false
					? await archiveKnowledge(env, { topic, title: provenance.title, sourceLabel, resolvedKind: resolved, rawSource, material, distilled: last.distilled, sourceBytes })
					: undefined;

			return ok(
				oj({
					action,
					topic,
					kind: resolved,
					source: sourceLabel,
					title: provenance.title,
					whitelisted: true,
					segments: parts.length,
					chunk_count: last.chunk_count,
					distilled_preview: last.distilled.slice(0, 400),
					provenance_logged,
					archived,
					summary: `Learned '${provenance.title ?? sourceLabel}' into the whitelisted topic '${topic}' — distilled into ${last.chunk_count} note(s); the full text was not stored.`,
					query_hint: `Ask it with oracle({ problem: "…", topic: "${topic}" }) or recall({ question: "…" }) — this whitelisted KB is weighted above the model's own knowledge and web research.`,
					undo_hint: `study({ action: "forget", topic: "${topic}" })`,
				}),
			);
		} catch (e) {
			return failWith("upstream_error", `study (${action}) failed: ${errMsg(e)}`);
		}
	},
};
