// Outbound Web Push (VAPID, #219) — sux pushing OUT to Colin's phone/desktop instead of
// purely append-and-wait (mail_triage/briefing/weekly_recall write to the vault/Drafts and
// he has to go check). Distinct from #213's inbound JMAP PushSubscription (Fastmail
// pushing INTO sux for faster triage reaction) — see registry.ts's VAPID_* comment.
//
// This lands ONLY the Web Push half of #219 (the repo owner's own reconciliation note:
// "a builder should split them or land Web Push first") — Cloudflare Notifications
// (account-level Worker-error/usage alerting, a separate CF product configured mostly
// outside application code) is explicitly out of scope here.
//
// Sends carry a real encrypted payload per RFC 8291 (aes128gcm) + RFC 8188 (the generic
// content-encoding it profiles), NOT an empty ping — a Web Push a subscriber can't read
// the text of doesn't close the loop this issue asks for ("mail_triage push '3
// high-priority emails triaged'"). All Web Crypto (ECDH/HMAC/AES-GCM), no dependency —
// see this file's `.test.ts` for a full encrypt→decrypt round trip against the same
// derivation a real browser push service performs.
import type { RtEnv } from "../registry";
import { isBlockedTarget } from "../proxy";

export type PushSubscriptionInfo = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushMessage = { title: string; body: string; url?: string };

const SUB_PREFIX = "sux:webpush:sub:";

/** All three VAPID fields configured ⇒ armed; any absent ⇒ every export below no-ops
 *  (not_configured), like monarch/dropbox/mychart. */
export function hasWebPush(env: RtEnv): boolean {
	return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

// ── base64url <-> bytes ─────────────────────────────────────────────────────────
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

async function subKey(endpoint: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
	const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return SUB_PREFIX + hex;
}

export function validSubscription(sub: unknown): sub is PushSubscriptionInfo {
	const s = sub as PushSubscriptionInfo | undefined;
	if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) return false;
	try {
		new URL(s.endpoint);
		return true;
	} catch {
		return false;
	}
}

export async function subscribe(env: RtEnv, sub: PushSubscriptionInfo): Promise<void> {
	if (!validSubscription(sub)) throw new Error("invalid subscription: endpoint + keys.p256dh + keys.auth are required.");
	// Same SSRF guard every other outbound-fetch path in this repo applies (proxy.ts's
	// isBlockedTarget) — reject a private/loopback/link-local/metadata endpoint up front
	// so a bad subscription can't even be stored, not just refused at send time below.
	if (isBlockedTarget(sub.endpoint)) throw new Error("invalid subscription: endpoint must be a public http(s) host.");
	await env.OAUTH_KV.put(await subKey(sub.endpoint), JSON.stringify(sub));
}

export async function unsubscribe(env: RtEnv, endpoint: string): Promise<void> {
	await env.OAUTH_KV.delete(await subKey(endpoint));
}

