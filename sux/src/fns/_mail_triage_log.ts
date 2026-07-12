// The mail-triage action + undo log — a KV-backed record of every move the triage
// bot made (and every suggestion it declined to act on), so a whole cycle can be
// reversed with one call. Mirrors _feedback.ts's persistence idiom (one JSON array
// under a single KV key, newest-first, hard-capped) rather than inventing a second
// store — but carries enough per-entry data (message id, origin + target mailbox,
// cycle id) to REVERSE each move, which a feedback entry never needs.
import type { RtEnv } from "../registry";
import { errMsg } from "./_util";

export type TriageAction = "acted" | "suggested";

/** One logged decision. `from_mailbox`/`to_mailbox` are only set on an "acted" move
 *  (they are the undo coordinates); a suggestion records the intended target for context. */
export type TriageEntry = {
	cycle: string;
	id: string; // message id
	action: TriageAction;
	label: string;
	confidence: number;
	reason: string;
	subject?: string;
	from_mailbox?: string;
	to_mailbox?: string;
	at: number;
	undone?: boolean;
};

const KEY = "sux:mail_triage:log";
const CAP = 500;

function safeParse(s: string | null): TriageEntry[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

/** Prepend a batch of entries (newest-first), capped. Returns the new total. */
export async function appendTriageEntries(env: RtEnv, entries: TriageEntry[]): Promise<number> {
	if (!entries.length) return 0;
	const items = safeParse(await env.OAUTH_KV.get(KEY));
	// Prepend newest-first: reverse so the last-processed message ends up first.
	items.unshift(...[...entries].reverse());
	if (items.length > CAP) items.length = CAP;
	await env.OAUTH_KV.put(KEY, JSON.stringify(items));
	return items.length;
}

/** Read entries, optionally filtered to one cycle, newest-first. */
export async function readTriageEntries(env: RtEnv, opts?: { cycle?: string; limit?: number }): Promise<TriageEntry[]> {
	let items = safeParse(await env.OAUTH_KV.get(KEY));
	if (opts?.cycle) items = items.filter((i) => i.cycle === opts.cycle);
	return items.slice(0, Math.max(0, opts?.limit ?? 100));
}

export type Mover = (env: RtEnv, ids: string[], target: string) => Promise<void>;

/** The default mover: reverse a move via mail-mcp's moveMessages. Dynamically imported
 *  so this module (and its tests) never statically pull in the whole mail surface. */
const defaultMover: Mover = async (env, ids, target) => {
	const mail = await import("../mail-mcp");
	const r = await mail.moveMessages(env, ids, target);
	if (r.isError) throw new Error(r.content?.[0]?.text ?? "move failed");
};

/** Reverse every still-applied "acted" move in a cycle (move each message back to its
 *  origin mailbox). Idempotent: an entry already marked `undone` is skipped, so a second
 *  call is a safe no-op. Groups by origin mailbox to move in as few JMAP calls as possible. */
export async function bulkUndo(env: RtEnv, cycle: string, mover: Mover = defaultMover): Promise<Record<string, unknown>> {
	const items = safeParse(await env.OAUTH_KV.get(KEY));
	const toUndo = items.filter((i) => i.cycle === cycle && i.action === "acted" && !i.undone && i.from_mailbox);
	if (!toUndo.length) return { cycle, undone: 0, note: "nothing to undo for this cycle (no applied moves, or already undone)." };
	const byBox = new Map<string, string[]>();
	for (const e of toUndo) {
		const box = e.from_mailbox as string;
		(byBox.get(box) ?? byBox.set(box, []).get(box)!).push(e.id);
	}
	const reversed: string[] = [];
	const errors: Array<Record<string, unknown>> = [];
	for (const [box, ids] of byBox) {
		try {
			await mover(env, ids, box);
			reversed.push(...ids);
		} catch (e) {
			errors.push({ mailbox: box, ids, error: errMsg(e) });
		}
	}
	const rset = new Set(reversed);
	for (const i of items) if (i.cycle === cycle && i.action === "acted" && rset.has(i.id)) i.undone = true;
	await env.OAUTH_KV.put(KEY, JSON.stringify(items));
	return { cycle, undone: reversed.length, ids: reversed, ...(errors.length ? { errors } : {}) };
}
