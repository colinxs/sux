import { type Fn, fail, ok } from "../registry";
import { fetchText, fromB64, isHttpUrl, toB64 } from "./_util";

// Remove privacy-sensitive metadata from an image by walking its container
// format and dropping the chunks/segments that carry Exif, GPS, comments, and
// timestamps — without touching the actual pixel data.
//
//   JPEG: drop APP1 (Exif/XMP), other APPn (APP0..APPF), and COM segments.
//         Keep SOI, quantization/Huffman tables, SOF, SOS + entropy-coded scan.
//   PNG:  drop tEXt/iTXt/zTXt (text), eXIf (Exif), tIME (timestamp) chunks.
//         Keep IHDR, PLTE, IDAT, IEND and everything else.

const JPEG_SIG = [0xff, 0xd8];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
	if (bytes.length < sig.length) return false;
	for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
	return true;
}

/** JPEG marker name for the APPn/COM segments we care to report. */
function jpegMarkerName(marker: number): string {
	if (marker === 0xe1) return "APP1(Exif/XMP)";
	if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
	if (marker === 0xfe) return "COM";
	return `0x${marker.toString(16).toUpperCase()}`;
}

/** Strip Exif/APPn/COM from a JPEG. Returns the cleaned bytes + removed labels. */
function stripJpeg(bytes: Uint8Array): { out: Uint8Array; removed: string[] } {
	const removed: string[] = [];
	const keep: number[][] = [];
	// SOI.
	keep.push([bytes[0], bytes[1]]);
	let i = 2;
	while (i + 1 < bytes.length) {
		if (bytes[i] !== 0xff) {
			// Not a marker boundary — bail out and keep the remainder verbatim.
			keep.push(Array.from(bytes.subarray(i)));
			i = bytes.length;
			break;
		}
		const marker = bytes[i + 1];
		// Standalone markers (no length): RSTn (D0..D7), TEM (01), and repeated fill FFs.
		if (marker === 0xff) {
			i += 1;
			continue;
		}
		if (marker === 0xd9) {
			// EOI.
			keep.push([0xff, 0xd9]);
			i += 2;
			break;
		}
		if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			keep.push([0xff, marker]);
			i += 2;
			continue;
		}
		// Length-bearing segment: 2 bytes marker + 2 bytes big-endian length (incl. those 2).
		const len = (bytes[i + 2] << 8) | bytes[i + 3];
		const segEnd = i + 2 + len;
		if (len < 2 || segEnd > bytes.length) {
			// Malformed — keep the rest as-is rather than corrupting the file.
			keep.push(Array.from(bytes.subarray(i)));
			i = bytes.length;
			break;
		}
		const drop = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
		if (drop) {
			removed.push(jpegMarkerName(marker));
		} else {
			keep.push(Array.from(bytes.subarray(i, segEnd)));
		}
		i = segEnd;
		// SOS: entropy-coded scan data follows with no length — copy to EOI/end.
		if (marker === 0xda) {
			keep.push(Array.from(bytes.subarray(segEnd)));
			i = bytes.length;
			break;
		}
	}
	const total = keep.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const a of keep) {
		out.set(a, o);
		o += a.length;
	}
	return { out, removed };
}

const PNG_DROP = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/** Strip text/Exif/timestamp chunks from a PNG. Returns cleaned bytes + removed labels. */
function stripPng(bytes: Uint8Array): { out: Uint8Array; removed: string[] } {
	const removed: string[] = [];
	const keep: Uint8Array[] = [bytes.subarray(0, 8)]; // 8-byte signature.
	let i = 8;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	while (i + 8 <= bytes.length) {
		const len = dv.getUint32(i); // chunk data length (big-endian).
		const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
		const chunkEnd = i + 12 + len; // 4 len + 4 type + len data + 4 CRC.
		if (chunkEnd > bytes.length) {
			keep.push(bytes.subarray(i)); // malformed tail — keep verbatim.
			i = bytes.length;
			break;
		}
		if (PNG_DROP.has(type)) removed.push(type);
		else keep.push(bytes.subarray(i, chunkEnd));
		i = chunkEnd;
		if (type === "IEND") break;
	}
	const total = keep.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const a of keep) {
		out.set(a, o);
		o += a.length;
	}
	return { out, removed };
}

export const strip_metadata: Fn = {
	name: "strip_metadata",
	description:
		"Remove privacy-sensitive metadata (Exif/GPS, XMP, comments, timestamps) from an image without touching pixels. image: base64 bytes or an http(s) URL. JPEG drops APP1/APPn/COM segments; PNG drops tEXt/iTXt/zTXt/eXIf/tIME chunks. Returns JSON { format, removed, bytes, base64 }. PDF and other formats are not yet supported.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["image"],
		properties: {
			image: { type: "string", description: "Image as base64 bytes, or an absolute http(s) URL to fetch (via proxy)." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		const image = typeof args?.image === "string" ? args.image.trim() : "";
		if (!image) return fail("Provide an `image` (base64 bytes or an http(s) URL).");

		let bytes: Uint8Array;
		if (isHttpUrl(image)) {
			const r = await fetchText(env, image);
			if (r.status >= 400) return fail(`Failed to fetch image: HTTP ${r.status}`);
			// fetchText decodes as text; re-encode the raw bytes latin1-style.
			const out = new Uint8Array(r.text.length);
			for (let i = 0; i < r.text.length; i++) out[i] = r.text.charCodeAt(i) & 0xff;
			bytes = out;
		} else {
			try {
				bytes = fromB64(image);
			} catch {
				return fail("`image` is neither a valid base64 string nor an http(s) URL.");
			}
		}
		if (!bytes.length) return fail("Image is empty.");

		let format: string;
		let result: { out: Uint8Array; removed: string[] };
		if (startsWith(bytes, JPEG_SIG)) {
			format = "jpeg";
			result = stripJpeg(bytes);
		} else if (startsWith(bytes, PNG_SIG)) {
			format = "png";
			result = stripPng(bytes);
		} else if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
			return fail("PDF metadata stripping is planned but not yet supported — only JPEG and PNG are handled today.");
		} else {
			return fail("Unrecognized image format — only JPEG and PNG are supported (GIF/WebP/TIFF/PDF planned).");
		}

		return ok(
			JSON.stringify(
				{ format, removed: result.removed, bytes: result.out.length, base64: toB64(result.out) },
				null,
				2,
			),
		);
	},
};
