import type { RtEnv } from "../registry";
import { contactSemanticIndex } from "./_contact_semantic";
import { filesSemanticIndex } from "./_files_semantic";
import { mailSemanticIndex } from "./_mail_semantic";
import { listChunks, listDomains } from "./_source";
import { coarseDomain, type IndexUnit, pointerForSourceChunk } from "./_vectorize";
import { purgeStaleVaultChunks, vaultSemanticIndex, vaultSemanticIndexCached } from "./_vault_semantic";
import { vaultCfg } from "./obsidian";

// _reindex — enumeration for the unified Vectorize index's backfill (#1290). The index starts
// EMPTY; until it's populated it answers nothing, so this is REQUIRED, not optional. It reads
// the existing corpus — the KV cosine cores (vault/mail/files/contacts) and the `_source` chunk
// store (oracle/assim/phi/advise) — turning each domain into a stably-ordered, namespace-tagged
// `IndexUnit[]` that reuses each chunk's already-stored embedding (no re-embed on the
// source-chunk domains).
//
// ONE enumeration, ONE driver (#1315). `enumerateDomain` is consumed by `_backfill.ts` alone —
// the DURABLE batched job: enumerate, upsert a bounded WINDOW per tick, persist a per-domain
// cursor, resume next tick until every domain is done. THIS is what drives sux-corpus to full
// population without a timeout. (The earlier synchronous one-shot `reindexCorpus` — enumerate a
// domain, upsert the whole list in one request — timed out on the real corpus, the #1315 root
// cause; it had zero production callers by the time #1363 removed it, `backfillTick` having
// fully replaced it per #1330.)
//
// CHEAP vs BUILDING read. The full pass reads the BUILDING semantic index (rebuilds/warms the
// KV cosine cache as a side effect). The batched backfill passes `{cached:true}` so vault reads
// the READ-ONLY cached blob (`vaultSemanticIndexCached`) — a single decompress, never a
// re-embed — so a tick's cost is the bounded upsert, not a corpus rebuild. mail/files/contacts
// have only their incremental builder (cheap when the cache is warm, which production is — the
// cosine fallback serves those domains today, #1310), so `cached` is a no-op for them.
//
// IDEMPOTENT + RESUMABLE: stable vector ids (_vectorize.vectorId) mean re-running upserts in
// place, never duplicates — so a run that dies partway is safe to re-run. Each domain runs
// independently and its failure is captured, never fatal to the rest — a partial backfill is a
// valid, resumable state.

/** The natural-source domains backed by a KV cosine core (their own build path embeds; we
 *  reuse those embeddings) plus `source` — the umbrella over every `_source` chunk domain
 *  (oracle/assim/phi/advise), swept in one listDomains pass. */
export type ReindexDomain = "vault" | "mail" | "files" | "contacts" | "source";
export const REINDEX_DOMAINS: ReindexDomain[] = ["vault", "mail", "files", "contacts", "source"];

/** The result of enumerating one domain's corpus into upsertable units. `ready` distinguishes
 *  "this is the authoritative (possibly empty) set" (true — the backfill may mark the domain
 *  DONE) from "can't read it right now — a cold cache or an unavailable index" (false — the
 *  backfill leaves the cursor and RETRIES next tick, never prematurely marking done). */
export type EnumerateResult = { items: IndexUnit[]; ready: boolean; note?: string };

