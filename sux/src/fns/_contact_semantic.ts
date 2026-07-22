import type { RtEnv } from "../registry";
import { cosine, decodeEmbedding, embed, encodeEmbedding } from "./_embed";
import { jmap } from "./jmap";

// contact_semantic — the vault_semantic pattern (_vault_semantic.ts: brute-force KV cosine kNN
// over Workers-AI embeddings) applied to contacts, mirroring _mail_semantic.ts's shape almost
// exactly: same JMAP transport (ContactCard/query·get·changes are RFC-shaped the same way
// Email/query·get·changes are), same state-keyed incremental-vs-full-rebuild contract. Unlike
// mail, a ContactCard carries no receivedAt-equivalent recency field, so truncation past
// INDEX_MAX can't prefer "newest" the way mail's eviction does — it instead keeps whatever was
// just (re-)embedded over stale cached entries, the same "fresh-first" compromise
// _files_semantic.ts uses for the same reason (files have no recency field either).

const VERSION = 1;
// Bounds a pathological address book; well above a normal contact list's size (mirrors
// _mail_semantic.ts's INDEX_MAX, which bounds a mailbox the same way).
const INDEX_MAX = 2000;
// Single JMAP account — no repo/branch dimension needed. Mirrors _mail_semantic.ts's KV_KEY.
export const KV_KEY = "sux:contact:semantic";
// ContactCard/changes pages at most this many ids per call; caps the paging loop against a huge
// backlog, mirroring _mail_semantic.ts's MAX_CHANGE_PAGES.
const MAX_CHANGE_PAGES = 5;

export type ContactSemanticChunk = { id: string; name: string; company: string; emails: string[]; phones: string[]; embedding: number[] };
export type ContactSemanticIndex = { state: string; version: number; at: number; total: number; truncated: boolean; chunks: ContactSemanticChunk[] };

// Persisted shape packs each chunk's embedding via encodeEmbedding (base64 Float32) — same ~4x
// space saving _vault_semantic.ts's StoredSemanticChunk documents (#717); embeddings dominate the blob.
type StoredContactSemanticChunk = Omit<ContactSemanticChunk, "embedding"> & { embedding: string };
type StoredContactSemanticIndex = Omit<ContactSemanticIndex, "chunks"> & { chunks: StoredContactSemanticChunk[] };

function toStored(index: ContactSemanticIndex): StoredContactSemanticIndex {
	return { ...index, chunks: index.chunks.map((c) => ({ ...c, embedding: encodeEmbedding(c.embedding) })) };
}
function fromStored(stored: StoredContactSemanticIndex): ContactSemanticIndex {
	return { ...stored, chunks: stored.chunks.map((c) => ({ ...c, embedding: decodeEmbedding(c.embedding) })) };
}
/** Same defensive shape guard as _vault_semantic.ts's isStoredSemanticIndex (#722) — a cached blob
 *  whose chunks aren't actually the current persisted shape is treated as a cache miss and rebuilt. */
