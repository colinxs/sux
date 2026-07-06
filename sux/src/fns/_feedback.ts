// Server-side feedback log for sux — the `issue` / `suggest` functions append
// here (KV), and GET /feedback reads it back. This gives the Worker its OWN
// backlog (independent of Claude's cross-conversation memory), closing the loop
// the Worker itself can act on. Newest-first, capped.
import type { RtEnv } from "../registry";

export type FeedbackKind = "issue" | "suggest";
export type FeedbackEntry = { kind: FeedbackKind; text: string; at: number; tool?: string };

const KEY = "sux:feedback";
const CAP = 500;

function safeParse(s: string | null): FeedbackEntry[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

/** Append an entry (optionally tagged with the tool it's about); returns its 1-based number (total) and timestamp. */
export async function appendFeedback(env: RtEnv, kind: FeedbackKind, text: string, tool?: string): Promise<{ total: number; at: number }> {
	const items = safeParse(await env.OAUTH_KV.get(KEY));
	const at = Date.now();
	items.unshift({ kind, text, at, ...(tool ? { tool } : {}) });
	if (items.length > CAP) items.length = CAP;
	await env.OAUTH_KV.put(KEY, JSON.stringify(items));
	return { total: items.length, at };
}

/** Read entries (optionally filtered by kind and/or tool), newest first. */
export async function readFeedback(env: RtEnv, kind?: FeedbackKind, limit = 50, tool?: string): Promise<FeedbackEntry[]> {
	let items = safeParse(await env.OAUTH_KV.get(KEY));
	if (kind) items = items.filter((i) => i.kind === kind);
	if (tool) items = items.filter((i) => i.tool === tool);
	return items.slice(0, Math.max(0, limit));
}
