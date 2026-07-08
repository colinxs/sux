import { type Fn, fail, ok } from "../registry";
import { fromB64, toB64 } from "./_util";

// Dropbox as the human-facing blob store (R2 `store` is the machine-facing
// twin). The token belongs to an App-folder-scoped app: it structurally cannot
// see anything outside /Apps/<app>/, so the credential scope is the safety
// boundary and no mutation gates are needed (docs/proposals/domains.md
// §2-dropbox). All paths here are relative to the app-folder root.
const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
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
// routing needed (same call as obsidian's remoteFetch to its Funnel).
async function rpc(env: any, path: string, body: unknown): Promise<{ status: number; json: any }> {
	const resp = await fetch(`${API}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.DROPBOX_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	const json: any = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

/** Create a shared link for a path, reusing the existing one on 409. */
async function sharedLink(env: any, path: string): Promise<string | undefined> {
	const mk = await rpc(env, "/sharing/create_shared_link_with_settings", { path });
	if (mk.status === 200 && mk.json?.url) return mk.json.url;
	if (String(mk.json?.error_summary ?? "").includes("shared_link_already_exists")) {
		const ls = await rpc(env, "/sharing/list_shared_links", { path, direct_only: true });
		return ls.json?.links?.[0]?.url;
	}
	return undefined;
}

/** Upload bytes into the app folder and return path + shared link (reused by ingest). */
export async function dropboxPut(env: any, path: string, bytes: Uint8Array): Promise<{ path: string; size: number; url?: string } | { error: string }> {
	const resp = await fetch(`${CONTENT}/files/upload`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.DROPBOX_TOKEN}`,
			"Content-Type": "application/octet-stream",
			"Dropbox-API-Arg": headerSafeJson({ path, mode: "overwrite", autorename: false, mute: true }),
		},
		body: bytes as BodyInit,
		signal: AbortSignal.timeout(60_000),
	});
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
		if (!env.DROPBOX_TOKEN) {
			return fail("Dropbox not configured. Register a Dropbox app with App-folder permission and set DROPBOX_TOKEN (the app's access token) as a worker secret.");
		}
		const op = String(args?.op ?? "");
		const path = norm(args?.path);
		try {
			if (op === "put") {
				if (!path) return fail("op=put requires a `path`.");
				let bytes: Uint8Array;
				if (typeof args?.base64 === "string" && args.base64) bytes = fromB64(args.base64);
				else if (typeof args?.data === "string" && args.data) bytes = new TextEncoder().encode(args.data);
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
				const size = Number(meta.json?.size ?? 0);
				if (size > MAX_INLINE_BYTES) {
					return ok(JSON.stringify({ path, size, too_large_to_inline: true, url: await sharedLink(env, path) }, null, 2));
				}
				const resp = await fetch(`${CONTENT}/files/download`, {
					method: "POST",
					headers: { Authorization: `Bearer ${env.DROPBOX_TOKEN}`, "Dropbox-API-Arg": headerSafeJson({ path }) },
					signal: AbortSignal.timeout(60_000),
				});
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