export async function listSubscriptions(env: RtEnv): Promise<PushSubscriptionInfo[]> {
	const out: PushSubscriptionInfo[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.OAUTH_KV.list({ prefix: SUB_PREFIX, cursor });
		for (const k of page.keys) {
			const raw = await env.OAUTH_KV.get(k.name);
			if (!raw) continue;
			try {
				const parsed = JSON.parse(raw);
				if (validSubscription(parsed)) out.push(parsed);
			} catch {
				/* skip a corrupt entry rather than fail the whole list */
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return out;
}

// ── VAPID (RFC 8292): ES256-signed JWT identifying sux to the push service ─────────
async function importVapidPrivateKey(env: RtEnv): Promise<CryptoKey> {
	const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY!); // 65-byte uncompressed P-256 point
	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		d: bytesToB64url(b64urlToBytes(env.VAPID_PRIVATE_KEY!)),
		x: bytesToB64url(pub.slice(1, 33)),
		y: bytesToB64url(pub.slice(33, 65)),
		ext: true,
	};
	return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidAuthHeader(env: RtEnv, endpoint: string): Promise<string> {
	const { origin } = new URL(endpoint);
	const enc = (o: unknown) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
	const signingInput = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })}`;
	const key = await importVapidPrivateKey(env);
	// WebCrypto's ECDSA signature is raw r||s (JOSE's format), never DER — no re-encoding needed.
	const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
	return `vapid t=${signingInput}.${bytesToB64url(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ── RFC 8291 message encryption (aes128gcm, profiling RFC 8188) ────────────────────
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

async function generateEcKeyPair(namedCurve: string, usages: string[]): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey({ name: "ECDH", namedCurve }, true, usages) as Promise<CryptoKeyPair>;
}

async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

// workerd's generated worker-configuration.d.ts types ECDH deriveBits' algorithm
// field as "$public" (a C++ `public`-keyword-collision artifact of its type
// generator) but the JS-visible property — per the WebCrypto spec, and every
// browser/Node implementation — is "public". Cast past the generated type rather
// than emit the (wrong, spec-nonconformant) "$public" shape at runtime.
async function ecdhDeriveBits(otherPublicKey: CryptoKey, privateKey: CryptoKey): Promise<Uint8Array> {
	const algo = { name: "ECDH", public: otherPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
	return new Uint8Array((await crypto.subtle.deriveBits(algo, privateKey, 256)) as ArrayBuffer);
}

const textEncoder = new TextEncoder();

// RFC 8188 §2: a record's encrypted length (plaintext + 1-byte pad delimiter + 16-byte
// AEAD tag) must not exceed the declared `rs`. This file always sends a single record
// (no multi-record splitting), so the plaintext itself must fit within rs - 17.
export const WEBPUSH_RECORD_SIZE = 4096;
export const WEBPUSH_MAX_PLAINTEXT_BYTES = WEBPUSH_RECORD_SIZE - 17;

/** Shrink `message.body` (if needed) so `JSON.stringify(message)` fits within a single
 *  RFC 8188 record — a push service typically 4xx's an oversized aes128gcm body, which
 *  sendToSubscription's catch-all would otherwise swallow into an undiagnosable `false`. */
export function truncateMessageToFit(message: PushMessage): PushMessage {
	if (textEncoder.encode(JSON.stringify(message)).length <= WEBPUSH_MAX_PLAINTEXT_BYTES) return message;
	let body = message.body;
	while (body.length > 0) {
		const candidate: PushMessage = { ...message, body: body.length < message.body.length ? `${body}…` : body };
		if (textEncoder.encode(JSON.stringify(candidate)).length <= WEBPUSH_MAX_PLAINTEXT_BYTES) return candidate;
		body = body.slice(0, -1);
	}
	return { ...message, body: "" };
}

/** Encrypt `plaintext` to a subscriber per RFC 8291 §3.3–3.4 / RFC 8188 §2. Exported
 *  for the round-trip test — sux is always the sender (UA-side decrypt is spec'd, never
 *  implemented here). */
export async function encryptPayload(plaintext: Uint8Array, p256dhB64: string, authB64: string): Promise<Uint8Array> {
	const uaPublicRaw = b64urlToBytes(p256dhB64); // subscriber's 65-byte uncompressed P-256 point
	const authSecret = b64urlToBytes(authB64); // subscriber's 16-byte auth secret

	const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const asKeyPair = await generateEcKeyPair("P-256", ["deriveBits"]);
	const asPublicRaw = await exportRawKey(asKeyPair.publicKey);
	const ecdhSecret = await ecdhDeriveBits(uaPublicKey, asKeyPair.privateKey);

	// §3.3: combine the ECDH secret with the subscriber's auth secret.
	const prkKey = await hmacSha256(authSecret, ecdhSecret);
	const keyInfo = concatBytes(textEncoder.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw, new Uint8Array([1]));
	const ikm = await hmacSha256(prkKey, keyInfo);

	// RFC 8188 §2: derive this record's CEK + nonce from a fresh random salt.
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const prk = await hmacSha256(salt, ikm);
	const cek = (await hmacSha256(prk, concatBytes(textEncoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
	const nonce = (await hmacSha256(prk, concatBytes(textEncoder.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);

	const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
	// 0x02 = final (only) record's padding delimiter (RFC 8188 §2); no extra padding.
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, concatBytes(plaintext, new Uint8Array([2]))));

	const recordSize = new Uint8Array(4);
	new DataView(recordSize.buffer).setUint32(0, WEBPUSH_RECORD_SIZE, false);
	// aes128gcm body header (RFC 8188 §2.1): salt(16) || rs(4, BE) || idlen(1) || keyid.
	// keyid IS the sender's raw public key — aes128gcm embeds it here instead of a
	// separate Crypto-Key header (the older, now-unsupported aesgcm content-coding).
	return concatBytes(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/** POST one push to one subscription. Returns false (and prunes the subscription on a
 *  404/410 "gone") rather than throwing, so a dead endpoint can't sink a fan-out send. */
export async function sendToSubscription(env: RtEnv, sub: PushSubscriptionInfo, message: PushMessage, ttlSeconds = 60): Promise<boolean> {
	if (!hasWebPush(env)) return false;
	// Re-check at send time too (not just subscribe()) so a subscription stored before
	// this guard existed, or one that reached KV some other way, still can't drive an
	// authenticated VAPID-signed POST to a private/loopback/metadata target (#801).
	if (isBlockedTarget(sub.endpoint)) return false;
	try {
		const body = await encryptPayload(textEncoder.encode(JSON.stringify(truncateMessageToFit(message))), sub.keys.p256dh, sub.keys.auth);
		const res = await fetch(sub.endpoint, {
			method: "POST",
			headers: {
				Authorization: await vapidAuthHeader(env, sub.endpoint),
				TTL: String(ttlSeconds),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
			},
			body,
		});
		if (res.status === 404 || res.status === 410) await unsubscribe(env, sub.endpoint);
		return res.ok;
	} catch {
		return false;
	}
}

/** Fan out one message to every stored subscription. Best-effort per-subscription;
 *  never throws — a push failure must never break the caller (a cron tick, a fn run). */
export async function notify(env: RtEnv, message: PushMessage, ttlSeconds = 60): Promise<{ sent: number; failed: number }> {
	if (!hasWebPush(env)) return { sent: 0, failed: 0 };
	let sent = 0;
	let failed = 0;
	for (const sub of await listSubscriptions(env)) {
		if (await sendToSubscription(env, sub, message, ttlSeconds)) sent++;
		else failed++;
	}
	return { sent, failed };
}
