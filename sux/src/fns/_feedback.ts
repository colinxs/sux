// Server-side feedback log for sux — the `issue` / `suggest` functions append
// here (KV), and GET /feedback reads it back. This gives the Worker its OWN
// backlog (independent of Claude's cross-conversation memory), closing the loop
// the Worker itself can act on. Newest-first, capped.
import { keyedSerialize } from "../keyed-serialize";
import { cappedKvLog } from "./_capped_kv_log";
import { redactPII } from "./redact";
import type { RtEnv } from "../registry";

export type FeedbackKind = "issue" | "suggest";
export type FeedbackEntry = { kind: FeedbackKind; text: string; at: number; tool?: string; resolved?: boolean; tracked_by?: string };

const KEY = "sux:feedback";
const CAP = 500;
// Bound any single entry's text so one pasted essay/scrape can't dominate the
// blob's byte budget — feedback is meant to be a short note, not a document.
const MAX_TEXT_CHARS = 4000;

// Serializes appends to the single feedback key within an isolate so two concurrent
// issue()/suggest() calls don't clobber each other's just-appended entry (lost-update
// race). Per-isolate only; a cross-isolate collision still loses one (a DO would not).
const appendChains = new Map<string, Promise<unknown>>();

const log = (env: RtEnv) => cappedKvLog<FeedbackEntry>(env, KEY, CAP);

/** Append an entry (optionally tagged with the tool it's about); returns its 1-based number (total) and timestamp. */
export async function appendFeedback(env: RtEnv, kind: FeedbackKind, text: string, tool?: string): Promise<{ total: number; at: number }> {
	return keyedSerialize(appendChains, KEY, async () => {
		const at = Date.now();
		// GET /feedback is public + unauthenticated, so scrub PII the agent may have
		// relayed from a scrape or vault/mail excerpt before it lands verbatim there.
		const items = await log(env).push({ kind, text: redactPII(text).redacted.slice(0, MAX_TEXT_CHARS), at, ...(tool ? { tool } : {}) });
		return { total: items.length, at };
	});
}

/** Read entries (optionally filtered by kind and/or tool), newest first. `unresolvedOnly`
 *  drops entries a prior `resolveFeedback` call marked resolved — the default GET /feedback
 *  view, so reconciling the log into an external tracker (e.g. GitHub issues) stops leaving
 *  every superseded entry listed forever. Internal callers (e.g. _self_improve.ts's own
 *  cursor-based sweep) leave this false: resolution is a display concern, not a "don't
 *  process this" signal. */
export async function readFeedback(env: RtEnv, kind?: FeedbackKind, limit = 50, tool?: string, opts: { unresolvedOnly?: boolean } = {}): Promise<FeedbackEntry[]> {
	let items = await log(env).load();
	if (kind) items = items.filter((i) => i.kind === kind);
	if (tool) items = items.filter((i) => i.tool === tool);
	if (opts.unresolvedOnly) items = items.filter((i) => !i.resolved);
	return items.slice(0, Math.max(0, limit));
}

/** Mark one entry (addressed by its `kind`+`at`, both echoed by GET /feedback and by
 *  `issue`/`suggest`'s own response) resolved, optionally naming what it's tracked by (e.g.
 *  a GitHub issue URL). Never deletes — GET /feedback's default view just stops listing it.
 *  Returns false when no matching UNresolved entry exists (already resolved, or no such
 *  entry) so a caller can tell a no-op from a real state change. Chains onto the same
 *  per-key `update()` lock `appendFeedback`'s `push` uses (via `cappedKvLog`), so a resolve
 *  racing a concurrent append can't clobber it (#1090's read-modify-write discipline) — and
 *  only returns a NEW array when something actually changed, matching `update()`'s
 *  same-reference-means-no-op contract. */
export async function resolveFeedback(env: RtEnv, kind: FeedbackKind, at: number, tracked_by?: string): Promise<boolean> {
	let found = false;
	await log(env).update((items) => {
		const idx = items.findIndex((i) => i.kind === kind && i.at === at && !i.resolved);
		if (idx === -1) return items;
		found = true;
		const next = [...items];
		next[idx] = { ...next[idx], resolved: true, ...(tracked_by ? { tracked_by } : {}) };
		return next;
	});
	return found;
}
