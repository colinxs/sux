import type { RtEnv } from "../registry";
import { cosine } from "./_embed";

// The labeled-example store behind the `learn` fn — a KV-backed set of
// {input → label} exemplars, each carrying its own embedding (for brute-force kNN
// classify) and a `batch` tag (the bulk-undo handle: every write records which batch
// it belongs to, so an undo can scan-and-delete exactly that batch's records).
//
// DISTINCT substrate from preferences.ts: that store owns "sux:prefs:" (the distilled
// voice/style profile). This one owns "sux:learn:example:" — a different shape, a
// different key space, no collision. KV has no atomic list-and-delete (same caveat
// ledger.ts documents), so batch-undo scans the prefix then deletes matches one by one.

const PREFIX = "sux:learn:example:";
const keyOf = (id: string) => `${PREFIX}${id}`;

export type Example = {
	id: string;
	input: string;
	label: string;
	source?: string;
	/** bge embedding of `input`; absent only if it was stored before AI was configured. */
	embedding?: number[];
	/** the bulk-undo handle — records deleted together via undo(batch). */
	batch: string;
	ts: number;
};

/** Random id/batch handle (no crypto dependence — collision within KV prefix is astronomically unlikely). */
export function newId(): string {
	return crypto.randomUUID();
}

export async function putExample(env: RtEnv, ex: Example): Promise<void> {
	await env.OAUTH_KV?.put(keyOf(ex.id), JSON.stringify(ex));
}

export async function getExample(env: RtEnv, id: string): Promise<Example | null> {
	const raw = await env.OAUTH_KV?.get(keyOf(id));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Example;
	} catch {
		return null;
	}
}

/** Load every stored example, paginating KV list() (caps at 1000 keys/page). Brute-force kNN
 *  scans this whole set — the linear cost that would eventually trigger Vectorize (deferred). */
export async function listExamples(env: RtEnv): Promise<Example[]> {
	const kv = env.OAUTH_KV;
	if (!kv) return [];
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, cursor });
		for (const k of page.keys) ids.push(k.name.slice(PREFIX.length));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	const out: Example[] = [];
	for (const id of ids) {
		const ex = await getExample(env, id);
		if (ex) out.push(ex);
	}
	out.sort((a, b) => a.ts - b.ts);
	return out;
}

export async function deleteExample(env: RtEnv, id: string): Promise<void> {
	await env.OAUTH_KV?.delete(keyOf(id));
}

/** Delete exactly the records tagged `batch` — the bulk-undo. Returns how many were removed.
 *  Non-atomic (scan then delete), same acceptable race ledger.ts documents. */
export async function deleteBatch(env: RtEnv, batch: string): Promise<number> {
	const all = await listExamples(env);
	let n = 0;
	for (const ex of all) {
		if (ex.batch === batch) {
			await deleteExample(env, ex.id);
			n++;
		}
	}
	return n;
}

/** Delete the whole learned set. Returns how many were removed. */
export async function clearExamples(env: RtEnv): Promise<number> {
	const all = await listExamples(env);
	for (const ex of all) await deleteExample(env, ex.id);
	return all.length;
}

export type Neighbor = { id: string; label: string; input: string; score: number };
export type Verdict = { label: string | null; confidence: number; neighbors: Neighbor[] };

/** Brute-force kNN over the labeled set: cosine-rank against `queryVec`, take the top-k, and
 *  vote the label by summed similarity. confidence = the nearest neighbor's cosine. Empty set
 *  (or no embedded examples) → {label:null, confidence:0, neighbors:[]} — a verdict, never a throw. */
export function classifyKnn(queryVec: number[], examples: Example[], k = 3): Verdict {
	const scored: Neighbor[] = examples
		.filter((e) => Array.isArray(e.embedding) && e.embedding.length > 0)
		.map((e) => ({ id: e.id, label: e.label, input: e.input, score: cosine(queryVec, e.embedding!) }))
		.sort((a, b) => b.score - a.score);
	if (!scored.length) return { label: null, confidence: 0, neighbors: [] };
	const top = scored.slice(0, Math.max(1, k));
	const votes = new Map<string, number>();
	for (const t of top) votes.set(t.label, (votes.get(t.label) ?? 0) + Math.max(0, t.score));
	const label = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? top[0].label;
	return { label, confidence: top[0].score, neighbors: top };
}
