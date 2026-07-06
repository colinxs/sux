import { type Fn, fail, ok } from "../registry";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function tarPack(files: Array<{ name: string; content: Uint8Array }>): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const f of files) {
		const header = new Uint8Array(512);
		const nameBytes = enc.encode(f.name).subarray(0, 100);
		header.set(nameBytes, 0);
		const put = (str: string, off: number, len: number) => header.set(enc.encode(str.padEnd(len, "\0").slice(0, len)), off);
		put("0000644", 100, 8);
		put("0000000", 108, 8);
		put("0000000", 116, 8);
		put(f.content.length.toString(8).padStart(11, "0") + "\0", 124, 12);
		put("00000000000\0", 136, 12);
		header[156] = 0x30;
		put("ustar\0", 257, 6);
		put("00", 263, 2);

		for (let i = 148; i < 156; i++) header[i] = 0x20;
		let sum = 0;
		for (const byte of header) sum += byte;
		put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
		blocks.push(header, f.content, new Uint8Array((512 - (f.content.length % 512)) % 512));
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const b of blocks) { out.set(b, off); off += b.length; }
	return out;
}

function tarUnpack(data: Uint8Array): Array<{ name: string; size: number; content: string }> {
	const files: Array<{ name: string; size: number; content: string }> = [];
	let off = 0;
	while (off + 512 <= data.length) {
		const header = data.subarray(off, off + 512);
		if (header.every((b) => b === 0)) break;
		const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
		const size = parseInt(dec.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
		off += 512;
		if (name) files.push({ name, size, content: b64(data.subarray(off, off + size)) });
		off += Math.ceil(size / 512) * 512;
	}
	return files;
}

export const archive: Fn = {
	name: "archive",
	description: "Bundle files into a TAR or list a TAR's contents. op: pack (give `files`: [{name, content_base64}] → base64 tar) | unpack (give `data`: base64 tar → [{name, size, content_base64}]). For .tar.gz, chain with `compress`. ZIP is coming (needs WASM).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["pack", "unpack"] },
			format: { type: "string", enum: ["tar", "zip"], default: "tar" },
			files: {
				type: "array",
				items: { type: "object", required: ["name", "content_base64"], properties: { name: { type: "string" }, content_base64: { type: "string" } } },
			},
			data: { type: "string", description: "base64 archive (unpack)." },
		},
	},
	cacheable: false,
	run: async (_env, args) => {
		if (String(args?.format ?? "tar") === "zip") return fail("ZIP not wired yet (needs WASM deflate + central directory). Use format='tar' (+ compress for gzip).");
		try {
			if (args?.op === "pack") {
				const files = Array.isArray(args?.files) ? args.files : [];
				if (!files.length) return fail("pack needs `files`: [{name, content_base64}].");
				const tar = tarPack(files.map((f: any) => ({ name: String(f.name), content: unb64(String(f.content_base64)) })));
				return ok(JSON.stringify({ format: "tar", bytes: tar.length, base64: b64(tar) }));
			}
			if (args?.op === "unpack") {
				if (!args?.data) return fail("unpack needs `data` (base64 tar).");
				const entries = tarUnpack(unb64(String(args.data)));
				return ok(JSON.stringify({ format: "tar", count: entries.length, files: entries.map((e) => ({ name: e.name, size: e.size, content_base64: e.content })) }, null, 2));
			}
			return fail("op must be pack | unpack.");
		} catch (e) {
			return fail(`archive failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
