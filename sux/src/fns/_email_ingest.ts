// Cloudflare Email Routing → sux ingest doors: vault@/files@ on a zone (#1198 P1a, #1199).
// Pointing those addresses at this Worker is an operator action in the Cloudflare dashboard
// (Email Routing → Address rules) — a zone/DNS config step this code never touches; this file
// is only the handler side, wired in as `email()` (src/index.ts).
//
// Gate FIRST, always, before any vault/R2 write:
//   1. EMAIL_INGEST_ENABLED — the universal fail-closed flag. Unset ⇒ the whole feature is
//      dormant and the handler just returns (Cloudflare's default when an email() handler takes
//      no action on a message — no reject, no forward).
//   2. A size cap on the raw message (MAX_EMAIL_BYTES) — checked against `rawSize` BEFORE the
//      raw stream is ever read, so an oversized message never gets buffered.
//   3. Cloudflare's own SPF/DKIM verdict (`Authentication-Results`, stamped by Cloudflare's MTA
//      before this Worker ever sees the message) — the raw `From:` header is never trustworthy
//      on its own; anyone can put anything there. Missing or partial (spf OR dkim, not both)
//      fails closed.
//   4. A per-recipient KV sender allowlist (vault@ and files@ can have different allowed
//      senders — e.g. family gets files@ only). No seed data ships with this build; an empty/
//      absent allowlist is correctly "reject everything," same fail-closed posture as the flag.
// Anything that fails a gate is dropped (message.setReject) and logged to the ledger — never
// silently swallowed, never ingested.
//
// vault@ → the plain-text body, provenance (from/date/message-id) folded in, fed through the
// `ingest` fn's toss-path (a provenance-stamped Inbox/ note). files@ → attachments land in R2
// (content-addressed, via putBlob) and a ref-note (never raw bytes) goes into the vault Inbox —
// the message body becomes the note's text content.
//
// No MIME-parsing dependency exists in this repo (checked package.json) — `parseRawEmail` below
// is a pragmatic, scoped parser (header/body split on the first blank line, a boundary-based
// multipart split, base64/quoted-printable decode for leaf parts) rather than a byte-perfect
// implementation. It assumes non-text parts are base64-encoded, which is what every real-world
// mail client does for binary attachments — good enough to satisfy this door's acceptance
// criteria without pulling in a heavy dependency.
import { type RtEnv } from "../registry";
import { ingest } from "./ingest";
import { obsidian } from "./obsidian";
import { vaultInboxDir } from "./_vaultpaths";
import { clampBytes, errMsg, fromB64, putBlob, vaultToday } from "./_util";
import { ledger } from "../ledger";

// Copied exactly from _document_radar.ts's flagOn (per CLAUDE.md's convention for this pattern).
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The whole feature's master switch — unset ⇒ every message is a silent no-op (see module doc). */
export const hasEmailIngest = (env: RtEnv): boolean => flagOn(env.EMAIL_INGEST_ENABLED);

// Generous enough for a real attachment-bearing email, bounded so a hostile/huge message can't
// buffer an unbounded ReadableStream into the isolate. Checked against `rawSize` up front —
// before the stream is ever read — and re-enforced while draining it.
export const MAX_EMAIL_BYTES = 10 * 1024 * 1024;

const normAddr = (s: string): string => s.trim().toLowerCase();

// --- per-recipient sender allowlist (KV) ---

const ALLOWLIST_PREFIX = "sux:email_ingest:allowlist:";

/** The allowed-sender list for one recipient address (vault@.../files@...), or [] when nothing
 *  is configured — which is the correct fail-closed default (see hasEmailIngest above). */
export async function getAllowlist(env: RtEnv, recipient: string): Promise<string[]> {
	const raw = await env.OAUTH_KV?.get(`${ALLOWLIST_PREFIX}${normAddr(recipient)}`);
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr.map((s) => normAddr(String(s))) : [];
	} catch {
		return [];
	}
}

/** Operator/test helper to seed or edit one recipient's allowlist — seeding real data is out of
 *  scope for this build (#1199: operator-configured later), but every consumer (and every test)
 *  needs a way to write an entry without hand-crafting the KV JSON shape. */
export async function setAllowlist(env: RtEnv, recipient: string, senders: string[]): Promise<void> {
	await env.OAUTH_KV?.put(`${ALLOWLIST_PREFIX}${normAddr(recipient)}`, JSON.stringify(senders.map(normAddr)));
}

