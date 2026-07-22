import type { RtEnv } from "../registry";
import { cosine, decodeEmbedding, embed, encodeEmbedding } from "./_embed";
import { jmap } from "./jmap";

// mail_semantic — the vault_semantic pattern (_vault_semantic.ts: brute-force KV cosine kNN
// over Workers-AI embeddings) applied to mail. The vault's cache key is a single content sha
// (git HEAD); mail has no such thing, so this index is keyed by JMAP's Email data-type `state`
// string instead and MAINTAINED INCREMENTALLY via Email/changes (add created/updated ids, drop
// destroyed) rather than rebuilt wholesale on every request — re-embedding the whole mailbox on
// every new message would be unbounded AI cost. A `state` the server can no longer diff against
// (cannotCalculateChanges — the common case for a first-ever build, or a since-state that has
// aged out server-side) falls back to a full rebuild, same as a vault HEAD cache miss.

const VERSION = 1;
// Bounds a pathological mailbox; well above a normal "recent mail" retrieval window (mirrors
// _vault_semantic.ts's INDEX_MAX, which bounds a vault the same way).
const INDEX_MAX = 1000;
// Single JMAP account (one Fastmail mailbox) — no repo/branch dimension needed, unlike the vault's
// per-repo keying (obsidian.ts's gitSemanticIndexKey). Mirrors mail-mcp.ts's PUSH_KV_KEY: one fixed key.
export const KV_KEY = "sux:mail:semantic";
// Email/changes pages at most this many ids per call; cap the paging loop against a huge backlog
// (e.g. a since-state that's months stale) rather than looping unbounded.
const MAX_CHANGE_PAGES = 5;

export type MailSemanticChunk = { id: string; subject: string; from: string; receivedAt: string; text: string; embedding: number[] };
export type MailSemanticIndex = { state: string; version: number; at: number; total: number; truncated: boolean; chunks: MailSemanticChunk[] };

// Persisted shape packs each chunk's embedding via encodeEmbedding (base64 Float32) — same ~4x
// space saving _vault_semantic.ts's StoredSemanticChunk documents (#717); embeddings dominate the blob.
type StoredMailSemanticChunk = Omit<MailSemanticChunk, "embedding"> & { embedding: string };
type StoredMailSemanticIndex = Omit<MailSemanticIndex, "chunks"> & { chunks: StoredMailSemanticChunk[] };

function toStored(index: MailSemanticIndex): StoredMailSemanticIndex {
	return { ...index, chunks: index.chunks.map((c) => ({ ...c, embedding: encodeEmbedding(c.embedding) })) };
}
function fromStored(stored: StoredMailSemanticIndex): MailSemanticIndex {
	return { ...stored, chunks: stored.chunks.map((c) => ({ ...c, embedding: decodeEmbedding(c.embedding) })) };
}
/** Same defensive shape guard as _vault_semantic.ts's isStoredSemanticIndex (#722) — a cached blob
 *  whose chunks aren't actually the current persisted shape is treated as a cache miss and rebuilt. */
function isStoredMailSemanticIndex(v: unknown): v is StoredMailSemanticIndex {
	if (!v || typeof v !== "object") return false;
	const s = v as StoredMailSemanticIndex;
	return typeof s.state === "string" && Array.isArray(s.chunks) && s.chunks.every((c) => typeof c?.id === "string" && typeof c?.embedding === "string");
}

