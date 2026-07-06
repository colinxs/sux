import { type Fn, fail, ok } from "../registry";

const NATIVE = new Set(["gzip", "deflate", "deflate-raw"]);

function toBase64(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
async function pipe(input: Uint8Array, ts: TransformStream): Promise<Uint8Array> {
	const stream = new Blob([input]).stream().pipeThrough(ts);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const compress: Fn = {
	name: "compress",
	description:
		"Compress or decompress data losslessly. codec: gzip | deflate | deflate-raw (native; zstd/brotli/7z coming via WASM). direction: compress (default) | decompress. Compress takes text and returns { in_bytes, out_bytes, saved_pct, base64 }; decompress takes base64 and returns the original text.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data", "codec"],
		properties: {
			data: { type: "string", description: "Text (compress) or base64 (decompress)." },
			codec: { type: "string", enum: ["gzip", "deflate", "deflate-raw", "zstd", "brotli", "7z"] },
			direction: { type: "string", enum: ["compress", "decompress"], default: "compress" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const codec = String(args?.codec ?? "");
		const decompress = args?.direction === "decompress";
		if (!NATIVE.has(codec)) {
			return fail(`codec '${codec}' not yet supported — native: gzip, deflate, deflate-raw. (zstd/brotli/7z via WASM soon.)`);
		}
		try {
			if (decompress) {
				const out = await pipe(fromBase64(String(args?.data ?? "")), new DecompressionStream(codec as any));
				return ok(new TextDecoder().decode(out));
			}
			const input = new TextEncoder().encode(String(args?.data ?? ""));
			const out = await pipe(input, new CompressionStream(codec as any));
			const saved = input.length ? Number((((input.length - out.length) / input.length) * 100).toFixed(1)) : 0;
			return ok(JSON.stringify({ codec, in_bytes: input.length, out_bytes: out.length, saved_pct: saved, base64: toBase64(out) }));
		} catch (e) {
			return fail(`${decompress ? "decompress" : "compress"} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
