import { type Fn, fail, ok } from "../registry";
import { fromB64, toB64 } from "./_util";

// Object storage in sux's R2. Bytes are content-addressed (key = sha256, so
// identical content dedupes to one immutable object — Nix-store style). Each put
// also mints a short uuid handle stored in KV (uuid → { r2 key, type, size }),
// and returns a resolvable URL ending in that uuid: GET /s/<uuid> streams it back.

const BASE = "https://sux.colinxs.workers.dev";
export const STORE_KV_PREFIX = "store:";

export type StoreRef = { key: string; content_type: string; size: number; sha256: string };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const isTexty = (ct: string): boolean => /^(text\/|application\/(json|xml|javascript|yaml|x-yaml)|application\/[a-z.+-]*\+(json|xml))/i.test(ct);

/** Accept a bare uuid or a .../s/<uuid> URL and return the uuid. */
function extractId(s: string): string {
	const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
	return m ? m[1].toLowerCase() : s.trim();
}

export const store: Fn = {
	name: "store",
	description:
		"Store and retrieve arbitrary content in sux's R2. Bytes are content-addressed (sha256 — identical content dedupes; Nix-store style); each put also mints a short uuid handle (kept in KV) and returns a resolvable URL ending in that uuid — GET /s/<uuid> streams the object back. " +
		"`op`: put (default) | get | list | delete. put takes `data` (utf-8 text) or `base64` (binary) + optional `content_type`; returns { uuid, url, key, sha256, size }. get takes `id` (uuid or url) or `key`; returns text for textual types else base64. delete takes the uuid `id` (removes the handle; the deduped blob is retained). list takes `prefix`/`limit` over raw R2 keys.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			op: { type: "string", enum: ["put", "get", "list", "delete"], default: "put" },
			data: { type: "string", description: "put: UTF-8 text to store." },
			base64: { type: "string", description: "put: base64 bytes to store (binary)." },
			content_type: { type: "string", description: "put: MIME type (default text/plain or application/octet-stream)." },
			id: { type: "string", description: "get/delete: the uuid handle or the /s/<uuid> URL." },
			key: { type: "string", description: "get: a raw R2 object key (alternative to id)." },
			prefix: { type: "string", description: "list: R2 key prefix filter." },
			limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		if (!env.R2) return fail('R2 is not available. Enable R2 (dashboard → R2) and add `"r2_buckets": [{ "binding": "R2", "bucket_name": "sux" }]` to wrangler.');
		const op = String(args?.op ?? "put");

		try {
			if (op === "put") {
				let bytes: Uint8Array;
				let ct: string;
				if (typeof args?.base64 === "string" && args.base64) {
					bytes = fromB64(args.base64);
					ct = String(args?.content_type ?? "application/octet-stream");
				} else if (typeof args?.data === "string") {
					bytes = new TextEncoder().encode(args.data);
					ct = String(args?.content_type ?? "text/plain; charset=utf-8");
				} else {
					return fail("put needs `data` (text) or `base64` (binary).");
				}
				const hex = await sha256Hex(bytes);
				const r2key = `cas/${hex}`;
				await env.R2.put(r2key, bytes, { httpMetadata: { contentType: ct }, customMetadata: { sha256: hex } });
				const uuid = crypto.randomUUID();
				const ref: StoreRef = { key: r2key, content_type: ct, size: bytes.length, sha256: hex };
				await env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify(ref));
				return ok(JSON.stringify({ uuid, url: `${BASE}/s/${uuid}`, key: r2key, sha256: hex, size: bytes.length, content_type: ct }, null, 2));
			}

			if (op === "get") {
				let r2key: string | undefined;
				let ct: string | undefined;
				if (typeof args?.id === "string" && args.id) {
					const uuid = extractId(args.id);
					const raw = await env.OAUTH_KV.get(`${STORE_KV_PREFIX}${uuid}`);
					if (!raw) return fail(`No stored object for id '${uuid}'.`);
					const ref = JSON.parse(raw) as StoreRef;
					r2key = ref.key;
					ct = ref.content_type;
				} else if (typeof args?.key === "string" && args.key) {
					r2key = args.key;
				} else {
					return fail("get needs `id` (uuid/url) or `key`.");
				}
				if (!r2key) return fail("get needs `id` (uuid/url) or `key`.");
				const obj = await env.R2.get(r2key);
				if (!obj) return fail(`No object at key '${r2key}'.`);
				const type = ct ?? obj.httpMetadata?.contentType ?? "application/octet-stream";
				if (isTexty(type)) return ok(JSON.stringify({ key: r2key, size: obj.size, content_type: type, text: await obj.text() }, null, 2));
				return ok(JSON.stringify({ key: r2key, size: obj.size, content_type: type, base64: toB64(new Uint8Array(await obj.arrayBuffer())) }, null, 2));
			}

			if (op === "delete") {
				if (!args?.id) return fail("delete needs the uuid `id`.");
				const uuid = extractId(String(args.id));
				await env.OAUTH_KV.delete(`${STORE_KV_PREFIX}${uuid}`);
				return ok(JSON.stringify({ deleted: true, id: uuid, note: "handle removed; the content-addressed blob is retained (may be shared)." }, null, 2));
			}

			if (op === "list") {
				const res = await env.R2.list({ prefix: args?.prefix ? String(args.prefix) : undefined, limit: Math.min(1000, Math.max(1, Number(args?.limit) || 100)) });
				return ok(JSON.stringify({ objects: res.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })), truncated: Boolean(res.truncated), cursor: res.cursor }, null, 2));
			}

			return fail(`Unknown op '${op}'.`);
		} catch (e) {
			return fail(`store (${op}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
