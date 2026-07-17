import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptPayload, hasWebPush, listSubscriptions, notify, sendToSubscription, subscribe, unsubscribe } from "./_webpush";

const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async (opts?: { prefix?: string }) => ({
			keys: [...store.keys()].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).map((name) => ({ name })),
			list_complete: true,
		}),
	};
};

function b64urlToBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}
function bytesToB64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
	let off = 0;
	for (const a of arrs) {
		out.set(a, off);
		off += a.length;
	}
	return out;
}
async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array((await crypto.subtle.sign("HMAC", key, data)) as ArrayBuffer);
}
// workerd's generated types are looser than the DOM lib (generateKey/exportKey return
// unions, and ECDH deriveBits' algorithm field is typed "$public" — see _webpush.ts's
// ecdhDeriveBits comment for why the real runtime property is still "public"); these
// wrappers cast back to the real spec shapes so the test bodies read like plain WebCrypto.
async function generateEcKeyPair(name: string, usages: string[]): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey({ name, namedCurve: "P-256" }, true, usages) as Promise<CryptoKeyPair>;
}
async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}
async function ecdhDeriveBits(otherPublicKey: CryptoKey, privateKey: CryptoKey): Promise<Uint8Array> {
	const algo = { name: "ECDH", public: otherPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
	return new Uint8Array((await crypto.subtle.deriveBits(algo, privateKey, 256)) as ArrayBuffer);
}

/** Real VAPID keypair (ECDSA P-256), same shape `subscribe`d env vars would hold. */
async function makeVapidEnv(): Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string }> {
	const kp = await generateEcKeyPair("ECDSA", ["sign", "verify"]);
	const pubRaw = await exportRawKey(kp.publicKey);
	const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
	return { VAPID_PUBLIC_KEY: bytesToB64url(pubRaw), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: "mailto:ops@example.com" };
}

/** Real subscriber keypair + auth secret, same shape a browser's PushSubscription carries. */
async function makeSubscription(endpoint: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
	const kp = await generateEcKeyPair("ECDH", ["deriveBits"]);
	const pubRaw = await exportRawKey(kp.publicKey);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return { endpoint, keys: { p256dh: bytesToB64url(pubRaw), auth: bytesToB64url(auth) } };
}

/** A from-scratch UA-side decrypt (RFC 8291/8188), independent of _webpush.ts's own
 *  encrypt implementation, so a round trip through both exercises the real subscriber-side
 *  math rather than just proving encrypt is self-consistent with itself. */
