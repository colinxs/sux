// The rung-2 mail-triage classifier: a kNN vote over Colin's OWN past filing decisions,
// dropping in behind _mail_triage.ts's `classify()` seam exactly as that module's header
// says it should ("chunk 03's embeddings/kNN ... can drop in behind the same seam without
// touching the loop"). Zero new Cloudflare resources — the training signal is already
// persisted by _mail_triage_log.ts's TriageEntry log, and the embed+brute-force-cosine-
// over-KV machinery is the same pattern _vault_semantic.ts/_mail_semantic.ts/
// _files_semantic.ts already prove on the existing AI + OAUTH_KV bindings.
//
// Scope is deliberately narrow: this is a CONFIDENCE-BOOSTING tier, not a replacement for
// the rules stub — mirrors classifySpamAmbiguous's best-effort shape (only fires when the
// rules stub falls all the way through to `unknown`), so a wrong kNN vote can never override
// a rule that already fired with a specific label. The rules stub is the cold-start
// fallback: with fewer than MIN_VOTES logged filings to learn from, there's nothing to vote
// on and this seam is a no-op.
import { hasAI } from "../ai";
import type { RtEnv } from "../registry";
import { cosine, decodeEmbedding, embed, encodeEmbedding } from "./_embed";
import { readTriageEntries, type TriageEntry } from "./_mail_triage_log";
import type { Classification, TriageLabel, TriageMsg } from "./_mail_triage";

// Bumped 1 -> 2 for #778: embedText() now folds from/preview into the composite
// instead of embedding subject alone, so cached entries under the old version must
// be invalidated to force a full re-embed with the richer text (#810).
const VERSION = 2;
// Never larger than the training signal itself — _mail_triage_log.ts's log is capped at 500.
const CAP = 500;
const KV_KEY = "sux:mail_triage:semantic";
// Neighbors considered per query, and the minimum agreeing among them before a vote is
// trusted — a 2/5 plurality is too weak a signal to act on; require a real majority.
const K = 5;
const MIN_VOTES = 3;
// Cosine floor below which a "nearest" neighbor isn't a real match — an empty/near-empty
// index (or a genuinely novel subject) must not vote on noise.
const MIN_SCORE = 0.55;

export type TriageSemanticEntry = { id: string; label: TriageLabel; embedding: number[] };
type StoredEntry = Omit<TriageSemanticEntry, "embedding"> & { embedding: string };
type StoredIndex = { version: number; at: number; entries: StoredEntry[] };

function isStoredIndex(v: unknown): v is StoredIndex {
	if (!v || typeof v !== "object") return false;
	const s = v as StoredIndex;
	return typeof s.version === "number" && Array.isArray(s.entries) && s.entries.every((e) => typeof e?.id === "string" && typeof e?.label === "string" && typeof e?.embedding === "string");
}

async function readBlob(env: RtEnv): Promise<StoredIndex | null> {
	const raw = await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.get(KV_KEY).catch(() => null);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return isStoredIndex(parsed) && parsed.version === VERSION ? parsed : null;
	} catch {
		return null;
	}
}
async function writeBlob(env: RtEnv, blob: StoredIndex): Promise<void> {
	try {
		await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.put(KV_KEY, JSON.stringify(blob));
	} catch {
		// Best-effort: a dropped write just means the next call re-embeds the same entries.
	}
}

/** A log entry worth learning from: an actually-applied (not merely suggested) decision, with
 *  subject text to embed and a real (non-"unknown") label — an "unknown" filing is the rules
 *  stub giving up, not a filing decision to imitate. */
function isTrainable(e: TriageEntry): e is TriageEntry & { subject: string } {
	return e.action === "acted" && typeof e.subject === "string" && e.subject.trim().length > 0 && e.label !== "unknown";
}

/** The text actually embedded for a filing: subject alone is ambiguous across senders (two
 *  "Your receipt" subjects from different vendors), so fold in `from`/`preview` when the log
 *  entry has them (older entries pre-dating #777 may not) — a richer composite tightens kNN
 *  precision without changing the embedding model or index shape. */
