import type { RtEnv } from "../registry";
import { contactSemanticIndex } from "./_contact_semantic";
import { filesSemanticIndex } from "./_files_semantic";
import { mailSemanticIndex } from "./_mail_semantic";
import { listChunks, listDomains } from "./_source";
import { errMsg } from "./_util";
import { coarseDomain, CORPUS_INDEX, hasVectorize, type IndexUnit, pointerForSourceChunk, upsertIndexUnits } from "./_vectorize";
import { purgeStaleVaultChunks, vaultSemanticIndex, vaultSemanticIndexCached } from "./_vault_semantic";
import { vaultCfg } from "./obsidian";

// _reindex — the backfill/repopulate path for the unified Vectorize index (#1290). The index
// starts EMPTY; until it's populated it answers nothing, so this is REQUIRED, not optional.
// It reads the existing corpus — the KV cosine cores (vault/mail/files/contacts) and the
// `_source` chunk store (oracle/assim/phi/advise) — and upserts every chunk into `sux-corpus`
// under its per-domain namespace, REUSING each chunk's already-stored embedding (no re-embed
// on the source-chunk domains).
//
// TWO drivers over ONE enumeration (#1315). `enumerateDomain` turns a domain's existing corpus
// into a stably-ordered `IndexUnit[]` (namespace-tagged), and both consumers share it:
//   • `reindexCorpus` (this file) — the full synchronous pass: enumerate a domain, upsert the
//     whole list. Fine for a small domain or a test; TIMES OUT on the real corpus (the #1315
//     root cause — one request can't embed/upsert the whole thing), so it stays the admin
//     one-shot / small-domain path, not the production backfill.
//   • `_backfill.ts` — the DURABLE batched job: enumerate, upsert a bounded WINDOW per tick,
//     persist a per-domain cursor, resume next tick until every domain is done. THIS is what
//     drives sux-corpus to full population without a timeout.
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

export type ReindexDomainResult = { indexed: number; note?: string; error?: string };
export type ReindexReport = { index: string; domains: Record<string, ReindexDomainResult>; total: number };

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

/** Populate `sux-corpus` from the existing corpus in ONE synchronous pass per domain — the
 *  admin one-shot / small-domain path. Runs each requested domain independently, capturing
 *  (never throwing) per-domain errors so a partial pass is a valid resumable state. Throws only
 *  when the Vectorize binding is absent (nothing to populate). For the real corpus use the
 *  durable batched backfill (`_backfill.ts`) instead — a full pass here times out (#1315). */
export async function reindexCorpus(env: RtEnv, opts: { domains?: ReindexDomain[] } = {}): Promise<ReindexReport> {
	if (!hasVectorize(env)) throw new Error(`Vectorize binding not bound — cannot reindex ${CORPUS_INDEX}.`);
	const which = opts.domains?.length ? opts.domains.filter((d): d is ReindexDomain => (REINDEX_DOMAINS as string[]).includes(d)) : REINDEX_DOMAINS;
	const domains: Record<string, ReindexDomainResult> = {};
	let total = 0;
	for (const d of which) {
		try {
			const { items, note } = await enumerateDomain(env, d);
			const indexed = await upsertIndexUnits(env, items);
			domains[d] = note ? { indexed, note } : { indexed };
			total += indexed;
		} catch (e) {
			domains[d] = { indexed: 0, error: errMsg(e) };
			console.log(`reindex: domain=${d} failed: ${errMsg(e)}`);
		}
	}
	console.log(`reindex: ${CORPUS_INDEX} total=${total} domains=${which.map((d) => `${d}:${domains[d]?.indexed ?? 0}`).join(",")}`);
	return { index: CORPUS_INDEX, domains, total };
}