async function readBlob(env: RtEnv): Promise<unknown | null> {
	const raw = await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.get(KV_KEY).catch(() => null);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeBlob(env: RtEnv, blob: StoredMailSemanticIndex): Promise<boolean> {
	try {
		await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.put(KV_KEY, JSON.stringify(blob));
		return true;
	} catch (e) {
		console.log(`mail_semantic: index write failed: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

const textOf = (subject: string, preview: string): string => `${subject}\n${preview}`.trim();

/** Run a raw jmap batch and parse its JSON envelope; throws on transport/auth failure. */
async function jmapBatch(env: RtEnv, calls: [string, Record<string, unknown>, string][]): Promise<{ methodResponses: any[] }> {
	const r = await jmap.run(env, { calls });
	const text = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(text || "jmap call failed");
	return JSON.parse(text);
}
/** The named call's result — {ok:false} both when the call is absent AND when the server answered
 *  it with a per-call `error` (e.g. cannotCalculateChanges), so callers branch on `.value.type` either way. */
function methodResult(resp: { methodResponses: any[] }, method: string, callId: string): { ok: boolean; value: any } {
	for (const mr of resp.methodResponses ?? []) {
		if (mr[2] !== callId) continue;
		if (mr[0] === "error") return { ok: false, value: mr[1] };
		if (mr[0] === method) return { ok: true, value: mr[1] };
	}
	return { ok: false, value: null };
}

// `text` (the stored/displayed chunk) is the preview ALONE, matching recall.ts's fromMail's
// existing keyword-search display shape (subject rides separately in `[mail:subject]` / the
// `subject` field, never duplicated into the body). The embedding input, however, combines
// subject+preview (textOf) — the subject line carries real retrieval signal a preview-only
// vector would miss, it just isn't repeated in what gets displayed/stored.
function mapEmails(list: any[]): Array<Omit<MailSemanticChunk, "embedding">> {
	return (list ?? [])
		.map((e) => ({
			id: String(e?.id ?? ""),
			subject: String(e?.subject ?? "(no subject)"),
			from: e?.from?.[0]?.email || e?.from?.[0]?.name || "",
			receivedAt: String(e?.receivedAt ?? ""),
			text: String(e?.preview ?? "").trim(),
		}))
		.filter((e) => e.id);
}

/** Fetch + embed a batch of message ids (subject + preview). Ids that fail to resolve (deleted
 *  between the id list and this fetch) are silently dropped rather than scored as empty chunks. */
async function embedIds(env: RtEnv, ids: string[]): Promise<MailSemanticChunk[]> {
	if (!ids.length) return [];
	const resp = await jmapBatch(env, [["Email/get", { ids, properties: ["id", "subject", "from", "receivedAt", "preview"] }, "g"]]);
	const g = methodResult(resp, "Email/get", "g");
	const items = mapEmails(g.ok ? (g.value?.list ?? []) : []);
	if (!items.length) return [];
	const vecs = await embed(env, items.map((i) => textOf(i.subject, i.text)));
	return items.map((it, i) => ({ ...it, embedding: vecs[i] ?? [] }));
}

/** Full rebuild: the most recent INDEX_MAX messages, embedded from scratch. Anchors future
 *  incremental updates on the Email/get response's `state` (RFC 8620 §5.1 — the Email data
 *  type's current server-side state), NOT the query's queryState (a distinct, result-order token). */
async function buildFull(env: RtEnv): Promise<MailSemanticIndex> {
	const resp = await jmapBatch(env, [
		["Email/query", { sort: [{ property: "receivedAt", isAscending: false }], limit: INDEX_MAX, calculateTotal: true }, "q"],
		["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "subject", "from", "receivedAt", "preview"] }, "g"],
	]);
	const q = methodResult(resp, "Email/query", "q");
	const g = methodResult(resp, "Email/get", "g");
	const ids: string[] = q.ok ? (q.value?.ids ?? []) : [];
	const total = q.ok && Number.isFinite(Number(q.value?.total)) ? Number(q.value.total) : ids.length;
	const state = typeof g.value?.state === "string" ? g.value.state : "";
	const items = mapEmails(g.ok ? (g.value?.list ?? []) : []);
	const vecs = items.length ? await embed(env, items.map((i) => textOf(i.subject, i.text))) : [];
	const chunks: MailSemanticChunk[] = items.map((it, i) => ({ ...it, embedding: vecs[i] ?? [] }));
	return { state, version: VERSION, at: Date.now(), total, truncated: total > INDEX_MAX, chunks };
}

/** Incremental update from `cached.state`: page Email/changes (created/updated/destroyed), embed
 *  only the changed ids, drop the destroyed/stale ones from the cached chunk set. Returns null
 *  when the server can't diff from `cached.state` anymore (cannotCalculateChanges) — the caller's
 *  cue to fall back to buildFull, same as a vault HEAD mismatch triggering a rebuild. */
async function applyChanges(env: RtEnv, cached: MailSemanticIndex): Promise<{ index: MailSemanticIndex; changed: boolean } | null> {
	let state = cached.state;
	const created = new Set<string>();
	const updated = new Set<string>();
	const destroyed = new Set<string>();
	for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
		const resp = await jmapBatch(env, [["Email/changes", { sinceState: state, maxChanges: 256 }, "c"]]);
		const c = methodResult(resp, "Email/changes", "c");
		if (!c.ok) {
			if (String(c.value?.type ?? "") === "cannotCalculateChanges") return null;
			throw new Error(`Email/changes failed: ${c.value?.type ?? "unknown"}`);
		}
		for (const id of c.value?.created ?? []) created.add(String(id));
		for (const id of c.value?.updated ?? []) updated.add(String(id));
		for (const id of c.value?.destroyed ?? []) destroyed.add(String(id));
		state = String(c.value?.newState ?? state);
		if (!c.value?.hasMoreChanges) break;
	}
	// Nothing to persist: same chunk set, so a re-serialize + KV `put` of a blob that can approach
	// KV's 25 MiB cap would buy nothing but a bumped `at`. `changed: false` tells the caller to skip
	// the write; the next call simply re-diffs from the same (still-valid) `cached.state`.
	if (!created.size && !updated.size && !destroyed.size) return { index: cached, changed: false };
	for (const id of destroyed) {
		created.delete(id);
		updated.delete(id);
	}
	// An Email's CONTENT (subject/preview) is immutable once received — JMAP reports "updated"
	// for a keyword/mailbox move too (mail_triage relabels constantly), which would otherwise
	// re-embed unchanged text on every triage tick. Only re-embed an `updated` id when we don't
	// already hold a valid embedding for it; `created` ids always need a first embed.
	const alreadyEmbedded = new Set(cached.chunks.filter((c) => c.embedding.length > 0).map((c) => c.id));
	const toEmbed = [...created, ...[...updated].filter((id) => !alreadyEmbedded.has(id))];
	const fresh = await embedIds(env, toEmbed);
	const freshIds = new Set(fresh.map((c) => c.id));
	// Drop destroyed ids outright; drop stale copies of ids that got freshly (re-)embedded above.
	// An `updated` id whose embedding was already valid (skipped above) simply stays as-is.
	const kept = cached.chunks.filter((c) => !destroyed.has(c.id) && !freshIds.has(c.id));
	let chunks = [...kept, ...fresh];
	const truncated = cached.truncated || chunks.length > INDEX_MAX;
	// Keep the newest INDEX_MAX by receivedAt, not the array *tail* — `kept` isn't guaranteed
	// oldest-first (JMAP doesn't order Email/get results), so a tail slice could evict recent-but-
	// not-newest mail while retaining genuinely old mail. Mirrors buildFull's "most recent N" intent.
	if (chunks.length > INDEX_MAX) {
		chunks = [...chunks].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0)).slice(0, INDEX_MAX);
	}
	return { index: { state, version: VERSION, at: Date.now(), total: Math.max(0, cached.total + created.size - destroyed.size), truncated, chunks }, changed: true };
}

/** The mail semantic index — incrementally maintained (Email/changes) against the cached state,
 *  falling back to a full rebuild when there's no cache, a shape drift (#722's guard, applied here
 *  too), or the server can no longer diff from the cached state. Returns null when JMAP isn't
 *  configured, mirroring _vault_semantic.ts's null-on-unconfigured contract. */
export async function mailSemanticIndex(env: RtEnv): Promise<MailSemanticIndex | null> {
	if (!(env as { FASTMAIL_TOKEN?: string }).FASTMAIL_TOKEN) return null;
	const storedCached = await readBlob(env);
	if (isStoredMailSemanticIndex(storedCached) && storedCached.version === VERSION) {
		const cached = fromStored(storedCached);
		try {
			const result = await applyChanges(env, cached);
			if (result) {
				if (result.changed) {
					const wrote = await writeBlob(env, toStored(result.index));
					if (!wrote) console.log("mail_semantic: incremental index write dropped (over KV's 25MiB cap or a codec error) — next call re-diffs from the same state");
				}
				return result.index;
			}
		} catch (e) {
			console.log(`mail_semantic: incremental update failed (${e instanceof Error ? e.message : String(e)}) — falling back to a full rebuild`);
		}
	}
	const fresh = await buildFull(env);
	const wrote = await writeBlob(env, toStored(fresh));
	if (!wrote) console.log("mail_semantic: index write for full rebuild was dropped (over KV's 25MiB cap or a codec error) — every request will re-embed until it fits");
	return fresh;
}

/** Read-ONLY sibling of mailSemanticIndex: return the CACHED index if a valid warm blob is
 *  present, else null — it NEVER runs applyChanges (JMAP round-trips) or a full rebuild. Same
 *  reason as _vault_semantic.ts's vaultSemanticIndexCached (#1298): the `oracle ask` query path
 *  must do no network/embed work, or it blows its per-domain budget on every call. A warm cache
 *  answers (bounded-stale — no incremental catch-up here); a cold cache degrades that domain
 *  fast. The real substrate fix is the Vectorize index (#1290). */
export async function mailSemanticIndexCached(env: RtEnv): Promise<MailSemanticIndex | null> {
	if (!(env as { FASTMAIL_TOKEN?: string }).FASTMAIL_TOKEN) return null;
	const storedCached = await readBlob(env);
	if (isStoredMailSemanticIndex(storedCached) && storedCached.version === VERSION) return fromStored(storedCached);
	return null;
}

export type MailSemanticHit = { id: string; subject: string; from: string; receivedAt: string; text: string; score: number };

/** Brute-force kNN: cosine-rank the mail chunks against `queryVec`, take the top-k. Mirrors
 *  _vault_semantic.ts's topKByCosine (same KISS brute-force choice — a bounded, ≤INDEX_MAX-sized
 *  corpus is a microsecond linear scan, no Vectorize needed). */
export function topKMailByCosine(queryVec: number[], chunks: MailSemanticChunk[], k = 8): MailSemanticHit[] {
	return chunks
		.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
		.map((c) => ({ id: c.id, subject: c.subject, from: c.from, receivedAt: c.receivedAt, text: c.text, score: cosine(queryVec, c.embedding) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, k));
}
