// The mail-triage action + undo log — a KV-backed record of every move the triage
// bot made (and every suggestion it declined to act on), so a whole cycle can be
// reversed with one call. Mirrors _feedback.ts's persistence idiom (one JSON array
// under a single KV key, newest-first, hard-capped) rather than inventing a second
// store — but carries enough per-entry data (message id, origin + target mailbox,
// cycle id) to REVERSE each move, which a feedback entry never needs.
import type { RtEnv } from "../registry";
import { errMsg } from "./_util";

export type TriageAction = "acted" | "suggested";

/** The reversible op an entry records — the auto-act allow-list, on the storage side. Move ops
 *  (archive/unarchive/undelete) carry `from_mailbox`/`to_mailbox`; `label` carries `keyword`. */
export type TriageOpKind = "archive" | "unarchive" | "undelete" | "label";

/** One logged decision. On an "acted" entry the op fields are the UNDO coordinates: a move
 *  records origin+target mailbox (undo moves back to origin), a label records the keyword (undo
 *  removes it). A suggestion records the intended op for context but is never reversed. */
export type TriageEntry = {
	cycle: string;
	id: string; // message id
	action: TriageAction;
	label: string;
	confidence: number;
	reason: string;
	subject?: string;
	op?: TriageOpKind;
	from_mailbox?: string;
	to_mailbox?: string;
	keyword?: string;
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
export type Labeler = (env: RtEnv, ids: string[], keyword: string, add: boolean) => Promise<void>;
/** The two reversers bulkUndo needs — the inverse of each auto-act op kind. Injected in tests. */
export type Reversers = { move?: Mover; label?: Labeler };

/** The default reversers: move back via moveMessages, un-label via labelMessages. Dynamically
 *  imported so this module (and its tests) never statically pull in the whole mail surface. */
const defaultMover: Mover = async (env, ids, target) => {
	const mail = await import("../mail-mcp");
	const r = await mail.moveMessages(env, ids, target);
	if (r.isError) throw new Error(r.content?.[0]?.text ?? "move failed");
};
const defaultLabeler: Labeler = async (env, ids, keyword, add) => {
	const mail = await import("../mail-mcp");
	const r = await mail.labelMessages(env, ids, keyword, add);
	if (r.isError) throw new Error(r.content?.[0]?.text ?? "label failed");
};

/** Reverse every still-applied "acted" action in a cycle: move ops go back to their origin
 *  mailbox (archive→inbox = unarchive, a trashed message→inbox = undelete), label ops have the
 *  keyword removed (label-add→label-remove). Idempotent: an entry already marked `undone` is
 *  skipped, so a second call is a safe no-op. Batches by origin mailbox / keyword to minimize
 *  JMAP calls. Each op is reversed by its allow-listed inverse — never by delete. */
export async function bulkUndo(env: RtEnv, cycle: string, reversers: Reversers = {}): Promise<Record<string, unknown>> {
	const move = reversers.move ?? defaultMover;
	const label = reversers.label ?? defaultLabeler;
	const items = safeParse(await env.OAUTH_KV.get(KEY));
	const acted = items.filter((i) => i.cycle === cycle && i.action === "acted" && !i.undone);
	const moves = acted.filter((i) => i.op !== "label" && i.from_mailbox);
	const labels = acted.filter((i) => i.op === "label" && i.keyword);
	if (!moves.length && !labels.length) return { cycle, undone: 0, note: "nothing to undo for this cycle (no applied actions, or already undone)." };
	const reversed = new Set<string>();
	const errors: Array<Record<string, unknown>> = [];
	const byBox = new Map<string, string[]>();
	for (const e of moves) (byBox.get(e.from_mailbox as string) ?? byBox.set(e.from_mailbox as string, []).get(e.from_mailbox as string)!).push(e.id);
	for (const [box, ids] of byBox) {
		try {
			await move(env, ids, box);
			for (const id of ids) reversed.add(id);
		} catch (e) {
			errors.push({ mailbox: box, ids, error: errMsg(e) });
		}
	}
	const byKeyword = new Map<string, string[]>();
	for (const e of labels) (byKeyword.get(e.keyword as string) ?? byKeyword.set(e.keyword as string, []).get(e.keyword as string)!).push(e.id);
	for (const [keyword, ids] of byKeyword) {
		try {
			await label(env, ids, keyword, false);
			for (const id of ids) reversed.add(id);
		} catch (e) {
			errors.push({ keyword, ids, error: errMsg(e) });
		}
	}
	for (const i of items) if (i.cycle === cycle && i.action === "acted" && reversed.has(i.id)) i.undone = true;
	await env.OAUTH_KV.put(KEY, JSON.stringify(items));
	return { cycle, undone: reversed.size, ids: [...reversed], ...(errors.length ? { errors } : {}) };
}