async function decryptAsSubscriber(body: Uint8Array, uaKeyPair: CryptoKeyPair, uaPublicRaw: Uint8Array, authSecret: Uint8Array): Promise<string> {
	const salt = body.slice(0, 16);
	const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
	expect(rs).toBe(4096);
	const idlen = body[20];
	const asPublicRaw = body.slice(21, 21 + idlen);
	const ciphertext = body.slice(21 + idlen);

	const asPublicKey = await crypto.subtle.importKey("raw", asPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = await ecdhDeriveBits(asPublicKey, uaKeyPair.privateKey);

	const prkKey = await hmacSha256(authSecret, ecdhSecret);
	const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw, new Uint8Array([1]));
	const ikm = await hmacSha256(prkKey, keyInfo);
	const prk = await hmacSha256(salt, ikm);
	const cek = (await hmacSha256(prk, concatBytes(new TextEncoder().encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
	const nonce = (await hmacSha256(prk, concatBytes(new TextEncoder().encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);

	const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
	const paddedPlain = new Uint8Array((await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext)) as ArrayBuffer);
	expect(paddedPlain[paddedPlain.length - 1]).toBe(2); // final-record delimiter
	return new TextDecoder().decode(paddedPlain.slice(0, -1));
}

describe("hasWebPush", () => {
	it("requires all three VAPID fields", () => {
		expect(hasWebPush({} as any)).toBe(false);
		expect(hasWebPush({ VAPID_PUBLIC_KEY: "x" } as any)).toBe(false);
		expect(hasWebPush({ VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y", VAPID_SUBJECT: "mailto:a@b.com" } as any)).toBe(true);
	});
});

describe("subscribe / unsubscribe / listSubscriptions", () => {
	it("round-trips a subscription through KV, keyed by endpoint hash", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		const sub = await makeSubscription("https://push.example.com/abc");
		await subscribe(env, sub);
		expect(await listSubscriptions(env)).toEqual([sub]);
		await unsubscribe(env, sub.endpoint);
		expect(await listSubscriptions(env)).toEqual([]);
	});

	it("rejects a subscription missing endpoint/keys", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		await expect(subscribe(env, { endpoint: "", keys: { p256dh: "", auth: "" } })).rejects.toThrow();
	});

	it("skips a corrupt stored entry instead of throwing", async () => {
		const kv = fakeKV({ "sux:webpush:sub:deadbeef": "not json" });
		expect(await listSubscriptions({ OAUTH_KV: kv } as any)).toEqual([]);
	});
});

describe("encryptPayload round trip (RFC 8291/8188)", () => {
	it("decrypts, via an independently-derived subscriber-side implementation, to the exact plaintext", async () => {
		const uaKeyPair = await generateEcKeyPair("ECDH", ["deriveBits"]);
		const uaPublicRaw = await exportRawKey(uaKeyPair.publicKey);
		const authSecret = crypto.getRandomValues(new Uint8Array(16));

		const plaintext = JSON.stringify({ title: "sux", body: "3 high-priority emails triaged" });
		const body = await encryptPayload(new TextEncoder().encode(plaintext), bytesToB64url(uaPublicRaw), bytesToB64url(authSecret));

		const decoded = await decryptAsSubscriber(body, uaKeyPair, uaPublicRaw, authSecret);
		expect(decoded).toBe(plaintext);
	});

	it("uses a fresh random salt/ephemeral key each call, so ciphertexts for the same plaintext differ", async () => {
		const uaKeyPair = await generateEcKeyPair("ECDH", ["deriveBits"]);
		const uaPublicRaw = await exportRawKey(uaKeyPair.publicKey);
		const authSecret = crypto.getRandomValues(new Uint8Array(16));
		const p = bytesToB64url(uaPublicRaw);
		const a = bytesToB64url(authSecret);

		const b1 = await encryptPayload(new TextEncoder().encode("hi"), p, a);
		const b2 = await encryptPayload(new TextEncoder().encode("hi"), p, a);
		expect(bytesToB64url(b1)).not.toBe(bytesToB64url(b2));
	});
});

describe("sendToSubscription / notify", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("no-ops when VAPID is unconfigured", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const sub = await makeSubscription("https://push.example.com/abc");
		expect(await sendToSubscription(env, sub, { title: "t", body: "b" })).toBe(false);
		expect(await notify(env, { title: "t", body: "b" })).toEqual({ sent: 0, failed: 0 });
	});

	it("prunes the subscription on a 410 Gone response", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv, ...(await makeVapidEnv()) } as any;
		const sub = await makeSubscription("https://push.example.com/abc");
		await subscribe(env, sub);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 410 })),
		);
		const ok = await sendToSubscription(env, sub, { title: "t", body: "b" });
		expect(ok).toBe(false);
		expect(await listSubscriptions(env)).toEqual([]);
	});

	it("notify aggregates sent/failed across subscriptions without throwing on a fetch error", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv, ...(await makeVapidEnv()) } as any;
		await subscribe(env, await makeSubscription("https://push.example.com/abc"));
		await subscribe(env, await makeSubscription("https://push.example.com/def"));
		let n = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				n++;
				if (n === 1) return new Response(null, { status: 201 });
				throw new Error("network down");
			}),
		);
		expect(await notify(env, { title: "t", body: "b" })).toEqual({ sent: 1, failed: 1 });
	});
});