/** Group an array by a key, preserving order — used to number a source's chunks per-source
 *  (vault/files emit many chunks per path) so `sub` is a stable within-source index. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const it of items) (m.get(key(it)) ?? m.set(key(it), []).get(key(it))!).push(it);
	return m;
}

async function enumerateVault(env: RtEnv, cached: boolean): Promise<EnumerateResult> {
	const cfg = vaultCfg(env);
	if ("error" in cfg) return { items: [], ready: true, note: "vault not configured" };
	// Self-heal stale/moved paths (#1347) on the cached (durable backfill) path only — the
	// building path already gets a correct, freshly-listed core from buildVaultSemanticIndex,
	// so there's nothing there to purge. One cheap list call per tick, no re-embed.
	if (cached) {
		const { purgedPaths } = await purgeStaleVaultChunks(env, cfg);
		if (purgedPaths.length) console.log(`reindex: vault purge dropped ${purgedPaths.length} stale path(s): ${purgedPaths.slice(0, 5).join(", ")}${purgedPaths.length > 5 ? "…" : ""}`);
	}
	const idx = cached ? await vaultSemanticIndexCached(env, cfg) : await vaultSemanticIndex(env, cfg);
	if (!idx) return { items: [], ready: false, note: cached ? "vault index not warm yet — will resume once built" : "vault index unavailable (no KV or HEAD unresolved)" };
	const items: IndexUnit[] = [];
	for (const [path, chunks] of groupBy(idx.chunks, (c) => c.path)) {
		chunks.forEach((c, sub) => items.push({ domain: "vault", unit: { sourceKey: path, sub, pointer: `vault:${path}`, text: c.text, embedding: c.embedding } }));
	}
	return { items, ready: true };
}

async function enumerateMail(env: RtEnv): Promise<EnumerateResult> {
	if (!(env as { FASTMAIL_TOKEN?: string }).FASTMAIL_TOKEN) return { items: [], ready: true, note: "mail not configured" };
	const idx = await mailSemanticIndex(env);
	if (!idx) return { items: [], ready: false, note: "mail index unavailable — will resume" };
	// The passage text mirrors _answer.ts's fromMailIndex so a Vectorize-served mail citation
	// reads identically to a cosine-served one (header + preview; the pointer is the JMAP id).
	const items: IndexUnit[] = idx.chunks.map((c) => ({
		domain: "mail",
		unit: {
			sourceKey: c.id,
			sub: 0,
			pointer: `mail:${c.id}`,
			text: `${c.subject || "(no subject)"} — from ${c.from}${c.receivedAt ? ` on ${c.receivedAt}` : ""}\n${c.text}`,
			embedding: c.embedding,
		},
	}));
	return { items, ready: true };
}

async function enumerateFiles(env: RtEnv): Promise<EnumerateResult> {
	const idx = await filesSemanticIndex(env);
	if (!idx) return { items: [], ready: false, note: "files index unavailable — will resume" };
	const items: IndexUnit[] = [];
	for (const [path, chunks] of groupBy(idx.chunks, (c) => c.path)) {
		chunks.forEach((c, sub) => items.push({ domain: "files", unit: { sourceKey: path, sub, pointer: `files:${path}`, text: c.text, embedding: c.embedding } }));
	}
	return { items, ready: true };
}

async function enumerateContacts(env: RtEnv): Promise<EnumerateResult> {
	const idx = await contactSemanticIndex(env);
	if (!idx) return { items: [], ready: false, note: "contacts index unavailable — will resume" };
	// Mirrors _answer.ts's fromContactsIndex passage text.
	const items: IndexUnit[] = idx.chunks.map((c) => ({
		domain: "contacts",
		unit: {
			sourceKey: c.id,
			sub: 0,
			pointer: `contact:${c.id}`,
			text: `${c.name}${c.company ? ` · ${c.company}` : ""}${c.emails.length ? ` · ${c.emails.join(", ")}` : ""}${c.phones.length ? ` · ${c.phones.join(", ")}` : ""}`,
			embedding: c.embedding,
		},
	}));
	return { items, ready: true };
}

/** Sweep every `_source` chunk domain (oracle/assim/phi/advise) in one listDomains pass, mapping
 *  each chunk onto its coarse namespace via the SAME id scheme the write-path tap uses
 *  (sourceKey=c.id, sub="") — so a live-written chunk and its backfilled copy collapse to one
 *  vector. Ordering is stable: listDomains sorts, listChunks sorts by ts, so a cursor offset is
 *  a fixed position. Reuses stored embeddings; never re-embeds. */
async function enumerateSource(env: RtEnv): Promise<EnumerateResult> {
	const domains = await listDomains(env);
	const items: IndexUnit[] = [];
	for (const d of domains) {
		for (const c of await listChunks(env, d)) {
			items.push({ domain: coarseDomain(c.domain), unit: { sourceKey: c.id, sub: "", pointer: pointerForSourceChunk(c), text: c.text, embedding: c.embedding ?? [] } });
		}
	}
	return { items, ready: true, note: `${domains.length} source domain(s)` };
}

/** Turn one domain's existing corpus into a stably-ordered, namespace-tagged `IndexUnit[]`.
 *  Shared by the full reindex and the batched backfill. `cached:true` prefers the read-only
 *  cached read where one exists (vault) so a repeated per-tick enumeration never re-embeds. */
export async function enumerateDomain(env: RtEnv, domain: ReindexDomain, opts: { cached?: boolean } = {}): Promise<EnumerateResult> {
	switch (domain) {
		case "vault":
			return enumerateVault(env, opts.cached ?? false);
		case "mail":
			return enumerateMail(env);
		case "files":
			return enumerateFiles(env);
		case "contacts":
			return enumerateContacts(env);
		case "source":
			return enumerateSource(env);
	}
}
