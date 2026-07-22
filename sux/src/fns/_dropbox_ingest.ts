// Dropbox app-folder ingest watcher (#1355). Piggybacks the EXISTING cron heartbeat (no new
// cron trigger, per the issue) — lists the app folder's ingest/ subtree, routes each file
// through the shared _ingest_route.ts routing layer, then moves it to ingest/processed/<date>/
// so a re-poll never re-processes it (the move IS the idempotency mechanism — there is no
// separate seen-ledger). A per-file failure moves the file to ingest/failed/ instead and appends
// a note to the ingest ledger's existing error surface, rather than leaving it stuck retrying
// forever in the watched subtree.
//
// Subfolder = explicit mode override (ingest/extract/, ingest/summarize/, ingest/archive/);
// files dropped at ingest/ root fall through to _ingest_route.ts's smart-detect.
import type { RtEnv } from "../registry";
import { dropbox, hasDropbox } from "./dropbox";
import { routeIngestItem, type IngestRouteDeps } from "./_ingest_route";
import { errMsg, fromB64, vaultToday } from "./_util";
import { ledger } from "../ledger";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** Master switch — unset, or Dropbox itself unconfigured, ⇒ the sweep is a dormant no-op
 *  (mirrors _email_ingest.ts's hasEmailIngest / _document_radar.ts's convention). */
export const hasDropboxIngest = (env: RtEnv): boolean => flagOn(env.DROPBOX_INGEST_ENABLED) && hasDropbox(env);

const ROOT = "/ingest";
const MODE_SUBDIRS = ["", "/extract", "/summarize", "/archive"] as const;

type DbxFileEntry = { kind?: string; name?: string; path?: string; size?: number };

/** Injectable Dropbox seam (mirrors _scan_ingest.ts's ReprocessDeps DI shape) — tests drive the
 *  sweep loop without a real Dropbox token or network. Defaults dispatch through the `dropbox`
 *  Fn's own run() so there is exactly one Dropbox HTTP implementation in this repo. */
export type DropboxIngestOps = {
	list: (env: RtEnv, path: string) => Promise<DbxFileEntry[]>;
	getBytes: (env: RtEnv, path: string) => Promise<Uint8Array>;
	share: (env: RtEnv, path: string) => Promise<string | undefined>;
	move: (env: RtEnv, from: string, to: string) => Promise<void>;
};

async function dbxList(env: RtEnv, path: string): Promise<DbxFileEntry[]> {
	const r = await dropbox.run(env, { op: "list", path });
	if (r.isError) throw new Error(r.content?.[0]?.text ?? `dropbox list failed for ${path}`);
	const j = JSON.parse(r.content?.[0]?.text ?? "{}");
	return Array.isArray(j.entries) ? (j.entries as DbxFileEntry[]) : [];
}

async function dbxGetBytes(env: RtEnv, path: string): Promise<Uint8Array> {
	const r = await dropbox.run(env, { op: "get", path });
	if (r.isError) throw new Error(r.content?.[0]?.text ?? `dropbox get failed for ${path}`);
	const text = r.content?.[0]?.text ?? "";
	// op=get returns raw text directly for TEXT_EXT paths, or a JSON {base64,...} envelope for
	// binary (dropbox.ts's op=get branch) — try JSON first, fall back to treating it as text.
	try {
		const j = JSON.parse(text);
		if (j && typeof j.base64 === "string") return fromB64(j.base64);
		if (j && j.too_large_to_inline) throw new Error(`file too large to inline: ${path}`);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("file too large")) throw e;
	}
	return new TextEncoder().encode(text);
}

async function dbxShare(env: RtEnv, path: string): Promise<string | undefined> {
	const r = await dropbox.run(env, { op: "share", path });
	if (r.isError) return undefined;
	try {
		return JSON.parse(r.content?.[0]?.text ?? "{}").url;
	} catch {
		return undefined;
	}
}

async function dbxMove(env: RtEnv, from: string, to: string): Promise<void> {
	const r = await dropbox.run(env, { op: "move", path: from, to });
	if (r.isError) throw new Error(r.content?.[0]?.text ?? `dropbox move failed: ${from} -> ${to}`);
}

export function defaultDropboxIngestOps(): DropboxIngestOps {
	return { list: dbxList, getBytes: dbxGetBytes, share: dbxShare, move: dbxMove };
}

export type DropboxIngestReport = { scanned: number; processed: number; failed: number };

/**
 * One sweep of the app folder's ingest/ subtree. Best-effort + per-file isolated: a bad file
 * moves to ingest/failed/ and the sweep continues — one poisoned upload never blocks the rest of
 * the backlog. A missing subfolder (nothing has ever been dropped in ingest/extract/ yet) is not
 * an error, just nothing to do this cycle.
 */
export async function dropboxIngestTick(env: RtEnv, ops: DropboxIngestOps = defaultDropboxIngestOps(), routeDeps?: IngestRouteDeps): Promise<DropboxIngestReport> {
	const report: DropboxIngestReport = { scanned: 0, processed: 0, failed: 0 };
	if (!hasDropboxIngest(env)) return report;
	const date = vaultToday(env.VAULT_TZ);

	for (const sub of MODE_SUBDIRS) {
		const dir = `${ROOT}${sub}`;
		let entries: DbxFileEntry[];
		try {
			entries = await ops.list(env, dir);
		} catch {
			continue; // subfolder doesn't exist yet — not an error
		}
		const explicitMode = sub ? sub.slice(1) : undefined;
		for (const entry of entries) {
			if (entry.kind !== "file" || !entry.path || !entry.name) continue;
			report.scanned++;
			try {
				const bytes = await ops.getBytes(env, entry.path);
				const shareUrl = await ops.share(env, entry.path).catch(() => undefined);
				await routeIngestItem(
					env,
					{
						name: entry.name,
						bytes,
						mode: explicitMode,
						source: `Dropbox app folder ${entry.path}`,
						blobRef: { link: shareUrl ?? entry.path, placement: "dropbox" },
					},
					routeDeps,
				);
				await ops.move(env, entry.path, `${ROOT}/processed/${date}/${entry.name}`);
				report.processed++;
			} catch (e) {
				report.failed++;
				const reason = errMsg(e);
				console.warn(`dropbox-ingest: failed on ${entry.path} — ${reason}`);
				await ledger(env, "dropbox_ingest_failed")
					.mark(entry.path, reason)
					.catch(() => {});
				await ops.move(env, entry.path, `${ROOT}/failed/${entry.name}`).catch((moveErr) => console.warn(`dropbox-ingest: could not move failed file ${entry.path} — ${errMsg(moveErr)}`));
			}
		}
	}
	return report;
}
