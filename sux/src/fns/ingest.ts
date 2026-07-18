import { type Fn, fail, ok } from "../registry";
import { htmlToMd } from "./_markup";
import { clampBytes, loadBytes, putBlob, vaultToday, oj } from "./_util";
import { dropboxPut, hasDropbox } from "./dropbox";
import { embedOne } from "./_embed";
import { appendInferSignal, hasInferArm } from "./_infer";
import { type VaultCfg, vaultCfg, vaultPut } from "./obsidian";
import { redactPII } from "./redact";

// Capture — the intake half of the knowledge core (docs/proposals/domains.md §3).
// Exactly one source in (url | text | query), one provenance-stamped markdown
// note out, into Inbox/ of the git-backed vault (git = truth; vaultPut warms the
// KV cache). Blob routing for non-markdown sources: ≤1MB is committed into the
// vault repo as an attachment (a vault is allowed to hold small binaries);
// larger — or blobs:"dropbox" — uploads to the Dropbox app folder and the note
// carries the shared link; R2 is the fallback when Dropbox isn't configured
// Notes are cheap intake, never polished — triage promotes them later.
const BLOB_VAULT_MAX = 1_048_576;
const BODY_MAX = 150_000;

const slugify = (s: string) =>
	s
		.toLowerCase()
		.replace(/https?:\/\//, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "capture";

const isTextCt = (ct: string) => /^text\/|^application\/(json|xml|javascript|x-yaml|yaml)|[/+](json|xml|yaml)/i.test(ct);

const urlName = (u: string): string => {
	try {
		const last = decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() ?? "");
		return last.replace(/[^\w.-]+/g, "_");
	} catch {
		return "";
	}
};

function buildNote(title: string, source: string, body: string, tags: string[]): string {
	// JSON.stringify yields a valid YAML double-quoted scalar (escapes quotes,
	// backslashes, newlines) — raw interpolation would let a hostile page title
	// or query inject frontmatter keys. Tags are clamped to the Obsidian charset.
	const tagLine = ["capture", ...tags.map((t) => String(t).replace(/[^\w/-]+/g, "-").replace(/^-+|-+$/g, "")).filter(Boolean)].join(", ");
	return `---\ntype: capture\ncreated: ${new Date().toISOString()}\nsource: ${JSON.stringify(source)}\ntags: [${tagLine}]\n---\n\n# ${title}\n\n${body}\n`;
}

// Dispatch through the registry (dynamic import avoids the index.ts cycle, same as pipe).
async function fnByName(name: string): Promise<Fn | undefined> {
	const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };
	return FUNCTIONS.find((f) => f.name === name);
}

// Write into the vault without ever clobbering an existing file: on a name
// collision, disambiguate before the extension (-1, -2, …) and retry. Capture is
// meant to never lose an earlier note/attachment; failIfExists guards every
// attempt and each uses a distinct name, so the loop terminates. Returns the
// path actually written (which the note body must reference).
async function vaultPutNoClobber(
	env: any,
	cfg: VaultCfg,
	path: string,
	content: string | Uint8Array,
	message: string,
): Promise<{ ok: true; path: string; commit?: string; created: boolean } | { ok: false; error: string }> {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash + 1; // a real extension, not a leading dot or a dot in a dir name
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	for (let i = 0; i < 8; i++) {
		const p = i === 0 ? path : `${stem}-${i}${ext}`;
		const w = await vaultPut(env, cfg, p, content, message, { failIfExists: true });
		if (w.ok) return { ok: true, path: p, commit: w.commit, created: w.created };
		if (!w.exists) return { ok: false, error: w.error };
	}
	return { ok: false, error: `ingest: '${path}' and its disambiguations are all taken — retry` };
}

const SIGNAL_SNIPPET_MAX = 1000;

/** Best-effort feed into the infer signal log (#864's substrate) — a no-op unless INFER_ARM_FILES
 *  is set, checked first so a dormant domain costs zero embed calls. Never throws into the
 *  caller: a failed embed/append must not affect a capture that already landed in the vault.
 *  Hooked here (capture's own write) rather than obsidian.ts's shared noteWritten so the signal
 *  log tracks actual new-content items, not sux's own internal bookkeeping writes (digests,
 *  ledgers) that also flow through that choke point. */
async function logFilesSignal(env: any, notePath: string, title: string, body: string): Promise<void> {
	if (!hasInferArm(env, "files")) return;
	try {
		const { redacted } = redactPII(`${title}\n${body}`.slice(0, SIGNAL_SNIPPET_MAX));
		const vec = await embedOne(env, redacted);
		await appendInferSignal(env, "files", { ts: Date.now(), vec, redacted_snippet: redacted, source_tag: `files:${notePath}` });
	} catch (e) {
		console.warn(`infer: files signal log failed for ${notePath} — ${(e as Error)?.message ?? e}`);
	}
}