function isStoredContactSemanticIndex(v: unknown): v is StoredContactSemanticIndex {
	if (!v || typeof v !== "object") return false;
	const s = v as StoredContactSemanticIndex;
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
async function writeBlob(env: RtEnv, blob: StoredContactSemanticIndex): Promise<boolean> {
	try {
		await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.put(KV_KEY, JSON.stringify(blob));
		return true;
	} catch (e) {
		console.log(`contact_semantic: index write failed: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** Run a raw jmap batch and parse its JSON envelope; throws on transport/auth failure. Mirrors
 *  _mail_semantic.ts's jmapBatch. */
async function jmapBatch(env: RtEnv, calls: [string, Record<string, unknown>, string][]): Promise<{ methodResponses: any[] }> {
	const r = await jmap.run(env, { calls });
	const text = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(text || "jmap call failed");
	return JSON.parse(text);
}
/** The named call's result — {ok:false} both when the call is absent AND when the server answered
 *  it with a per-call `error` (e.g. cannotCalculateChanges). Mirrors _mail_semantic.ts's methodResult. */
function methodResult(resp: { methodResponses: any[] }, method: string, callId: string): { ok: boolean; value: any } {
	for (const mr of resp.methodResponses ?? []) {
		if (mr[2] !== callId) continue;
		if (mr[0] === "error") return { ok: false, value: mr[1] };
		if (mr[0] === method) return { ok: true, value: mr[1] };
	}
	return { ok: false, value: null };
}

/** Full name from JSCard name.components (RFC 9553) when there's no `full`. Duplicated from
 *  mail-mcp.ts's identical helper rather than imported — mail-mcp.ts imports FROM this module
 *  (for the contact_semantic tool), so importing back would cycle. */
function nameFromComponents(components: any): string {
	if (!Array.isArray(components)) return "";
	const by = (kind: string) => components.find((c: any) => c?.kind === kind)?.value;
	return [by("given"), by("surname")].filter(Boolean).join(" ");
}

// The embedding input combines every field a query might match on — name, company, emails,
// phones — since a card's retrieval-relevant text isn't concentrated in one field the way an
// email's subject+preview is.
const textOf = (name: string, company: string, emails: string[], phones: string[]): string => [name, company, emails.join(" "), phones.join(" ")].filter(Boolean).join("\n");

function mapCards(list: any[]): Array<Omit<ContactSemanticChunk, "embedding">> {
	return (list ?? [])
		.map((c) => {
			const emails = c?.emails ? (Object.values(c.emails).map((e: any) => e?.address).filter(Boolean) as string[]) : [];
			const phones = c?.phones ? (Object.values(c.phones).map((p: any) => p?.number).filter(Boolean) as string[]) : [];
			const company = c?.organizations ? ((Object.values(c.organizations)[0] as any)?.name ?? "") : "";
			const name = c?.name?.full || nameFromComponents(c?.name?.components) || company || emails[0] || "(no name)";
			return { id: String(c?.id ?? ""), name, company, emails, phones };
		})
		.filter((c) => c.id);
}

/** Fetch + embed a batch of contact ids. Ids that fail to resolve (deleted between the id list
 *  and this fetch) are silently dropped rather than scored as empty chunks. */
async function embedIds(env: RtEnv, ids: string[]): Promise<ContactSemanticChunk[]> {
	if (!ids.length) return [];
	const resp = await jmapBatch(env, [["ContactCard/get", { ids, properties: ["id", "name", "emails", "phones", "organizations"] }, "g"]]);
	const g = methodResult(resp, "ContactCard/get", "g");
	const items = mapCards(g.ok ? (g.value?.list ?? []) : []);
	if (!items.length) return [];
	const vecs = await embed(env, items.map((i) => textOf(i.name, i.company, i.emails, i.phones)));
	return items.map((it, i) => ({ ...it, embedding: vecs[i] ?? [] }));
}

/** Full rebuild: the whole address book (up to INDEX_MAX), embedded from scratch. Anchors future
 *  incremental updates on the ContactCard/get response's `state` (JMAP core §5.1 — the
 *  ContactCard data type's current server-side state), same as mail's Email/get state. */
async function buildFull(env: RtEnv): Promise<ContactSemanticIndex> {
	const resp = await jmapBatch(env, [
		["ContactCard/query", { limit: INDEX_MAX, calculateTotal: true }, "q"],
		["ContactCard/get", { "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" }, properties: ["id", "name", "emails", "phones", "organizations"] }, "g"],
	]);
	const q = methodResult(resp, "ContactCard/query", "q");
	const g = methodResult(resp, "ContactCard/get", "g");
	const ids: string[] = q.ok ? (q.value?.ids ?? []) : [];
	const total = q.ok && Number.isFinite(Number(q.value?.total)) ? Number(q.value.total) : ids.length;
	const state = typeof g.value?.state === "string" ? g.value.state : "";
	const items = mapCards(g.ok ? (g.value?.list ?? []) : []);
	const vecs = items.length ? await embed(env, items.map((i) => textOf(i.name, i.company, i.emails, i.phones))) : [];
	const chunks: ContactSemanticChunk[] = items.map((it, i) => ({ ...it, embedding: vecs[i] ?? [] }));
	return { state, version: VERSION, at: Date.now(), total, truncated: total > INDEX_MAX, chunks };
}

/** Incremental update from `cached.state`: page ContactCard/changes (created/updated/destroyed),
 *  embed only the changed ids, drop the destroyed/stale ones from the cached chunk set. Returns
 *  null when the server can't diff from `cached.state` anymore (cannotCalculateChanges) — the
 *  caller's cue to fall back to buildFull, mirroring _mail_semantic.ts's applyChanges. */
async function applyChanges(env: RtEnv, cached: ContactSemanticIndex): Promise<{ index: ContactSemanticIndex; changed: boolean } | null> {
	let state = cached.state;
	const created = new Set<string>();
	const updated = new Set<string>();
	const destroyed = new Set<string>();
	for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
		const resp = await jmapBatch(env, [["ContactCard/changes", { sinceState: state, maxChanges: 256 }, "c"]]);
		const c = methodResult(resp, "ContactCard/changes", "c");
		if (!c.ok) {
			if (String(c.value?.type ?? "") === "cannotCalculateChanges") return null;
			throw new Error(`ContactCard/changes failed: ${c.value?.type ?? "unknown"}`);
		}
		for (const id of c.value?.created ?? []) created.add(String(id));
		for (const id of c.value?.updated ?? []) updated.add(String(id));
		for (const id of c.value?.destroyed ?? []) destroyed.add(String(id));
		state = String(c.value?.newState ?? state);
		if (!c.value?.hasMoreChanges) break;
	}
	if (!created.size && !updated.size && !destroyed.size) return { index: cached, changed: false };
	for (const id of destroyed) {
		created.delete(id);
		updated.delete(id);
	}
	// A card can be "updated" for a field this index doesn't embed (e.g. a note field JMAP still
	// reports as a change) — only re-embed an id when we don't already hold a valid embedding for
	// it, same skip _mail_semantic.ts applies for a triage relabel's "updated" (#734).
	const alreadyEmbedded = new Set(cached.chunks.filter((c) => c.embedding.length > 0).map((c) => c.id));
	const toEmbed = [...created, ...[...updated].filter((id) => !alreadyEmbedded.has(id))];
	const fresh = await embedIds(env, toEmbed);
	const freshIds = new Set(fresh.map((c) => c.id));
	const kept = cached.chunks.filter((c) => !destroyed.has(c.id) && !freshIds.has(c.id));
	// `fresh` first, `kept` second: ContactCard has no recency field to sort eviction by (unlike
	// mail's receivedAt) — same "fresh-first" compromise _files_semantic.ts's applyChanges uses
	// for the same reason.
	let chunks = [...fresh, ...kept];
	const truncated = cached.truncated || chunks.length > INDEX_MAX;
	if (chunks.length > INDEX_MAX) chunks = chunks.slice(0, INDEX_MAX);
	return { index: { state, version: VERSION, at: Date.now(), total: Math.max(0, cached.total + created.size - destroyed.size), truncated, chunks }, changed: true };
}

/** The contact semantic index — incrementally maintained (ContactCard/changes) against the
 *  cached state, falling back to a full rebuild when there's no cache, a shape drift, or the
 *  server can no longer diff from the cached state. Returns null when JMAP isn't configured,
 *  mirroring _mail_semantic.ts's null-on-unconfigured contract. */
export async function contactSemanticIndex(env: RtEnv): Promise<ContactSemanticIndex | null> {
	if (!(env as { FASTMAIL_TOKEN?: string }).FASTMAIL_TOKEN) return null;
	const storedCached = await readBlob(env);
	if (isStoredContactSemanticIndex(storedCached) && storedCached.version === VERSION) {
		const cached = fromStored(storedCached);
		try {
			const result = await applyChanges(env, cached);
			if (result) {
				if (result.changed) {
					const wrote = await writeBlob(env, toStored(result.index));
					if (!wrote) console.log("contact_semantic: incremental index write dropped (over KV's 25MiB cap or a codec error) — next call re-diffs from the same state");
				}
				return result.index;
			}
		} catch (e) {
			console.log(`contact_semantic: incremental update failed (${e instanceof Error ? e.message : String(e)}) — falling back to a full rebuild`);
		}
	}
	const fresh = await buildFull(env);
	const wrote = await writeBlob(env, toStored(fresh));
	if (!wrote) console.log("contact_semantic: index write for full rebuild was dropped (over KV's 25MiB cap or a codec error) — every request will re-embed until it fits");
	return fresh;
}

export type ContactSemanticHit = { id: string; name: string; company: string; emails: string[]; phones: string[]; score: number };

/** Brute-force kNN: cosine-rank the contact chunks against `queryVec`, take the top-k. Mirrors
 *  _vault_semantic.ts's topKByCosine (same KISS brute-force choice). */
export function topKContactByCosine(queryVec: number[], chunks: ContactSemanticChunk[], k = 8): ContactSemanticHit[] {
	return chunks
		.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0)
		.map((c) => ({ id: c.id, name: c.name, company: c.company, emails: c.emails, phones: c.phones, score: cosine(queryVec, c.embedding) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, k));
}