function embedText(e: { subject: string; from?: string; preview?: string }): string {
	return [e.from, e.subject, e.preview].filter((s) => typeof s === "string" && s.trim().length > 0).join("\n");
}

/** The embedded index of Colin's own past filings — incrementally maintained against the
 *  triage log (only entries missing from the cache, or whose label CHANGED since last
 *  embedded, e.g. after a manual re-file, are re-embedded), bounded to CAP. Returns null when
 *  AI isn't configured or there's no trainable history yet (cold start — the caller falls
 *  back to the rules stub). */
export async function triageSemanticIndex(env: RtEnv): Promise<TriageSemanticEntry[] | null> {
	if (!hasAI(env)) return null;
	const log = await readTriageEntries(env, { limit: CAP });
	const eligible = log.filter(isTrainable);
	if (!eligible.length) return null;
	const cached = await readBlob(env);
	const cachedById = new Map((cached?.entries ?? []).map((e) => [e.id, e]));
	const toEmbed = eligible.filter((e) => cachedById.get(e.id)?.label !== e.label);
	let fresh: StoredEntry[] = [];
	if (toEmbed.length) {
		const vecs = await embed(env, toEmbed.map(embedText));
		fresh = toEmbed.map((e, i) => ({ id: e.id, label: e.label as TriageLabel, embedding: encodeEmbedding(vecs[i] ?? []) }));
	}
	const freshIds = new Set(fresh.map((e) => e.id));
	const eligibleIds = new Set(eligible.map((e) => e.id));
	const keptOld = [...cachedById.values()].filter((e) => eligibleIds.has(e.id) && !freshIds.has(e.id));
	const entries = [...fresh, ...keptOld].slice(0, CAP);
	if (toEmbed.length) await writeBlob(env, { version: VERSION, at: Date.now(), entries });
	return entries.map((e) => ({ id: e.id, label: e.label as TriageLabel, embedding: decodeEmbedding(e.embedding) }));
}

/** classify() seam: vote the message's label from the K nearest past filings by cosine
 *  similarity over a subject+preview+sender embedding. Returns null (never throws) on any
 *  failure, no AI, no/too-little history, or a vote too weak to trust (< MIN_VOTES agreeing, or
 *  every neighbor below MIN_SCORE) — the caller's rules-stub result stands untouched. Confidence
 *  is bounded below classifySpamAmbiguous's floor-confidence tiers so a kNN guess never outranks
 *  a rule that actually fired. */
export async function classifyByHistory(env: RtEnv, msg: TriageMsg): Promise<Classification | null> {
	const subject = String(msg.subject ?? "").trim();
	if (!subject) return null;
	try {
		const index = await triageSemanticIndex(env);
		if (!index || index.length < MIN_VOTES) return null;
		const [qvec] = await embed(env, [embedText({ subject, from: msg.from, preview: msg.preview })]);
		if (!qvec?.length) return null;
		const neighbors = index
			.map((e) => ({ label: e.label, score: cosine(qvec, e.embedding) }))
			.filter((n) => n.score >= MIN_SCORE)
			.sort((a, b) => b.score - a.score)
			.slice(0, K);
		if (neighbors.length < MIN_VOTES) return null;
		const votes = new Map<TriageLabel, number>();
		for (const n of neighbors) votes.set(n.label, (votes.get(n.label) ?? 0) + 1);
		const [topLabel, topCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
		if (topCount < MIN_VOTES) return null;
		const avgScore = neighbors.filter((n) => n.label === topLabel).reduce((s, n) => s + n.score, 0) / topCount;
		return { label: topLabel, confidence: Math.min(0.75, 0.5 + avgScore * 0.3), reason: `learned from ${topCount}/${neighbors.length} similar past filings` };
	} catch {
		// Best-effort, same contract as classifySpamAmbiguous: any embed/KV failure falls back
		// to the rules-stub result rather than blocking classification.
		return null;
	}
}