/** A sender entry matches a full address ("someone@example.com") or a bare/@-prefixed domain
 *  ("example.com" / "@example.com") — the "family gets files@ only" case from the issue's design
 *  needs "any address at this domain," not just individually-enumerated addresses. */
export function senderAllowed(sender: string, allowlist: string[]): boolean {
	const from = normAddr(sender);
	const domain = from.split("@")[1] ?? "";
	return allowlist.some((entry) => entry === from || entry === domain || entry === `@${domain}`);
}

// --- SPF/DKIM auth-results check ---

const SPF_PASS_RE = /\bspf=pass\b/i;
const DKIM_PASS_RE = /\bdkim=pass\b/i;

/** Cloudflare Email Routing stamps `Authentication-Results` on every inbound message with the
 *  SPF/DKIM verdicts it computed itself server-side — the raw `From:` header alone is never
 *  trustworthy (anyone can put anything there). Conservative by construction: a missing header,
 *  or one that doesn't say BOTH spf=pass and dkim=pass, fails closed rather than guess. */
export function authPassed(headers: Headers): boolean {
	const ar = headers.get("authentication-results") ?? "";
	if (!ar) return false;
	return SPF_PASS_RE.test(ar) && DKIM_PASS_RE.test(ar);
}

// --- raw MIME read + a pragmatic, scoped parse ---

// The subset of Cloudflare's real ForwardableEmailMessage this module actually touches — a
// real ForwardableEmailMessage satisfies this structurally (it has all of these plus more), so
// index.ts's email() export can hand one straight through, while a test can build a plain object
// literal without stubbing the reply()/forward() overloads this code never calls.
export type EmailIngestMessage = {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly headers: Headers;
	readonly rawSize: number;
	setReject(reason: string): void;
};

async function readRaw(message: EmailIngestMessage, maxBytes: number): Promise<Uint8Array> {
	const reader = message.raw.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`message too large: exceeds ${maxBytes}-byte cap`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out;
}

function parseHeaderBlock(block: string): Record<string, string> {
	const headers: Record<string, string> = {};
	let key = "";
	for (const line of block.split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && key) {
			headers[key] = `${headers[key]} ${line.trim()}`;
			continue;
		}
		const m = /^([^:]+):\s?(.*)$/.exec(line);
		if (m) {
			key = m[1].trim().toLowerCase();
			headers[key] = m[2];
		}
	}
	return headers;
}

/** Split on the first blank line (RFC 5322 §2.1) — everything before is header lines (folded
 *  continuations rejoined), everything after is the body, still in whatever transfer-encoding
 *  its own part headers declare. */
function splitHeadersBody(raw: string): { headers: Record<string, string>; body: string } {
	const sep = /\r?\n\r?\n/.exec(raw);
	if (!sep) return { headers: parseHeaderBlock(raw), body: "" };
	return { headers: parseHeaderBlock(raw.slice(0, sep.index)), body: raw.slice(sep.index + sep[0].length) };
}

function contentTypeParams(ct: string): { type: string; params: Record<string, string> } {
	const segs = ct.split(";").map((s) => s.trim());
	const type = (segs[0] || "text/plain").toLowerCase();
	const params: Record<string, string> = {};
	for (const seg of segs.slice(1)) {
		const m = /^([\w-]+)=(?:"([^"]*)"|(.*))$/.exec(seg);
		if (m) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
	}
	return { type, params };
}

/** RFC 2045 quoted-printable → raw bytes (soft line breaks joined, =XX hex escapes decoded). */
function decodeQuotedPrintable(s: string): Uint8Array {
	const joined = s.replace(/=\r?\n/g, "");
	const bytes: number[] = [];
	for (let i = 0; i < joined.length; i++) {
		const hex = joined.slice(i + 1, i + 3);
		if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(joined.charCodeAt(i) & 0xff);
		}
	}
	return new Uint8Array(bytes);
}

function decodePartBytes(body: string, encoding: string): Uint8Array {
	const enc = encoding.trim().toLowerCase();
	if (enc === "base64") return fromB64(body.replace(/\s+/g, ""));
	if (enc === "quoted-printable") return decodeQuotedPrintable(body);
	return new TextEncoder().encode(body);
}

type LeafPart = { contentType: string; filename?: string; bytes: Uint8Array };

// Multipart nesting (mixed containing alternative, etc.) is real; depth is bounded so a
// malformed/hostile boundary loop can't recurse unboundedly.
const MAX_MIME_DEPTH = 6;

