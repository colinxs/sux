import { type Fn, fail, ok } from "../registry";
import { staged } from "../stage";
import { maybeDecompress } from "./_gzip";
import { errMsg, extractStoreId, fromB64, isExpired, putBlob, STORE_KV_PREFIX, storeBase, toB64, oj, writeNamedProjection } from "./_util";
import { PHI_PREFIX } from "../mychart";

// Object storage in sux's R2. Bytes are content-addressed (key = sha256, so
// identical content dedupes to one immutable object — Nix-store style). Each put
// also mints a short uuid handle stored in KV (uuid → { r2 key, type, size }),
// and returns a resolvable URL ending in that uuid: GET /s/<uuid> streams it back.
// The put path itself lives in _util.putBlob, shared with every binary-output fn.

export type StoreRef = { key: string; content_type: string; size: number; sha256: string; expiry?: number };

/** Above this, get won't inline text/base64 — it returns the streaming URL ref instead. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

const isTexty = (ct: string): boolean => /^(text\/|application\/(json|xml|javascript|yaml|x-yaml)|application\/[a-z.+-]*\+(json|xml))/i.test(ct);

export const store: Fn = {
	name: "store",
	description:
		"Store and retrieve arbitrary content in sux's R2. Bytes are content-addressed (sha256 — identical content dedupes; Nix-store style); each put also mints a short uuid handle (kept in KV) and returns a resolvable URL ending in that uuid — GET /s/<uuid> streams the object back. " +
		"`op`: put (default) | get | list | delete. put takes `data` (utf-8 text) or `base64` (binary) + optional `content_type`, optional `ttl_seconds` (positive int — the uuid handle self-expires after that many seconds, for ephemeral artifacts; omit for a permanent handle), and optional `r2_path` (also write the bytes under a browsable files/<r2_path> R2 key for S3-client browsing — the CAS ref stays canonical); returns { uuid, url, key, sha256, size, expiry?, r2_path? }. put mints a world-readable URL, so a FRESH put STAGES A PREVIEW BY DEFAULT (nothing written) — re-call with the returned commit_token to write, or pass force:true to write in one shot. get takes `id` (uuid or url) or `key`; returns text for textual types else base64 (an expired/absent handle is not-found). delete takes the uuid `id` (removes the handle; the deduped blob is retained). list takes `prefix`/`limit` over raw R2 keys and returns { objects, truncated, cursor }; when truncated, pass the returned `cursor` back to page through the rest.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			op: { type: "string", enum: ["put", "get", "list", "delete"], default: "put" },
			data: { type: "string", description: "put: UTF-8 text to store." },
			base64: { type: "string", description: "put: base64 bytes to store (binary)." },
			content_type: { type: "string", description: "put: MIME type (default text/plain or application/octet-stream)." },
			ttl_seconds: { type: "integer", minimum: 1, description: "put: optional seconds until the uuid handle self-expires (ephemeral artifacts); omit for a permanent handle." },
			r2_path: { type: "string", description: "Also write this object under a browsable files/<r2_path> R2 key (exact path, e.g. 'library/notes.txt') alongside the canonical CAS ref — for browsing via an S3 client (Cyberduck/Mountain Duck/rclone). Collisions are suffixed (-2, -3, ...), never overwritten." },
			id: { type: "string", description: "get/delete: the uuid handle or the /s/<uuid> URL." },
			key: { type: "string", description: "get: a raw R2 object key (alternative to id)." },
			prefix: { type: "string", description: "list: R2 key prefix filter." },
			limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
			cursor: { type: "string", description: "list: opaque page cursor from a prior truncated response — pass it back to fetch the next page." },
			stage: { type: "boolean", description: "put: preview + commit_token, no write." },
			commit_token: { type: "string", description: "put: commit a previously staged write (the payload must match what was staged)." },
			force: { type: "boolean", description: "put: skip staging and write in one shot (the ! override). By default a fresh put stages a preview first." },
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
				let ttlSeconds: number | undefined;
				if (args?.ttl_seconds !== undefined) {
					ttlSeconds = Number(args.ttl_seconds);
					if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return fail("ttl_seconds must be a positive integer.");
				}
				// Mints a world-readable /s/<uuid> URL for whatever bytes it's given — the
				// one concrete egress channel here, so it stages by default (STAGE_KINDS)
				// rather than writing on the first call.
				const payload = { data: args?.data, base64: args?.base64, content_type: args?.content_type, ttl_seconds: args?.ttl_seconds, r2_path: args?.r2_path };
				const preview = { action: "store put", content_type: ct, size: bytes.length, ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}), ...(typeof args?.r2_path === "string" && args.r2_path.trim() ? { r2_path: args.r2_path } : {}) };
				const gateArgs = { stage: args?.stage === true, commit_token: args?.commit_token ? String(args.commit_token) : undefined, force: args?.force === true };
				const mutate = async () => {
					const ref = await putBlob(env, bytes, ct, ttlSeconds !== undefined ? { ttlSeconds } : undefined);
					if (typeof args?.r2_path === "string" && args.r2_path.trim()) {
						try {
							const finalPath = await writeNamedProjection(env, args.r2_path, bytes, ct);
							return { ...ref, r2_path: finalPath };
						} catch (e) {
							// projection is best-effort — a failed named-zone write must never fail the canonical store
							console.warn(`store: r2_path projection failed for '${args.r2_path}' — ${errMsg(e)}`);
							return ref;
						}
					}
					return ref;
				};
				const out = await staged(env, "store_put", gateArgs, payload, preview, mutate);
				return ok(oj("stageResult" in out ? out.stageResult : out.result));
			}

			if (op === "get") {
				let r2key: string | undefined;
				let ct: string | undefined;
				let uuid: string | undefined;
				let sha: string | undefined;
				if (typeof args?.id === "string" && args.id) {
					uuid = extractStoreId(args.id);
					const raw = await env.OAUTH_KV.get(`${STORE_KV_PREFIX}${uuid}`);
					if (!raw) return fail(`No stored object for id '${uuid}'.`);
					const ref = JSON.parse(raw) as StoreRef;
					// Expired handle → not-found; best-effort delete any handle KV hasn't reaped.
					if (isExpired(ref)) {
						await env.OAUTH_KV.delete(`${STORE_KV_PREFIX}${uuid}`).catch(() => {});
						return fail(`No stored object for id '${uuid}' (expired).`);
					}
					r2key = ref.key;
					ct = ref.content_type;
					sha = ref.sha256;
				} else if (typeof args?.key === "string" && args.key) {
					r2key = args.key;
				} else {
					return fail("get needs `id` (uuid/url) or `key`.");
				}
				if (!r2key) return fail("get needs `id` (uuid/url) or `key`.");
				// PHI fence: raw FHIR/HealthKit blobs live under phi/ in this same bucket
				// (mychart putPhi). Every other egress path refuses that prefix (/s/<uuid> in
				// observability.ts, the kv fns); store's read side must too, or a raw `key`
				// (or a handle pointing at one) reads PHI straight back into context.
				if (r2key.startsWith(PHI_PREFIX)) return fail("that key is private (PHI) and cannot be read through store.");
				const obj = await env.R2.get(r2key);
				if (!obj) return fail(`No object at key '${r2key}'.`);
				const type = ct ?? obj.httpMetadata?.contentType ?? "application/octet-stream";
				// Inline-vs-URL is decided on the DECOMPRESSED size (what the caller actually
				// gets back), not the maybe-gzip'd R2-stored size — a payload can compress
				// under MAX_INLINE_BYTES but decompress well past it.
				const bytes = await maybeDecompress(new Uint8Array(await obj.arrayBuffer()));
				if (bytes.length > MAX_INLINE_BYTES) {
					// Too large to inline (texty or binary) — hand back the streaming URL
					// ref instead (same shape as put's as:"url" response). If we came in
					// via a raw key there's no handle yet, so mint one.
					if (!uuid) {
						uuid = crypto.randomUUID();
						sha = obj.customMetadata?.sha256;
						await env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify({ key: r2key, content_type: type, size: obj.size, sha256: sha }));
					}
					return ok(oj({ url: `${storeBase(env)}/s/${uuid}`, key: r2key, sha256: sha, size: obj.size, content_type: type, note: `object is ${bytes.length} bytes decompressed (> ${MAX_INLINE_BYTES} inline limit); stream it from the url instead.` }));
				}
				if (isTexty(type)) return ok(oj({ key: r2key, size: bytes.length, content_type: type, text: new TextDecoder().decode(bytes) }));
				return ok(oj({ key: r2key, size: bytes.length, content_type: type, base64: toB64(bytes) }));
			}

			if (op === "delete") {
				if (!args?.id) return fail("delete needs the uuid `id`.");
				const uuid = extractStoreId(String(args.id));
				await env.OAUTH_KV.delete(`${STORE_KV_PREFIX}${uuid}`);
				return ok(oj({ deleted: true, id: uuid, note: "handle removed; the content-addressed blob is retained (may be shared)." }));
			}

			if (op === "list") {
				const res = await env.R2.list({ prefix: args?.prefix ? String(args.prefix) : undefined, limit: Math.min(1000, Math.max(1, Number(args?.limit) || 100)), cursor: args?.cursor ? String(args.cursor) : undefined });
				// Drop any phi/ keys from the listing — the private PHI prefix must never be
				// enumerable through store, so `list prefix:"phi/"` returns empty and an
				// unprefixed list omits them (same boundary observability.ts enforces on /s/).
				return ok(oj({ objects: res.objects.filter((o) => !o.key.startsWith(PHI_PREFIX)).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })), truncated: Boolean(res.truncated), cursor: res.truncated ? res.cursor : undefined }));
			}

			return fail(`Unknown op '${op}'.`);
		} catch (e) {
			return fail(`store (${op}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
