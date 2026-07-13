// Server-side feedback log for sux — the `issue` / `suggest` functions append
// here (KV), and GET /feedback reads it back. This gives the Worker its OWN
// backlog (independent of Claude's cross-conversation memory), closing the loop
// the Worker itself can act on. Newest-first, capped.
import { keyedSerialize } from "../keyed-serialize";
import { maybeCompressString, maybeDecompressString } from "./_gzip";
import { redactPII } from "./redact";
import type { RtEnv } from "../registry";

export type FeedbackKind = "issue" | "suggest";
export type FeedbackEntry = { kind: FeedbackKind; text: string; at: number; tool?: string };

const KEY = "sux:feedback";
const CAP = 500;

// Serializes appends to the single feedback key within an isolate so two concurrent
// issue()/suggest() calls don't clobber each other's just-appended entry (lost-update
// race). Per-isolate only; a cross-isolate collision still loses one (a DO would not).
const appendChains = new Map<string, Promise<unknown>>();

function safeParse(s: string | null): FeedbackEntry[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

// Read/write the capped log through the transparent gzip store.
async function loadFeedback(env: RtEnv): Promise<FeedbackEntry[]> {
	return safeParse(await maybeDecompressString((await env.OAUTH_KV.get(KEY)) ?? ""));
}

/** Append an entry (optionally tagged with the tool it's about); returns its 1-based number (total) and timestamp. */
export async function appendFeedback(env: RtEnv, kind: FeedbackKind, text: string, tool?: string): Promise<{ total: number; at: number }> {
	return keyedSerialize(appendChains, KEY, async () => {
		const items = await loadFeedback(env);
		const at = Date.now();
		// GET /feedback is public + unauthenticated, so scrub PII the agent may have
		// relayed from a scrape or vault/mail excerpt before it lands verbatim there.
		items.unshift({ kind, text: redactPII(text).redacted, at, ...(tool ? { tool } : {}) });
		if (items.length > CAP) items.length = CAP;
		await env.OAUTH_KV.put(KEY, await maybeCompressString(JSON.stringify(items)));
		return { total: items.length, at };
	});
}

/** Read entries (optionally filtered by kind and/or tool), newest first. */
export async function readFeedback(env: RtEnv, kind?: FeedbackKind, limit = 50, tool?: string): Promise<FeedbackEntry[]> {
	let items = await loadFeedback(env);
	if (kind) items = items.filter((i) => i.kind === kind);
	if (tool) items = items.filter((i) => i.tool === tool);
	return items.slice(0, Math.max(0, limit));
}