function extractLeafParts(headers: Record<string, string>, body: string, depth: number, out: LeafPart[]): void {
	const { type, params } = contentTypeParams(headers["content-type"] ?? "text/plain");
	if (type.startsWith("multipart/") && params.boundary && depth < MAX_MIME_DEPTH) {
		const delim = `--${params.boundary}`;
		const segments = body.split(delim);
		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i];
			if (seg.startsWith("--")) break; // the closing "--boundary--" — nothing after matters
			const trimmed = seg.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
			const part = splitHeadersBody(trimmed);
			extractLeafParts(part.headers, part.body, depth + 1, out);
		}
		return;
	}
	const disposition = contentTypeParams(headers["content-disposition"] ?? "");
	const filename = params.name || disposition.params.filename;
	const encoding = headers["content-transfer-encoding"] ?? "7bit";
	out.push({ contentType: type, filename, bytes: decodePartBytes(body, encoding) });
}

export type ParsedEmail = { text: string; attachments: Array<{ filename: string; contentType: string; bytes: Uint8Array }> };

/** The pragmatic, scoped MIME parse (see module doc): first text/plain leaf → `text` (falling
 *  back to a stripped text/html leaf when no plain-text part exists); every other leaf — or any
 *  text/plain leaf that carries a filename — → an attachment. */
export function parseRawEmail(raw: string): ParsedEmail {
	const top = splitHeadersBody(raw);
	const leaves: LeafPart[] = [];
	extractLeafParts(top.headers, top.body, 0, leaves);

	let text = "";
	let fallbackHtml = "";
	const attachments: ParsedEmail["attachments"] = [];
	for (const leaf of leaves) {
		if (leaf.contentType === "text/plain" && !leaf.filename && !text) {
			text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(leaf.bytes);
		} else if (leaf.contentType === "text/html" && !leaf.filename && !fallbackHtml) {
			fallbackHtml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(leaf.bytes);
		} else if (leaf.filename || !leaf.contentType.startsWith("text/")) {
			attachments.push({ filename: leaf.filename || `attachment-${attachments.length + 1}`, contentType: leaf.contentType, bytes: leaf.bytes });
		}
	}
	if (!text && fallbackHtml) text = fallbackHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	return { text, attachments };
}

// --- note rendering + the vault/R2 writes ---

type Provenance = { from: string; date: string; messageId: string; subject: string };

const provenanceLines = (p: Provenance): string => [`**From:** ${p.from}`, `**Date:** ${p.date}`, `**Message-ID:** ${p.messageId || "(none)"}`].join("\n");

function renderVaultBody(text: string, p: Provenance): string {
	return `${provenanceLines(p)}\n\n---\n\n${text || "(no plain-text body found in this message)"}`;
}

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "email";
}

// A tiny synchronous checksum (not crypto — just disambiguation) so two emails landing the same
// day with the same subject slug still get distinct note paths, deterministically from the
// message-id — a genuine redelivery of the identical message maps to the identical path instead
// of piling up duplicates.
function shortHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0").slice(0, 8);
}

function renderFilesNote(text: string, p: Provenance, refs: Array<{ name: string; url: string; size: number; content_type: string }>): string {
	const fm = ["---", "type: email_ingest", "tags: [email, files]", `source: ${JSON.stringify(p.from)}`, `created: ${new Date().toISOString()}`, "---"].join("\n");
	const body = [
		`# ${p.subject || `email from ${p.from}`}`,
		"",
		provenanceLines(p),
		"",
		clampBytes(text || "(no message body)", 10_000),
		"",
		"## Attachments",
		"",
		...refs.map((r) => `- [${r.name}](${r.url}) — ${r.size} bytes, ${r.content_type}`),
	].join("\n");
	return `${fm}\n\n${body}\n`;
}

// --- injectable deps (mirrors _document_radar.ts's DI shape) ---

