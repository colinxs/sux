import { type RtEnv } from "./registry";

// Stage-then-commit — the accidental-misuse guard for every side-effectful verb. A caller
// passes stage:true to get back { preview, commit_token } WITHOUT mutating; a second call
// passing that token commits, iff the token is unspent, unexpired (5-min TTL), and the exact
// payload still hashes to what was staged. The token binds to the payload so a stale preview
// can't commit a changed action. This is a two-STEP guard (mint then spend are separate tool
// calls), NOT an injection boundary — a read-only credential is the real containment.

const PREFIX = "sux:stage:";
const TTL_SECONDS = 300;

async function hashPayload(payload: unknown): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload ?? null)));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randToken(): string {
	const a = new Uint8Array(18);
	crypto.getRandomValues(a);
	return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type StageResult = { staged: true; kind: string; preview: unknown; commit_token: string; expires_in: number; note: string };

/** Mint a commit token bound to `payload` and return the preview. Performs NO mutation. */
export async function stage(env: RtEnv, kind: string, payload: unknown, preview: unknown): Promise<StageResult> {
	const token = randToken();
	const hash = await hashPayload(payload);
	await env.OAUTH_KV?.put(`${PREFIX}${token}`, JSON.stringify({ kind, hash }), { expirationTtl: TTL_SECONDS });
	return { staged: true, kind, preview, commit_token: token, expires_in: TTL_SECONDS, note: `Nothing done yet. Re-call the same verb with commit_token:'${token}' (+ the identical payload) within 5 min to commit.` };
}

/** Verify + consume a commit token against `payload`. Throws a clear reason on any mismatch; single-use. */
export async function commit(env: RtEnv, kind: string, token: string, payload: unknown): Promise<void> {
	const raw = await env.OAUTH_KV?.get(`${PREFIX}${token}`);
	if (!raw) throw new Error("commit_token is invalid, already spent, or expired (5-min TTL) — re-stage to get a fresh preview.");
	let rec: { kind?: string; hash?: string };
	try {
		rec = JSON.parse(raw);
	} catch {
		rec = {};
	}
	if (rec.kind !== kind) throw new Error(`commit_token was staged for '${rec.kind}', not '${kind}'.`);
	if (rec.hash !== (await hashPayload(payload))) throw new Error("the payload changed since staging — the commit_token is bound to the exact previewed action. Re-stage.");
	await env.OAUTH_KV?.delete(`${PREFIX}${token}`).catch(() => {});
}

/**
 * The stage/commit dispatch every side-effectful verb wraps its mutation in:
 *   - stage:true          → returns the preview + a commit_token (no mutation)
 *   - commit_token present → verifies+consumes it, then runs `mutate()`
 *   - neither             → runs `mutate()` directly (unguarded, the caller opted out)
 * Returns null in the stage case (the caller should return the StageResult) — else the mutate result.
 */
export async function staged<T>(env: RtEnv, kind: string, args: { stage?: boolean; commit_token?: string }, payload: unknown, preview: unknown, mutate: () => Promise<T>): Promise<{ stageResult: StageResult } | { result: T }> {
	if (args?.commit_token) {
		await commit(env, kind, String(args.commit_token), payload);
		return { result: await mutate() };
	}
	if (args?.stage === true) {
		return { stageResult: await stage(env, kind, payload, preview) };
	}
	return { result: await mutate() };
}
