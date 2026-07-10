import { type Fn, fail, ok, type RtEnv } from "../registry";
import { fromB64, toB64 } from "./_util";

// Dropbox as the human-facing blob store (R2 `store` is the machine-facing
// twin). The token belongs to an App-folder-scoped app: it structurally cannot
// see anything outside /Apps/<app>/, so the credential scope is the safety
// boundary and no mutation gates are needed (docs/proposals/domains.md
// §2-dropbox). All paths here are relative to the app-folder root.
const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const OAUTH_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const TOKEN_KEY = "sux:dropbox:token";

// Dropbox access tokens are SHORT-LIVED (~4h `sl.` tokens) — a static
// DROPBOX_TOKEN would expire mid-day. The durable path mirrors fns/kroger.ts:
// store a long-lived REFRESH token + the app key/secret, mint short-lived
// access tokens on demand, and cache them in KV until just before they expire.
// A static DROPBOX_TOKEN is still honored as a quick-test fallback.
async function dropboxToken(env: RtEnv): Promise<string> {
	if (env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY) {
		const cached = await env.OAUTH_KV?.get(TOKEN_KEY);
		if (cached) return cached;
		// Confidential client (app secret set) → HTTP Basic auth. Public client (PKCE,
		// no secret) → client_id in the body, no Authorization header. Both are valid
		// Dropbox refresh flows; the public path lets the Worker hold NO long-lived
		// app secret at all — only the app key (public) + the refresh token.
		const hasSecret = Boolean(env.DROPBOX_APP_SECRET);
		const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
		if (hasSecret) headers.Authorization = `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}`;
		const resp = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers,
			body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(String(env.DROPBOX_REFRESH_TOKEN))}${hasSecret ? "" : `&client_id=${encodeURIComponent(String(env.DROPBOX_APP_KEY))}`}`,
			signal: AbortSignal.timeout(20_000),
		});
		const j: any = await resp.json().catch(() => null);
		if (!resp.ok || !j?.access_token) throw new Error(`Dropbox token refresh HTTP ${resp.status}: ${j?.error_description ?? j?.error ?? "no access_token"}`);
		const ttl = Math.max(60, (Number(j?.expires_in) || 14_400) - 60); // clamp to KV's 60s floor
		await env.OAUTH_KV?.put(TOKEN_KEY, String(j.access_token), { expirationTtl: ttl });
		return String(j.access_token);
	}
	if (env.DROPBOX_TOKEN) return String(env.DROPBOX_TOKEN);
	throw new Error("Dropbox not configured. Set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY (+ DROPBOX_APP_SECRET) for the durable refresh flow, or DROPBOX_TOKEN for a short-lived quick test.");
}

/** True when Dropbox is usable by EITHER path — the durable refresh flow or a
 * static token. Callers (incl. ingest's blob routing) must gate on this, not on
 * env.DROPBOX_TOKEN alone, or the recommended durable-only config looks unset. */
export const hasDropbox = (env: RtEnv): boolean => Boolean((env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY) || env.DROPBOX_TOKEN);

/** Drop the cached access token so the next call re-mints from the refresh token.
 * Called on a 401 so a server-side revocation (app disconnect / password change)
 * self-heals on the next request instead of failing for the whole KV TTL (~4h). */
async function invalidateToken(env: RtEnv): Promise<void> {
	try {
		await env.OAUTH_KV?.delete(TOKEN_KEY);
	} catch {}
}
const TEXT_EXT = /\.(md|txt|json|csv|tsv|ya?ml|xml|html?|js|ts|css)$/i;
/** Above this, get returns metadata + a share hint instead of inlining bytes. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

// Dropbox requires the Dropbox-API-Arg header to be HTTP-header-safe JSON:
// every char >= 0x7F escaped as \uXXXX (raw UTF-8 header bytes get a 400).
const headerSafeJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const norm = (p: unknown): string => {
	const s = String(p ?? "")
		.trim()
		.replace(/^\/+/, "");
	return s ? `/${s}` : "";
};

// Direct fetch throughout: Dropbox is a public API — no residential-proxy
// routing needed (same call as obsidian's remoteFetch to its Funnel). All calls
// go through dbxFetch: it resolves the (KV-cached) bearer and, on a 401 under the
// refresh flow, drops the cache and re-mints once — so a server-side revocation
// self-heals on the next request instead of failing for the whole ~4h TTL.
async function dbxFetch(env: RtEnv, url: string, build: (token: string) => RequestInit): Promise<Response> {
	const first = await fetch(url, build(await dropboxToken(env)));
	if (first.status !== 401 || !(env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY)) return first;
	await invalidateToken(env);
	return fetch(url, build(await dropboxToken(env)));
}

async function rpc(env: RtEnv, path: string, body: unknown): Promise<{ status: number; json: any }> {
	const resp = await dbxFetch(env, `${API}${path}`, (token) => ({
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	}));
	const json: any = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

/** Create a shared link for a path, reusing the existing one on 409. */
async function sharedLink(env: RtEnv, path: string): Promise<string | undefined> {
	const mk = await rpc(env, "/sharing/create_shared_link_with_settings", { path });
	if (mk.status === 200 && mk.json?.url) return mk.json.url;
	if (String(mk.json?.error_summary ?? "").includes("shared_link_already_exists")) {
		const ls = await rpc(env, "/sharing/list_shared_links", { path, direct_only: true });
		return ls.json?.links?.[0]?.url;
	}
	return undefined;
}

/** Upload bytes into the app folder and return path + shared link (reused by ingest).
 * Default overwrites the exact path (op=put semantics: the caller named it). Pass
 * overwrite:false for a never-clobber upload — Dropbox autorenames on collision
 * (e.g. "report (1).pdf") and the returned `path` reflects the actual name. */
export async function dropboxPut(env: RtEnv, path: string, bytes: Uint8Array, opts?: { overwrite?: boolean }): Promise<{ path: string; size: number; url?: string } | { error: string }> {
	const clobber = opts?.overwrite !== false;
	const resp = await dbxFetch(env, `${CONTENT}/files/upload`, (token) => ({
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/octet-stream",
			"Dropbox-API-Arg": headerSafeJson({ path, mode: clobber ? "overwrite" : "add", autorename: !clobber, mute: true }),
		},
		body: bytes as BodyInit,
		signal: AbortSignal.timeout(60_000),
	}));
	const json: any = await resp.json().catch(() => null);
	if (resp.status >= 400) return { error: `Dropbox upload error: ${json?.error_summary ?? `HTTP ${resp.status}`}` };
	const stored = json?.path_display ?? path;
	return { path: stored, size: json?.size ?? bytes.length, url: await sharedLink(env, stored) };
}

export const dropbox: Fn = {
	name: "dropbox",
	cost: 2,
	description:
		"Dropbox app-folder blob store — the human-facing twin of R2 `store`: files land in /Apps/<app>/ and sync to every device (the App-folder token cannot see the rest of Dropbox). op: put (`path` + `data` utf-8 or `base64` binary → uploads and returns the shared link) | get (`path` → text for textual extensions, else base64; large files return metadata + shared link) | list (`path` folder, default root; paginate with `cursor`) | delete (`path`) | share (`path` → shared link, created or reused). Shared links are PUBLIC 'anyone with the link' URLs. Paths are relative to the app-folder root. Needs DROPBOX_TOKEN (App-folder scoped access token).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["put", "get", "list", "delete", "share"] },
			path: { type: "string", description: "Path relative to the app-folder root (folder path for list; file path otherwise)." },
			cursor: { type: "string", description: "list: continue a paginated listing (returned as `cursor` when has_more)." },
			data: { type: "string", description: "put: UTF-8 text to upload." },
			base64: { type: "string", description: "put: base64 bytes to upload (binary)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		if (!hasDropbox(env)) {
			return fail("Dropbox not configured. Set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY (+ DROPBOX_APP_SECRET) — the durable refresh flow (short-lived access tokens are minted and KV-cached) — or DROPBOX_TOKEN for a short-lived quick test. The app needs the files.content.read/write, files.metadata.read, and sharing.read/write scopes.");
		}
		const op = String(args?.op ?? "");
		const path = norm(args?.path);
		try {
			if (op === "put") {
				if (!path) return fail("op=put requires a `path`.");
				let bytes: Uint8Array;
				if (typeof args?.base64 === "string" && args.base64) bytes = fromB64(args.base64);
				else if (typeof args?.data === "string") bytes = new TextEncoder().encode(args.data); // "" is a valid empty upload
				else return fail("op=put requires `data` (utf-8) or `base64` (binary).");
				const r = await dropboxPut(env, path, bytes);
				if ("error" in r) return fail(r.error);
				return ok(JSON.stringify({ ok: true, ...r, ...(r.url ? {} : { warning: "uploaded, but no shared link minted — check the token's sharing scope" }) }, null, 2));
			}
			if (op === "get") {
				if (!path) return fail("op=get requires a `path`.");
				// Metadata first: an oversize file must never be buffered into the
				// isolate (128MB limit) just to learn it is too big.
				const meta = await rpc(env, "/files/get_metadata", { path });
				if (meta.status >= 400) return fail(`Dropbox error: ${meta.json?.error_summary ?? `HTTP ${meta.status}`} (${path})`);
				if (meta.json?.[".tag"] === "folder") return fail(`'${path}' is a folder — use op=list.`);
				// Trust the metadata size as the gate; if it is absent (anomalous — a
				// file entry always carries size), refuse rather than download unbounded.
				const size = Number(meta.json?.size);
				if (!Number.isFinite(size)) return fail(`Dropbox returned no size for '${path}'; refusing to download an unbounded body.`);
				if (size > MAX_INLINE_BYTES) {
					return ok(JSON.stringify({ path, size, too_large_to_inline: true, url: await sharedLink(env, path) }, null, 2));
				}
				const resp = await dbxFetch(env, `${CONTENT}/files/download`, (token) => ({
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": headerSafeJson({ path }) },
					signal: AbortSignal.timeout(60_000),
				}));
				if (resp.status >= 400) return fail(`Dropbox download error: ${(await resp.text().catch(() => "")).slice(0, 200) || `HTTP ${resp.status}`}`);
				const bytes = new Uint8Array(await resp.arrayBuffer());
				if (TEXT_EXT.test(path)) return ok(new TextDecoder().decode(bytes));
				return ok(JSON.stringify({ path, size: bytes.length, base64: toB64(bytes) }, null, 2));
			}
			if (op === "list") {
				const { status, json } = args?.cursor
					? await rpc(env, "/files/list_folder/continue", { cursor: String(args.cursor) })
					: await rpc(env, "/files/list_folder", { path, recursive: false, limit: 500 });
				if (status >= 400) return fail(`Dropbox list error: ${json?.error_summary ?? `HTTP ${status}`}`);
				const entries = (json?.entries ?? []).map((e: any) => ({ kind: e?.[".tag"], name: e?.name, path: e?.path_display, size: e?.size }));
				const hasMore = json?.has_more === true;
				return ok(JSON.stringify({ dir: path || "/", count: entries.length, has_more: hasMore, ...(hasMore ? { cursor: json?.cursor } : {}), entries }, null, 2));
			}
			if (op === "delete") {
				if (!path) return fail("op=delete requires a `path`.");
				const { status, json } = await rpc(env, "/files/delete_v2", { path });
				if (status >= 400) return fail(`Dropbox delete error: ${json?.error_summary ?? `HTTP ${status}`} (${path})`);
				return ok(JSON.stringify({ ok: true, deleted: json?.metadata?.path_display ?? path }, null, 2));
			}
			if (op === "share") {
				if (!path) return fail("op=share requires a `path`.");
				const url = await sharedLink(env, path);
				if (!url) return fail(`Could not create a shared link for ${path}.`);
				return ok(JSON.stringify({ path, url }, null, 2));
			}
			return fail(`Unknown op '${op}'. Use put | get | list | delete | share.`);
		} catch (e) {
			return fail(`dropbox (${op}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
