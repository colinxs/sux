// One capped, gzip-compressed rolling log stored as a single JSON array under one
// KV key — the persistence idiom shared by the feedback log, the mail-triage
// action/undo log, and the self-improve findings log. Each is "newest-first,
// hard-capped array of T, read/written through the transparent gzip store"; this
// centralizes the parse + decompress + cap + compress plumbing so those modules
// only own their element type, key, and cap (and any domain-specific ordering).
import { maybeCompressString, maybeDecompressString } from "./_gzip";
import { keyedSerialize } from "../keyed-serialize";
import type { RtEnv } from "../registry";

// A stored blob is only ever a JSON array we wrote; anything else (missing key,
// corruption, a non-array) reads back as empty rather than throwing.
function safeParse<T>(s: string | null): T[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? (v as T[]) : [];
	} catch {
		return [];
	}
}

export type CappedKvLog<T> = {
	/** The whole array, newest-first, or empty. */
	load(): Promise<T[]>;
	/** Rewrite the whole array (capped to `cap` before write). */
	save(items: T[]): Promise<void>;
	/** Prepend entries (in the order given), cap, and persist; returns the new array. */
	push(...entries: T[]): Promise<T[]>;
	/** Serialized read-modify-write, chained onto the same per-key lock `push` uses: `mutate`
	 *  runs against a fresh `load()`, and its return is persisted unless it's the exact same
	 *  array reference it was given (a no-op signal, skipping the write). Use this for any
	 *  delete/purge so it can't clobber a concurrent push's just-appended entry with a stale
	 *  snapshot (#1090). */
	update(mutate: (items: T[]) => T[] | Promise<T[]>): Promise<T[]>;
};

// KV values cap at 25MB; stay well under that so one blob of large entries can't
// push a `put` over the limit and start throwing on every subsequent append.
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

// push()/update() are load-then-save read-modify-writes with no CAS; two concurrent
// writers on the same key (e.g. a cron tick overlapping a webhook-triggered tick, or a
// delete racing an append) would otherwise have the later save silently clobber the
// earlier one's write. Keying this per-isolate serialization map on the KV key (not
// per-log-instance) means every push()/update() on the same key — across however many
// cappedKvLog(...) call sites reference it — chains onto the same tail, matching the fix
// keyed-serialize.ts already applies by hand in _feedback.ts / _mail_triage_log.ts, but as
// a default every caller gets.
const pushChains = new Map<string, Promise<unknown>>();

export function cappedKvLog<T>(env: RtEnv, key: string, cap: number): CappedKvLog<T> {
	const load = async (): Promise<T[]> => safeParse<T>(await maybeDecompressString((await env.OAUTH_KV.get(key)) ?? ""));
	const save = async (items: T[]): Promise<void> => {
		if (items.length > cap) items.length = cap;
		while (items.length > 1 && new TextEncoder().encode(JSON.stringify(items)).length > MAX_TOTAL_BYTES) items.length--;
		await env.OAUTH_KV.put(key, await maybeCompressString(JSON.stringify(items)));
	};
	const update = (mutate: (items: T[]) => T[] | Promise<T[]>): Promise<T[]> =>
		keyedSerialize(pushChains, key, async () => {
			const items = await load();
			const next = await mutate(items);
			if (next !== items) await save(next);
			return next;
		});
	const push = (...entries: T[]): Promise<T[]> => update((items) => [...entries, ...items]);
	return { load, save, push, update };
}
