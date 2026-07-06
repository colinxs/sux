import { type Fn, fail, ok } from "../registry";
import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const b64 = (b: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

const MAX_TEXT = 100_000; // don't inline megabytes of decoded text per entry

/** Heuristic: does this byte run decode cleanly as UTF-8 without binary control noise? */
function looksUtf8(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return true;
	// A non-fatal decode maps invalid UTF-8 sequences to U+FFFD; treat any such
	// replacement char, NUL, or other C0 control byte (tab/newline/CR excepted)
	// as a sign the payload is binary and should not be inlined as text.
	const text = new TextDecoder().decode(bytes);
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 0xfffd) return false;
		if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
	}
	return true;
}

function toBytes(f: { name?: unknown; content?: unknown; base64?: unknown }): Uint8Array {
	if (typeof f?.base64 === "string" && f.base64) return unb64(f.base64);
	if (typeof f?.content === "string") return strToU8(f.content);
	return new Uint8Array(0);
}

function decodeEntry(name: string, data: Uint8Array): { name: string; bytes: number; text?: string; truncated?: boolean } {
	const e: { name: string; bytes: number; text?: string; truncated?: boolean } = { name, bytes: data.length };
	if (looksUtf8(data)) {
		const text = strFromU8(data);
		if (text.length > MAX_TEXT) {
			e.text = text.slice(0, MAX_TEXT);
			e.truncated = true;
		} else {
			e.text = text;
		}
	}
	return e;
}

export const archive: Fn = {
	name: "archive",
	description:
		"Pack files into an archive or unpack one, using fflate (pure JS). op: pack | unpack (required). format: zip (default) | gzip. pack: give `files` as [{ name, content (text) | base64 }] — zip bundles them all, gzip compresses one file's bytes; returns { format, bytes, base64 }. unpack: give `base64` (+ format) — zip lists every entry, gzip yields one; returns { entries: [{ name, bytes, text? }] } with text decoded when it looks like UTF-8. Chain with `compress` for other codecs.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["pack", "unpack"], description: "pack builds an archive; unpack reads one." },
			format: { type: "string", enum: ["zip", "gzip"], default: "zip", description: "Archive format. zip = multi-file container, gzip = single stream." },
			files: {
				type: "array",
				description: "For pack. Each item: { name, and one of content (UTF-8 text) or base64 (raw bytes) }.",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["name"],
					properties: {
						name: { type: "string", description: "Entry name / path inside the archive." },
						content: { type: "string", description: "UTF-8 text payload." },
						base64: { type: "string", description: "Raw bytes as base64 (takes precedence over content)." },
					},
				},
			},
			base64: { type: "string", description: "For unpack. The archive bytes as base64." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		const op = String(args?.op ?? "");
		const format = String(args?.format ?? "zip");
		if (format !== "zip" && format !== "gzip") return fail("format must be 'zip' or 'gzip'.");
		try {
			if (op === "pack") {
				const files = Array.isArray(args?.files) ? (args.files as any[]) : [];
				if (!files.length) return fail("pack needs `files`: [{ name, content | base64 }].");
				for (const f of files) if (!f?.name || typeof f.name !== "string") return fail("every file needs a string `name`.");
				let out: Uint8Array;
				if (format === "zip") {
					const record: Record<string, Uint8Array> = {};
					for (const f of files) record[String(f.name)] = toBytes(f);
					out = zipSync(record, { level: 6 });
				} else {
					if (files.length !== 1) return fail(`gzip packs exactly one file — got ${files.length}. Use format='zip' for multiple.`);
					out = gzipSync(toBytes(files[0]), { level: 6 });
				}
				return ok(JSON.stringify({ format, bytes: out.length, base64: b64(out) }, null, 2));
			}
			if (op === "unpack") {
				if (typeof args?.base64 !== "string" || !args.base64) return fail("unpack needs `base64` (the archive bytes).");
				const bytes = unb64(String(args.base64));
				const entries: Array<{ name: string; bytes: number; text?: string; truncated?: boolean }> = [];
				if (format === "zip") {
					const files = unzipSync(bytes);
					for (const [name, data] of Object.entries(files)) entries.push(decodeEntry(name, data));
				} else {
					entries.push(decodeEntry("data", gunzipSync(bytes)));
				}
				return ok(JSON.stringify({ format, entries }, null, 2));
			}
			return fail("op must be 'pack' or 'unpack'.");
		} catch (e) {
			return fail(`archive ${op} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
