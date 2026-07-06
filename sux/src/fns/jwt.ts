import { type Fn, fail, ok } from "../registry";

function b64urlToStr(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
	return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
function b64urlEncode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const jwt: Fn = {
	name: "jwt",
	description:
		"Decode a JWT (and optionally verify it). Base64url-decodes the header and payload and pretty-prints the claims, with human-readable status for exp/nbf/iat. If `secret` is given and alg is HS256, verifies the HMAC signature via Web Crypto. NEVER trust an unverified token — without `secret` the payload is attacker-controlled and `signature_valid` is absent. Returns { header, payload, signature_valid?, expired }. Does not issue tokens.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["token"],
		properties: {
			token: { type: "string", description: "The compact JWT (header.payload.signature)." },
			secret: { type: "string", description: "HS256 HMAC secret — if given, the signature is verified." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (_env, args) => {
		const token = String(args?.token ?? "").trim();
		const parts = token.split(".");
		if (parts.length !== 3) return fail("Not a compact JWT (need header.payload.signature).");
		let header: any;
		let payload: any;
		try {
			header = JSON.parse(b64urlToStr(parts[0]));
			payload = JSON.parse(b64urlToStr(parts[1]));
		} catch {
			return fail("Could not base64url-decode the JWT header/payload.");
		}

		const nowSec = Math.floor(Date.now() / 1000);
		const out: {
			header: any;
			payload: any;
			claim_status: Record<string, string>;
			signature_valid?: boolean;
			expired: boolean;
		} = { header, payload, claim_status: {}, expired: false };

		if (typeof payload?.iat === "number") out.claim_status.iat = `issued ${new Date(payload.iat * 1000).toISOString()}`;
		if (typeof payload?.nbf === "number") {
			const active = nowSec >= payload.nbf;
			out.claim_status.nbf = `not-before ${new Date(payload.nbf * 1000).toISOString()} — ${active ? "active" : "NOT YET ACTIVE"}`;
		}
		if (typeof payload?.exp === "number") {
			out.expired = nowSec >= payload.exp;
			out.claim_status.exp = `expires ${new Date(payload.exp * 1000).toISOString()} — ${out.expired ? "EXPIRED" : "valid"}`;
		}

		const secret = args?.secret != null ? String(args.secret) : "";
		if (secret) {
			if (String(header?.alg) !== "HS256") {
				return fail(`verification supports HS256 only — token alg is '${header?.alg}'. Decoded without verifying.`);
			}
			try {
				const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
				const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)));
				out.signature_valid = b64urlEncode(sig) === parts[2];
			} catch (e) {
				return fail(`signature verification failed: ${String((e as Error).message ?? e)}`);
			}
		}
		return ok(JSON.stringify(out, null, 2));
	},
};
