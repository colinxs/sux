import { type Fn, fail, ok } from "../registry";

function b64urlToStr(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
	return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
const HS: Record<string, string> = { HS256: "SHA-256", HS384: "SHA-384", HS512: "SHA-512" };

export const jwt: Fn = {
	name: "jwt",
	description: "Decode a JWT into its header and payload (claims). If `secret` is given and alg is HS256/384/512, also verify the signature. Reports exp/iat/nbf as human dates. Does not issue tokens.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["token"],
		properties: {
			token: { type: "string", description: "The compact JWT (three dot-separated parts)." },
			secret: { type: "string", description: "HMAC secret to verify the signature (optional)." },
		},
	},
	cacheable: false,
	run: async (_env, args) => {
		const token = String(args?.token ?? "").trim();
		const parts = token.split(".");
		if (parts.length !== 3) return fail("Not a compact JWT (need header.payload.signature).");
		let header: any, payload: any;
		try {
			header = JSON.parse(b64urlToStr(parts[0]));
			payload = JSON.parse(b64urlToStr(parts[1]));
		} catch {
			return fail("Could not decode JWT header/payload.");
		}
		const out: any = { header, payload };
		for (const c of ["exp", "iat", "nbf"]) if (typeof payload[c] === "number") out[`${c}_date`] = new Date(payload[c] * 1000).toISOString();
		if (typeof payload.exp === "number") out.expired = payload.exp * 1000 < Date.now();

		const secret = args?.secret ? String(args.secret) : "";
		if (secret) {
			const hash = HS[String(header.alg)];
			if (!hash) out.verified = `cannot verify alg '${header.alg}' (only HS256/384/512 supported)`;
			else {
				const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"]);
				const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)));
				const expected = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
				out.verified = expected === parts[2];
			}
		}
		return ok(JSON.stringify(out, null, 2));
	},
};
