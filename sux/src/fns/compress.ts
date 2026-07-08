import zlib from "node:zlib";
import { type Fn, fail, ok } from "../registry";
import { fromB64, putBlob, toB64 } from "./_util";

// Lossless compression at MAXIMUM ratio by default (Bosman: "highest compression,
// zstd"). Uses node:zlib (available under nodejs_compat) for real level control —
// gzip/deflate at level 9, brotli at quality 11, zstd at level 19 when the runtime
// supports it (Node ≥22.15 / newer workerd). Bidirectional; base64 for binary.
const Z = zlib as any;
const zstdOk = typeof Z.zstdCompressSync === "function";

type Codec = "brotli" | "zstd" | "gzip" | "deflate" | "deflate-raw";
const CODECS: Codec[] = ["brotli", "zstd", "gzip", "deflate", "deflate-raw"];

// Decompression-bomb guard: a tiny payload can inflate to gigabytes and OOM the
// isolate. Cap the output buffer — node:zlib throws ERR_BUFFER_TOO_LARGE past it.
const MAX_DECOMPRESS_BYTES = 32 * 1024 * 1024;

function compressBytes(codec: Codec, buf: Uint8Array): Uint8Array {
	switch (codec) {
		case "gzip":
			return Z.gzipSync(buf, { level: 9 });
		case "deflate":
			return Z.deflateSync(buf, { level: 9 });
		case "deflate-raw":
			return Z.deflateRawSync(buf, { level: 9 });
		case "brotli":
			return Z.brotliCompressSync(buf, { params: { [Z.constants.BROTLI_PARAM_QUALITY]: 11 } });
		case "zstd":
			return Z.zstdCompressSync(buf, { params: { [Z.constants.ZSTD_c_compressionLevel]: 19 } });
	}
}

function decompressBytes(codec: Codec, buf: Uint8Array): Uint8Array {
	const opts = { maxOutputLength: MAX_DECOMPRESS_BYTES };
	switch (codec) {
		case "gzip":
			return Z.gunzipSync(buf, opts);
		case "deflate":
			return Z.inflateSync(buf, opts);
		case "deflate-raw":
			return Z.inflateRawSync(buf, opts);
		case "brotli":
			return Z.brotliDecompressSync(buf, opts);
		case "zstd":
			return Z.zstdDecompressSync(buf, opts);
	}
}

export const compress: Fn = {
	name: "compress",
	description:
		"Compress or decompress data losslessly at the highest ratio. codec: brotli (default, best for text) | zstd | gzip | deflate | deflate-raw — all at maximum level. direction: compress (default) | decompress. Compress takes text and returns { codec, in_bytes, out_bytes, saved_pct, base64 } (or a /s/<uuid> ref with `as: \"url\"`). Decompress takes base64 and returns the original text by default; for binary payloads set `as: \"base64\"` ({ bytes, base64 }) or `as: \"url\"` (content-addressed ref).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "Text (compress) or base64 (decompress)." },
			codec: { type: "string", enum: CODECS, default: "brotli", description: "brotli (best text ratio) | zstd | gzip | deflate | deflate-raw. All run at max level." },
			direction: { type: "string", enum: ["compress", "decompress"], default: "compress" },
			as: { type: "string", enum: ["text", "base64", "url"], description: "Output delivery. compress: base64 (default) | url (CAS ref). decompress: text (default) | base64 (binary-safe) | url (CAS ref)." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		const codec = String(args?.codec ?? "brotli") as Codec;
		if (!CODECS.includes(codec)) return fail(`Unknown codec '${codec}'. Use: ${CODECS.join(", ")}.`);
		if (codec === "zstd" && !zstdOk) {
			return fail("zstd is not available in this runtime (needs Node ≥22.15 / newer workerd). Use brotli for the best ratio, or gzip.");
		}
		const decompress = args?.direction === "decompress";
		const as = typeof args?.as === "string" ? args.as : undefined;
		try {
			if (decompress) {
				const out = new Uint8Array(decompressBytes(codec, fromB64(String(args?.data ?? ""))));
				// Binary-safe delivery: TextDecoding arbitrary bytes is lossy, so
				// binary payloads should ask for base64 or a CAS url instead.
				if (as === "url") {
					const ref = await putBlob(env, out, "application/octet-stream");
					return ok(JSON.stringify({ bytes: out.length, url: ref.url, sha256: ref.sha256, content_type: ref.content_type }));
				}
				if (as === "base64") return ok(JSON.stringify({ bytes: out.length, base64: toB64(out) }));
				return ok(new TextDecoder().decode(out));
			}
			const input = new TextEncoder().encode(String(args?.data ?? ""));
			const out = new Uint8Array(compressBytes(codec, input));
			const saved = input.length ? Number((((input.length - out.length) / input.length) * 100).toFixed(1)) : 0;
			const stats = { codec, in_bytes: input.length, out_bytes: out.length, saved_pct: saved };
			if (as === "url") {
				const ref = await putBlob(env, out, "application/octet-stream");
				return ok(JSON.stringify({ ...stats, url: ref.url, sha256: ref.sha256 }));
			}
			return ok(JSON.stringify({ ...stats, base64: toB64(out) }));
		} catch (e) {
			if ((e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
				return fail(`decompress failed: output exceeds the ${MAX_DECOMPRESS_BYTES} byte cap (possible decompression bomb).`);
			}
			return fail(`${decompress ? "decompress" : "compress"} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
