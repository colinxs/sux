import type { RtEnv } from "../registry";
import { KV_KEY as CONTACT_KEY } from "./_contact_semantic";
import { KV_KEY as FILES_KEY } from "./_files_semantic";
import { maybeDecompressString } from "./_gzip";
import { KV_KEY as MAIL_KEY } from "./_mail_semantic";
import { KV_BLOB_CEILING_BYTES, KV_CHUNK_CEILING, KV_CHUNK_WARN, nearCeiling, type SourceDomainStat, sourceStats } from "./_source";
import { gitSemanticIndexKey, vaultCfg } from "./obsidian";

// _retrieval_stats — the KV-bet observability readout (v5 W5, #1278). ONE per-domain view over
// every retrieval store the KV-brute-force bet spans. The unified Vectorize read index has since
// LANDED (sux#1290/#1311), but KV stays the source of truth and the per-domain KV cosine cores are
// RETAINED as the parity-first fallback (shed only after the sux#1308 soak) — so this dashboard
// tracks each core's fill, catching a domain nearing the cap before its fallback is stripped. NOT a
// verb: an internal module surfaced through the existing `oracle {action:"status"}` dashboard — no
// new deployable fn, no new store, no behavior change to retrieval.
//
// Two storage models, one unified stat + one shared ceiling (arc doc §2.2/§2.3):
//   • chunk_keyspace  — the _source substrate (assim:<stream> / phi:medical / oracle:<topic> /
//     bare advise domains): one KV key per chunk. sourceStats totals each domain from list()
//     metadata (cheap — no value GETs). These are the domains W2's spine (#1283) grows.
//   • packed_index    — the vault/mail/files/contacts semantic indices: ONE packed KV blob per
//     domain (the 25MiB value cap applies directly). Read here cached-only, top-level parse
//     (never decoding the per-chunk embeddings that are the blob's bulk).
//
// A cold/absent/unreadable index degrades to zeros + a note (never an error), so an empty domain
// reports cleanly. All numbers are read-only observation — this module never writes.

/** One retrieval domain's KV-bet health. `near_ceiling` flags a KV core nearing the cap (arc doc
 *  §2.3 (a)); `note` explains any zeros (cold index / partial metering). */
export type RetrievalDomainStat = {
	domain: string;
	store: "packed_index" | "chunk_keyspace";
	chunk_count: number;
	blob_size_bytes: number;
	indexed_at: number | null;
	near_ceiling: boolean;
	note?: string;
};

export type RetrievalStats = {
	/** The shared KV-bet ceiling every domain is measured against (arc doc §2.2/§2.3). */
	ceiling: { chunks: number; warn_at_chunks: number; blob_size_bytes: number; note: string };
	domains: RetrievalDomainStat[];
	/** Domains at/over the warn line — the at-a-glance "approaching the ceiling" flag (a threshold
	 *  marker for shedding the KV fallback safely, not a pager). */
	alerts: string[];
};

/** Stat one packed semantic index from its single KV blob: exact stored size (bytes) + top-level
 *  chunk count + freshness, without decoding the embeddings that dominate the blob. */
async function packedStat(env: RtEnv, domain: string, key: string | null): Promise<RetrievalDomainStat> {
	const base = { domain, store: "packed_index" as const, chunk_count: 0, blob_size_bytes: 0, indexed_at: null as number | null, near_ceiling: false };
	const kv = env.OAUTH_KV;
	if (!kv || !key) return { ...base, note: "not configured" };
	let raw: string | null;
	try {
		raw = (await kv.get(key)) as string | null;
	} catch {
		return { ...base, note: "index unreadable" };
	}
	if (!raw) return { ...base, note: "cold — no index built yet" };
	// The stored value IS the packed blob measured against KV's 25MiB cap — an ASCII/text string
	// (plain JSON for mail/files/contacts; a gzip+base64 blob for a large vault index), so its
	// UTF-8 byte length is the true stored size.
	const blob_size_bytes = new TextEncoder().encode(raw).length;
	try {
		const parsed = JSON.parse(await maybeDecompressString(raw)) as { at?: unknown; chunks?: unknown };
		const chunk_count = Array.isArray(parsed.chunks) ? parsed.chunks.length : 0;
		const indexed_at = typeof parsed.at === "number" ? parsed.at : null;
		return { domain, store: "packed_index", chunk_count, blob_size_bytes, indexed_at, near_ceiling: nearCeiling(chunk_count, blob_size_bytes) };
	} catch {
		return { ...base, blob_size_bytes, near_ceiling: nearCeiling(0, blob_size_bytes), note: "index unparseable — size only" };
	}
}

/** The four packed-index domains and their KV keys (vault's is repo/branch-scoped; the rest are
 *  fixed). A domain with no key (vault unconfigured, or config resolution hiccuping) reports
 *  "not configured" rather than throwing — observability degrades, never fails the status call. */
function packedDomains(env: RtEnv): { domain: string; key: string | null }[] {
	let vaultKey: string | null = null;
	try {
		const cfg = vaultCfg(env);
		vaultKey = "error" in cfg ? null : gitSemanticIndexKey(cfg);
	} catch {
		vaultKey = null;
	}
	return [
		{ domain: "vault", key: vaultKey },
		{ domain: "mail", key: MAIL_KEY },
		{ domain: "files", key: FILES_KEY },
		{ domain: "contacts", key: CONTACT_KEY },
	];
}

/** The whole KV-bet readout: every retrieval domain's chunk_count + blob_size_bytes + indexed_at,
 *  each flagged near_ceiling against the shared ~4.5k-chunk / 25MiB bound, plus the list of domains
 *  approaching it. Read-only; degrades a cold/unconfigured domain to zeros + a note, never an error. */
export async function retrievalStats(env: RtEnv): Promise<RetrievalStats> {
	const defs = packedDomains(env);
	const [packed, source] = await Promise.all([
		// packedStat swallows its own read/parse failures; sourceStats degrades to [] on a KV
		// hiccup — a broken stat gatherer must never fail the oracle status readout it rides in.
		Promise.all(defs.map((p) => packedStat(env, p.domain, p.key))),
		sourceStats(env).catch(() => [] as SourceDomainStat[]),
	]);
	const substrate = source.map(
		(s: SourceDomainStat): RetrievalDomainStat => ({
			domain: s.domain,
			store: "chunk_keyspace",
			chunk_count: s.chunk_count,
			blob_size_bytes: s.blob_size_bytes,
			indexed_at: s.indexed_at,
			near_ceiling: s.near_ceiling,
			...(s.metered_chunks < s.chunk_count
				? { note: `blob_size/indexed_at cover ${s.metered_chunks}/${s.chunk_count} chunks (rest predate metering; self-heal on re-index)` }
				: {}),
		}),
	);
	const domains = [...packed, ...substrate];
	return {
		ceiling: {
			chunks: KV_CHUNK_CEILING,
			warn_at_chunks: KV_CHUNK_WARN,
			blob_size_bytes: KV_BLOB_CEILING_BYTES,
			note: "KV brute-force cosine ceiling (25MiB packed-blob cap ≈ 4.5k chunks/domain, v5 arc §2.2/§2.3). Vectorize is now the read path (sux#1290/#1311); a near_ceiling domain's retained KV cosine core is nearing the cap — confirm its Vectorize coverage before the fallback is stripped (sux#1308).",
		},
		domains,
		alerts: domains.filter((d) => d.near_ceiling).map((d) => d.domain),
	};
}