export const ingest: Fn = {
	name: "ingest",
	cost: 3,
	description:
		"Capture into the Obsidian vault (git-backed = the undo; the KV cache is warmed). Exactly one source: url (HTML → markdown; text files verbatim; binary files become attachments; fetch cap 32MB) | text (verbatim body) | query (web-search results). A non-HTML/text URL (e.g. a PDF) is stored as an opaque blob here — never text-extracted or distilled. To actually extract and learn a PDF/book's content (native PDF + OCR, distilled into a whitelisted oracle topic), use `study` instead. Writes a provenance-stamped note (frontmatter type/created/source/tags) to Inbox/<date> <slug>.md — never overwriting (collisions get a time suffix) — or to an explicit `path` (overwrites). Bodies over 150k chars are truncated with a marker. Optional passes (skipped for binary captures, degrade to verbatim when AI is unavailable): summarize:true prepends an AI summary section; compress:true stores only the distilled summary — for url sources the original stays re-fetchable via provenance; for text/query the original is not retained. Blob routing: ≤1MB commits into the vault repo (![[Attachments/…]]); larger — or blobs:'dropbox' — uploads to the Dropbox app folder and the note links the shared URL (PUBLIC anyone-with-the-link; R2 fallback when Dropbox isn't configured — either DROPBOX_TOKEN or the DROPBOX_REFRESH_TOKEN+APP_KEY durable flow). Returns { note, created, commit, source, pass?, blob? }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "Capture a web page or file." },
			text: { type: "string", description: "Capture raw text/markdown as the note body." },
			query: { type: "string", description: "Run a web search and capture the results." },
			title: { type: "string", description: "Note title (derived from the source when omitted)." },
			path: { type: "string", description: "Explicit vault note path (default Inbox/<date> <slug>.md)." },
			tags: { type: "array", items: { type: "string" }, description: "Extra frontmatter tags ('capture' is always included)." },
			blobs: { type: "string", enum: ["auto", "dropbox"], default: "auto", description: "Blob routing: auto = ≤1MB into the vault repo, larger to Dropbox; dropbox = always Dropbox." },
			summarize: { type: "boolean", default: false, description: "Prepend an AI summary section above the captured body." },
			compress: { type: "boolean", default: false, description: "Store only the distilled summary instead of the full body (url sources stay re-fetchable via provenance; text/query originals are not retained)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const cfg = vaultCfg(env);
		if ("error" in cfg) return fail(cfg.error);
		const url = typeof args?.url === "string" && args.url.trim() ? String(args.url).trim() : undefined;
		const text = typeof args?.text === "string" && args.text.trim() ? String(args.text) : undefined;
		const query = typeof args?.query === "string" && args.query.trim() ? String(args.query).trim() : undefined;
		if ([url, text, query].filter(Boolean).length !== 1) return fail("Provide exactly one source: `url`, `text`, or `query`.");
		const tags = Array.isArray(args?.tags) ? args.tags.map(String) : [];
		const date = vaultToday(env.VAULT_TZ);

		try {
			let title = String(args?.title ?? "").trim();
			let source: string;
			let body: string;
			let blob: { placement: string; link: string; size: number; content_type?: string } | undefined;

			if (text) {
				title ||= text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80).trim() || "capture";
				source = "text";
				body = text;
			} else if (query) {
				const search = await fnByName("search");
				if (!search) return fail("search fn unavailable.");
				const r = await search.run(env, { query });
				const got = r.content?.[0]?.text ?? "";
				if (r.isError) return fail(`ingest query failed: ${got}`);
				title ||= query;
				source = `search: ${query}`;
				body = got;
			} else {
				const { bytes, contentType } = await loadBytes(env, { url });
				const ct = String(contentType ?? "")
					.split(";")[0]
					.trim()
					.toLowerCase();
				source = url!;
				if (/html/.test(ct)) {
					const html = new TextDecoder().decode(bytes);
					const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
					title ||= m?.[1]?.trim() || urlName(url!) || url!;
					body = htmlToMd(html);
				} else if (isTextCt(ct)) {
					title ||= urlName(url!) || url!;
					body = new TextDecoder().decode(bytes);
				} else {
					const name = urlName(url!) || `${slugify(title || "blob")}.bin`;
					title ||= name;
					const meta = [`- size: ${bytes.length} bytes`, ct ? `- content-type: ${ct}` : ""].filter(Boolean);
					if (args?.blobs === "dropbox" || bytes.length > BLOB_VAULT_MAX) {
						if (hasDropbox(env)) {
							// overwrite:false → Dropbox autorenames on collision (date-prefixed
							// so same-name files from different days never even collide); up.path
							// reflects the real stored name. hasDropbox — NOT env.DROPBOX_TOKEN —
							// so the durable refresh-token config (the production path) routes here.
							const up = await dropboxPut(env, `/attachments/${date}-${name}`, bytes, { overwrite: false });
							if ("error" in up) {
								// Token lapse / Dropbox 5xx: don't drop the capture — R2 still takes
								// the bytes so the note lands with a resolvable link. Distinct from the
								// unconfigured case so the note records that Dropbox was tried and failed.
								console.warn(`ingest: dropbox upload failed, falling back to R2 — ${up.error}`);
							} else {
								blob = { placement: "dropbox", link: up.url ?? up.path, size: bytes.length, content_type: ct || undefined };
							}
						}
						if (!blob) {
							const ref = await putBlob(env, bytes, ct || "application/octet-stream");
							blob = { placement: hasDropbox(env) ? "r2 (dropbox upload failed)" : "r2 (Dropbox not configured)", link: ref.url, size: bytes.length, content_type: ct || undefined };
						}
						body = [
							/^https?:/.test(blob.link) ? `[${name}](${blob.link})` : `Dropbox: \`${blob.link}\` (no shared link minted — check the token's sharing scope)`,
							"",
							...meta,
							`- stored: ${blob.placement}${blob.placement === "dropbox" && /^https?:/.test(blob.link) ? " (public shared link)" : ""}`,
						].join("\n");
					} else {
						// No-clobber: two different files sharing a name on the same day get
						// distinct attachments instead of the second overwriting the first.
						const w = await vaultPutNoClobber(env, cfg, `Attachments/${date}-${name}`, bytes, `sux: ingest attachment ${name}`);
						if (!w.ok) return fail(w.error);
						blob = { placement: "vault", link: w.path, size: bytes.length, content_type: ct || undefined };
						body = [`![[${w.path}]]`, "", ...meta, "- stored: vault"].join("\n");
					}
				}
			}

			// Optional distillation passes (never on blob stubs). Degrade, don't fail:
			// a capture that lands verbatim beats one that bounces because AI was down.
			let pass: string | undefined;
			if (args?.summarize === true || args?.compress === true) {
				if (blob) pass = "skipped (binary capture)";
				else {
					const sum = await fnByName("summarize");
					const r = sum ? await sum.run(env, { text: body, style: args?.compress === true ? "bullets" : "paragraph" }) : undefined;
					const summary = r && !r.isError ? (r.content?.[0]?.text ?? "").trim() : "";
					if (!summary) pass = "summarize unavailable — captured verbatim";
					else if (args?.compress === true) {
						// Only a url capture is honestly re-fetchable; text/query originals live nowhere else.
						body = `${summary}\n\n> ${url ? "compressed capture — full content re-fetchable from \`source\`" : "distilled at capture — the original was not retained"}`;
						pass = "compressed";
					} else {
						body = `## Summary\n\n${summary}\n\n---\n\n${body}`;
						pass = "summarized";
					}
				}
			}

			title = title.replace(/\s+/g, " ").trim() || "capture";
			const explicit = String(args?.path ?? "").trim();
			const md = buildNote(title, source, clampBytes(body, BODY_MAX), tags);
			// An explicit `path` overwrites intentionally. A default Inbox path never
			// clobbers: same-slug same-day captures disambiguate (-1, -2, …) so no
			// earlier note is lost, even for two captures in the same second.
			let notePath: string;
			let w: { ok: true; commit?: string; created: boolean } | { ok: false; error: string };
			if (explicit) {
				notePath = explicit;
				w = await vaultPut(env, cfg, explicit, md, `sux: ingest ${title.slice(0, 60)}`);
			} else {
				const nc = await vaultPutNoClobber(env, cfg, `Inbox/${date} ${slugify(title)}.md`, md, `sux: ingest ${title.slice(0, 60)}`);
				notePath = nc.ok ? nc.path : `Inbox/${date} ${slugify(title)}.md`;
				w = nc;
			}
			if (!w.ok) return fail(w.error);
			await logFilesSignal(env, notePath, title, body);
			return ok(oj({ ok: true, note: notePath, created: w.created, commit: w.commit, source, ...(pass ? { pass } : {}), ...(blob ? { blob } : {}) }));
		} catch (e) {
			return fail(`ingest failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
