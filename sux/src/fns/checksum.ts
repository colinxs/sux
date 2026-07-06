import { type Fn, fail, ok } from "../registry";

/** Precomputed CRC-32 lookup table (IEEE 802.3 polynomial, reflected 0xEDB88320). */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
	const MOD = 65521;
	let a = 1;
	let b = 0;
	for (let i = 0; i < bytes.length; i++) {
		a = (a + bytes[i]) % MOD;
		b = (b + a) % MOD;
	}
	return ((b << 16) | a) >>> 0;
}

const ALGOS: Record<string, (bytes: Uint8Array) => number> = { crc32, adler32 };

export const checksum: Fn = {
	name: "checksum",
	description:
		"Compute a non-cryptographic checksum of UTF-8 text. algo: crc32 (default, IEEE 802.3) | adler32. Returns the 8-hex-digit checksum. For SHA/MD-family cryptographic hashes, use the `hash` tool.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Text to checksum (encoded as UTF-8)." },
			algo: { type: "string", enum: Object.keys(ALGOS), default: "crc32", description: "Checksum algorithm." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		const algo = String(args?.algo ?? "crc32");
		const fn = ALGOS[algo];
		if (!fn) return fail(`Unknown algo. Use: ${Object.keys(ALGOS).join(", ")}`);
		const bytes = new TextEncoder().encode(String(args?.text ?? ""));
		const hex = fn(bytes).toString(16).padStart(8, "0");
		return ok(hex);
	},
};