export type EmailIngestDeps = {
	ingestText: (env: RtEnv, args: { text: string; title?: string; tags?: string[] }) => Promise<{ ok: boolean; note?: string; error?: string }>;
	writeNote: (env: RtEnv, path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
	putBlob: (env: RtEnv, bytes: Uint8Array, contentType: string) => Promise<{ url: string; sha256: string; size: number }>;
};

async function defaultIngestText(env: RtEnv, args: { text: string; title?: string; tags?: string[] }): Promise<{ ok: boolean; note?: string; error?: string }> {
	const r = await ingest.run(env, { text: args.text, title: args.title, tags: args.tags });
	if (r.isError) return { ok: false, error: r.content?.[0]?.text };
	try {
		const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
		return { ok: true, note: typeof parsed?.note === "string" ? parsed.note : undefined };
	} catch {
		return { ok: true };
	}
}

async function defaultWriteNote(env: RtEnv, path: string, content: string): Promise<{ ok: boolean; error?: string }> {
	const r = await obsidian.run(env, { action: "write", path, content, backend: "git" });
	if (r.isError) return { ok: false, error: r.content?.[0]?.text };
	return { ok: true };
}

async function defaultPutBlob(env: RtEnv, bytes: Uint8Array, contentType: string): Promise<{ url: string; sha256: string; size: number }> {
	const ref = await putBlob(env, bytes, contentType);
	return { url: ref.url, sha256: ref.sha256, size: ref.size };
}

export function defaultDeps(): EmailIngestDeps {
	return { ingestText: defaultIngestText, writeNote: defaultWriteNote, putBlob: defaultPutBlob };
}

export type EmailIngestResult =
	| { action: "dormant" }
	| { action: "rejected"; reason: string }
	| { action: "ingested_vault"; note?: string }
	| { action: "ingested_files"; note: string; attachments: number }
	| { action: "error"; error: string };

/** The email() entrypoint's whole gate→route pipeline (see module doc for the gate order). Never
 *  throws — a downstream vault/R2 failure (AFTER a sender already cleared every gate) is logged
 *  and returned as `{action:"error"}`, not bounced via setReject: the sender did nothing wrong,
 *  so it isn't their problem that sux's own write path hiccuped. */
export async function handleEmail(message: EmailIngestMessage, env: RtEnv, deps: EmailIngestDeps = defaultDeps()): Promise<EmailIngestResult> {
	if (!hasEmailIngest(env)) return { action: "dormant" };
	try {
		const sender = normAddr(message.from);
		const recipient = normAddr(message.to);
		const messageId = message.headers.get("message-id") ?? "";
		const rejectId = messageId || `${sender}->${recipient}:${Date.now()}`;

		const reject = async (reason: string): Promise<EmailIngestResult> => {
			await ledger(env, "email_ingest_rejected")
				.mark(rejectId, reason)
				.catch(() => {});
			message.setReject(reason);
			return { action: "rejected", reason };
		};

		if (message.rawSize > MAX_EMAIL_BYTES) return await reject(`message too large: ${message.rawSize} bytes > ${MAX_EMAIL_BYTES}-byte cap`);
		if (!authPassed(message.headers)) return await reject("SPF/DKIM authentication check failed or missing");

		const localPart = recipient.split("@")[0];
		if (localPart !== "vault" && localPart !== "files") return await reject(`unrecognized recipient address: ${recipient}`);

		const allowlist = await getAllowlist(env, recipient);
		if (!senderAllowed(sender, allowlist)) return await reject(`sender not allowlisted for ${recipient}: ${sender}`);

		const raw = await readRaw(message, MAX_EMAIL_BYTES);
		const parsed = parseRawEmail(new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(raw));
		const provenance: Provenance = {
			from: sender,
			date: message.headers.get("date") ?? new Date().toISOString(),
			messageId,
			subject: message.headers.get("subject") ?? "",
		};

		if (localPart === "vault") {
			const r = await deps.ingestText(env, { text: renderVaultBody(parsed.text, provenance), title: provenance.subject || `email from ${provenance.from}`, tags: ["email"] });
			if (!r.ok) return { action: "error", error: r.error ?? "ingest failed" };
			return { action: "ingested_vault", note: r.note };
		}

		if (parsed.attachments.length === 0) return { action: "error", error: "files@ message carried no attachments" };
		const refs: Array<{ name: string; url: string; size: number; content_type: string }> = [];
		for (const att of parsed.attachments) {
			const ref = await deps.putBlob(env, att.bytes, att.contentType || "application/octet-stream");
			refs.push({ name: att.filename, url: ref.url, size: ref.size, content_type: att.contentType || "application/octet-stream" });
		}
		const date = vaultToday(env.VAULT_TZ);
		const path = `${vaultInboxDir(env)}/${date} email-${slugify(provenance.subject || provenance.from)}-${shortHash(messageId || rejectId)}.md`;
		const w = await deps.writeNote(env, path, renderFilesNote(parsed.text, provenance, refs));
		if (!w.ok) return { action: "error", error: w.error ?? "vault write failed" };
		return { action: "ingested_files", note: path, attachments: refs.length };
	} catch (e) {
		console.error(`email-ingest: unhandled failure — ${errMsg(e)}`);
		return { action: "error", error: errMsg(e) };
	}
}
