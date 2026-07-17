// Content-addressed blob store (shared with the `store` fn) and its KV ref
// parsing. Split out of fns/_util.ts (#565) — re-exported from there, so existing
// `from "./_util"` imports are unaffected.

import type { RtEnv } from "../../registry";
import { maybeCompress, maybeDecompress } from "../_gzip";
import { errMsg, isHttpUrl, oj } from "../../prim";
import { FANOUT_STORE_TTL_S } from "./fanout";
import { toB64 } from "./bytes";

export const STORE_KV_PREFIX = "store:";

/**
 * Base URL for public /s/<uuid> handles. Configurable via the STORE_BASE env
 * var (wrangler `vars`) so staging/local deploys mint URLs that point at
 * themselves; falls back to the prod hostname.
 */
export function storeBase(env: RtEnv): string {
	const v = (env as { STORE_BASE?: string }).STORE_BASE;
	return (typeof v === "string" && v ? v : "https://suxos.net").replace(/\/+$/, "");
}

/** Accept a bare uuid or a .../s/<uuid> URL and return the uuid (shared with `store`). */
export function extractStoreId(s: string): string {
	const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
	return m ? m[1].toLowerCase() : s.trim();
}

/** The uuid when `u` is a /s/<uuid> CAS handle URL (any host — the path shape is ours), else null. */
export function storeRefUuid(u: unknown): string | null {
	if (!isHttpUrl(u)) return null;
	try {
		const m = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(new URL(u).pathname);
		return m ? m[1].toLowerCase() : null;
	} catch {
		return null;
	}
}

/** True when a handle's absolute unix-seconds `expiry` is set and in the past. */
export function isExpired(ref: { expiry?: number }, now = Date.now()): boolean {
	return typeof ref.expiry === "number" && ref.expiry * 1000 <= now;
}

/** Resolve a /s/<uuid> handle to its bytes via KV→R2 directly (no HTTP hop). */
export async function getBlob(env: RtEnv, uuid: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	if (!env.R2) return null;
	const raw = await env.OAUTH_KV.get(`${STORE_KV_PREFIX}${uuid}`);
	if (!raw) return null;
	const ref = JSON.parse(raw) as { key: string; content_type?: string; expiry?: number };
	// An expired handle is a not-found (KV's own expirationTtl usually evicts it,
	// but enforce it here too and best-effort delete a handle KV hasn't reaped yet).
	if (isExpired(ref)) {
		await env.OAUTH_KV.delete(`${STORE_KV_PREFIX}${uuid}`).catch(() => {});
		return null;
	}
	const obj = await env.R2.get(ref.key);
	if (!obj) return null;
	const stored = new Uint8Array(await obj.arrayBuffer());
	// Stored bytes may be a transparent-gzip frame — inflate back to the original.
	// maybeCompress only frames bytes it actually shrank; an incompressible raw
	// payload that happens to start with our marker+gzip-magic prefix (00 1f 8b)
	// looks framed but isn't. Fall back to the raw bytes on a decode failure
	// rather than surfacing that collision as permanent data loss.
	const bytes = await maybeDecompress(stored).catch(() => stored);
	return { bytes, contentType: ref.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream" };
}

export type BlobRef = { uuid: string; url: string; key: string; sha256: string; size: number; content_type: string; expiry?: number };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Content-address bytes into R2 (cas/<sha256> — identical bytes dedupe), mint a
 * uuid handle in KV, and return the public /s/<uuid> URL. The Nix-store move:
 * any fn's binary output becomes a ~100-token reference every other fn can take
 * as a `url` input. Throws when R2 is unbound.
 */
export async function putBlob(env: RtEnv, bytes: Uint8Array, contentType: string, opts?: { ttlSeconds?: number }): Promise<BlobRef> {
	if (!env.R2) throw new Error("R2 is not available (bucket binding missing).");
	const sha256 = await sha256Hex(bytes);
	const key = `cas/${sha256}`;
	const uuid = crypto.randomUUID();
	// Optional expiry (ephemeral artifacts — render screenshots/pdfs). Record an
	// absolute unix-seconds `expiry` in the handle JSON so any reader can enforce
	// it, and set KV's own expirationTtl so the handle self-evicts. KV rejects an
	// expirationTtl under 60s, so below that we lean on the JSON expiry alone — the
	// reader still treats it as not-found once past. No ttl = permanent handle.
	const ttl = typeof opts?.ttlSeconds === "number" && opts.ttlSeconds > 0 ? Math.floor(opts.ttlSeconds) : undefined;
	const expiry = ttl ? Math.floor(Date.now() / 1000) + ttl : undefined;
	const handle: Record<string, unknown> = { key, content_type: contentType, size: bytes.length, sha256 };
	if (expiry) handle.expiry = expiry;
	const kvOpts = ttl && ttl >= 60 ? { expirationTtl: ttl } : undefined;
	// Transparent gzip for text-ish blobs (marker-framed; getBlob/store/`/s/`
	// inflate on read). The CAS key stays the sha256 of the ORIGINAL bytes, so
	// dedup is unaffected and identical content still collapses to one object.
	const stored = await maybeCompress(bytes, contentType);
	// The R2 object and KV handle are independent writes — run them concurrently.
	await Promise.all([
		env.R2.put(key, stored, { httpMetadata: { contentType }, customMetadata: { sha256 } }),
		env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify(handle), kvOpts),
	]);
	return { uuid, url: `${storeBase(env)}/s/${uuid}`, key, sha256, size: bytes.length, content_type: contentType, ...(expiry ? { expiry } : {}) };
}

/**
 * Deliver binary output either inline (base64, the default — token-expensive but
 * self-contained) or `as: "url"` via the content-addressed store (~100 tokens,
 * consumable as any other fn's `url` input). Callers pass their own inline shape.
 */
export async function deliverBytes(
	env: RtEnv,
	bytes: Uint8Array,
	contentType: string,
	as: string | undefined,
	inline: () => { content: Array<{ type: "text"; text: string }> },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	if (as === "url") {
		try {
			const ref = await putBlob(env, bytes, contentType, { ttlSeconds: FANOUT_STORE_TTL_S });
			return { content: [{ type: "text", text: oj({ url: ref.url, sha256: ref.sha256, size: ref.size, content_type: contentType }) }] };
		} catch (e) {
			return { content: [{ type: "text", text: `as:"url" needs the R2 store: ${errMsg(e)}` }], isError: true };
		}
	}
	return inline();
}

/**
 * THE standard inline envelope for binary output: { mime, size (bytes), base64 }.
 * Every binary-output fn's default (non-url) delivery uses this one shape so
 * consumers can parse any of them identically.
 */
export function inlineB64(bytes: Uint8Array, mime: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify({ mime, size: bytes.length, base64: toB64(bytes) }) }] };
}
