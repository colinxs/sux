import { type Fn, fail, ok } from "../registry";
import { strToU8 } from "fflate";
import { zipCreate, zipExtract, gzipCreate, gzipExtract, type UnpackedEntry } from "@suxos/lib";
import { deliverBytes, fromB64, putBlob, toB64, oj } from "./_util";

// Pack/unpack logic (bomb guards, UTF-8-vs-binary decode heuristic, fflate
// zip/gzip calls) now lives in @suxos/lib's domain/archive.ts (absorbed there
// from sux-fileops, itself adapted from this file) — this file keeps only the
// Fn wrapper (schema, env/args handling) and the CAS ("as: url") delivery this
// fn's callers depend on, both of which are sux-specific, not fileops-shared.

function toBytes(f: { name?: unknown; content?: unknown; base64?: unknown }): Uint8Array {
	if (typeof f?.base64 === "string" && f.base64) return fromB64(f.base64);
	if (typeof f?.content === "string") return strToU8(f.content);
	return new Uint8Array(0);
}

type Entry = { name: string; bytes: number; text?: string; truncated?: boolean; url?: string; sha256?: string };

function toEntry(e: UnpackedEntry): Entry {
	return { name: e.name, bytes: e.bytes, text: e.text, truncated: e.truncated };
}

export const archive: Fn = {
	name: "archive",
	description:
		"Pack files into an archive or unpack one, using fflate (pure JS). op: pack | unpack (required). format: zip (default) | gzip. pack: give `files` as [{ name, content (text) | base64 }] — zip bundles them all, gzip compresses one file's bytes; returns { format, bytes, base64 }, or a compact /s/<uuid> ref with `as: \"url\"`. unpack: give `base64` (+ format) — zip lists every entry, gzip yields one; returns { entries: [{ name, bytes, text? }] } with text decoded when it looks like UTF-8; with `as: \"url\"` every entry (including binary ones) also carries a consumable { url, sha256 } CAS ref. Chain with `compress` for other codecs.",
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
			as: { type: "string", enum: ["base64", "url"], default: "base64", description: "Delivery: inline base64 (default) or content-addressed /s/<uuid> URLs (pack: the archive; unpack: each entry)." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		const op = String(args?.op ?? "");
		const format = String(args?.format ?? "zip");
		if (format !== "zip" && format !== "gzip") return fail("format must be 'zip' or 'gzip'.");
		const mime = format === "zip" ? "application/zip" : "application/gzip";
		try {
			if (op === "pack") {
				const files = Array.isArray(args?.files) ? (args.files as any[]) : [];
				if (!files.length) return fail("pack needs `files`: [{ name, content | base64 }].");
				for (const f of files) if (!f?.name || typeof f.name !== "string") return fail("every file needs a string `name`.");
				let out: Uint8Array;
				if (format === "zip") {
					out = zipCreate(files.map((f) => ({ name: String(f.name), data: toBytes(f) })));
				} else {
					if (files.length !== 1) return fail(`gzip packs exactly one file — got ${files.length}. Use format='zip' for multiple.`);
					out = gzipCreate(toBytes(files[0]));
				}
				return deliverBytes(env, out, mime, args?.as, () => ok(oj({ format, bytes: out.length, base64: toB64(out) })));
			}
			if (op === "unpack") {
				if (typeof args?.base64 !== "string" || !args.base64) return fail("unpack needs `base64` (the archive bytes).");
				const bytes = fromB64(String(args.base64));
				const unpacked: UnpackedEntry[] = format === "zip" ? zipExtract(bytes) : [gzipExtract(bytes)];
				const entries: Entry[] = [];
				for (const u of unpacked) {
					const e = toEntry(u);
					// as:"url" → each entry (crucially, binary ones that get no inline
					// text) becomes a consumable /s/<uuid> CAS ref.
					if (args?.as === "url") {
						const ref = await putBlob(env, u.data, "application/octet-stream");
						e.url = ref.url;
						e.sha256 = ref.sha256;
					}
					entries.push(e);
				}
				return ok(oj({ format, entries }));
			}
			return fail("op must be 'pack' or 'unpack'.");
		} catch (e) {
			return fail(`archive ${op} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
