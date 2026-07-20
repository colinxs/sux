import { aiGatewayOptions, hasAI, MODELS } from "../ai";
import type { RtEnv } from "../registry";

// Workers-AI embeddings, wrapped the same way ai.ts wraps text inference: a hard
// hasAI(env) guard that throws the SAME "binding not configured" message shape, so a
// caller's not_configured branch reads identically whether it hit llm() or embed().
// The bge-base-en-v1.5 model (MODELS.embed) supports BATCHED input — pass every text
// in one AI.run call so N examples cost one round-trip, not N (the chunk's bound-cost
// note). Output shape is { shape:[n,768], data:number[][] }. Cloudflare caps a single
// call at 100 texts, so callers with an unbounded input (advise.ts's ingest chunking
// a long source) get sliced into EMBED_BATCH-sized calls here rather than each caller
// re-deriving the same batching loop (or worse, blowing past the cap).
const EMBED_BATCH = 100;

async function embedBatch(env: RtEnv, texts: string[]): Promise<number[][]> {
	const r = await env.AI!.run(MODELS.embed, { text: texts }, aiGatewayOptions(env));
	const data = (r as { data?: unknown })?.data;
	if (!Array.isArray(data)) throw new Error("embeddings: unexpected model output (no data array).");
	return (data as unknown[]).map((v) => (Array.isArray(v) ? v.map(Number) : []));
}

export async function embed(env: RtEnv, texts: string[]): Promise<number[][]> {
	if (!hasAI(env)) throw new Error('Workers AI binding not configured (add "ai": { "binding": "AI" } to wrangler) — needed to embed.');
	if (!texts.length) return [];
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await embedBatch(env, texts.slice(i, i + EMBED_BATCH))));
	return out;
}

/** Embed a single text — convenience over embed([text]). */
export async function embedOne(env: RtEnv, text: string): Promise<number[]> {
	return (await embed(env, [text]))[0] ?? [];
}

/** Pack an embedding as base64-encoded Float32 bytes — ~4x smaller than JSON's full-precision
 *  doubles (~19 chars/number) and the storage format the vault semantic index persists, since
 *  bge-base-en-v1.5's 768-dim vectors dominate that blob's size (see #717). Precision loss
 *  (float64 -> float32) is negligible for cosine ranking. */
export function encodeEmbedding(vec: number[]): string {
	const bytes = new Uint8Array(new Float32Array(vec).buffer);
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s);
}

/** Inverse of encodeEmbedding. */
export function decodeEmbedding(b64: string): number[] {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return Array.from(new Float32Array(bytes.buffer));
}

/** Cosine similarity of two equal-length vectors; 0 when either is empty or a zero vector. */
export function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	if (!n) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
