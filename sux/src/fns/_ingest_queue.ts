// General ingest queue consumer — fed by R2 event notifications on the
// sux-ingest transit bucket (docs/design/scan-to-vault-pipeline.md, suxrouter).
// Dispatches on key prefix; scans are tenant #1. Lifecycle: scan → vault →
// forget — the R2 object is deleted only after BOTH durable homes (Dropbox
// file + vault note) are confirmed, so every failure mode leaves the scan
// sitting in the previous stage, retrying. Unknown prefixes retry until DLQ
// (visible, never silently dropped).
import type { RtEnv } from "../registry";
import { dropboxPut, hasDropbox } from "./dropbox";
import { vaultCfg, vaultPut } from "./obsidian";

type R2Event = { action?: string; bucket?: string; object?: { key?: string; size?: number; eTag?: string }; eventTime?: string };

export async function handleIngestBatch(batch: MessageBatch<unknown>, env: RtEnv): Promise<void> {
	for (const m of batch.messages) {
		let done = false;
		try {
			done = await handleOne(env, (m.body ?? {}) as R2Event);
		} catch (e) {
			console.warn(`ingest-queue: ${String((e as Error)?.message ?? e)}`);
		}
		if (done) m.ack();
		else m.retry();
	}
}

async function handleOne(env: RtEnv, ev: R2Event): Promise<boolean> {
	const key = ev.object?.key ?? "";
	if (!key.startsWith("scan/")) {
		console.warn(`ingest-queue: unknown key prefix, retrying toward DLQ: ${JSON.stringify(key)}`);
		return false;
	}
	if (!env.INGEST_R2) {
		console.warn("ingest-queue: INGEST_R2 binding missing — retrying");
		return false;
	}
	const obj = await env.INGEST_R2.get(key);
	if (!obj) return true; // already processed — idempotent re-delivery after delete
	const bytes = new Uint8Array(await obj.arrayBuffer());
	const name = key.split("/").pop() ?? "scan.pdf";

	// 1. Dropbox app folder — the human-facing durable home. overwrite:true (the
	// default) is what makes redelivery idempotent (same key → same path → same
	// bytes).
	if (!hasDropbox(env)) {
		console.warn("ingest-queue: Dropbox not configured — retrying");
		return false;
	}
	const dbxPath = `/Scans/${key.slice("scan/".length)}`;
	const put = await dropboxPut(env, dbxPath, bytes);
	if ("error" in put) {
		console.warn(`ingest-queue: dropbox put failed: ${put.error}`);
		return false;
	}

	// 2. Vault note — deterministic path keyed on the object name, so a
	// re-delivered message that already wrote the note sees exists:true and
	// treats it as success (idempotent), never a -1 duplicate.
	const cfg = vaultCfg(env);
	if ("error" in cfg) {
		console.warn(`ingest-queue: vault not configured: ${cfg.error} — retrying`);
		return false;
	}
	const day = (ev.eventTime ?? new Date().toISOString()).slice(0, 10);
	const stem = name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
	const notePath = `Inbox/scan-${day} ${stem}.md`;
	const note = [
		"---",
		"type: capture",
		`created: ${new Date().toISOString()}`,
		`source: ${JSON.stringify(`hp-m479fdw scan ${name}`)}`,
		"tags: [capture, scan]",
		"---",
		"",
		`# Scan ${day} — ${stem}`,
		"",
		`Scanned document: [${name}](${put.url ?? ""})`,
		`Dropbox path: \`${put.path}\` (${put.size} bytes)`,
		"",
	].join("\n");
	const w = await vaultPut(env, cfg, notePath, note, `sux: scan ingest ${name}`, { failIfExists: true });
	if (!w.ok && !w.exists) {
		console.warn(`ingest-queue: vault note failed: ${w.error}`);
		return false;
	}

	// 3. Forget: both durable homes confirmed — drop the transit copy.
	await env.INGEST_R2.delete(key);
	return true;
}
