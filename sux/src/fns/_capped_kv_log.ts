// One capped, gzip-compressed rolling log stored as a single JSON array under one
// KV key — the persistence idiom shared by the feedback log, the mail-triage
// action/undo log, and the self-improve findings log. Each is "newest-first,
// hard-capped array of T, read/written through the transparent gzip store"; this
// centralizes the parse + decompress + cap + compress plumbing so those modules
// only own their element type, key, and cap (and any domain-specific ordering).
import { maybeCompressString, maybeDecompressString } from "./_gzip";
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
};

// KV values cap at 25MB; stay well under that so one blob of large entries can't
// push a `put` over the limit and start throwing on every subsequent append.
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function cappedKvLog<T>(env: RtEnv, key: string, cap: number): CappedKvLog<T> {
	const load = async (): Promise<T[]> => safeParse<T>(await maybeDecompressString((await env.OAUTH_KV.get(key)) ?? ""));
	const save = async (items: T[]): Promise<void> => {
		if (items.length > cap) items.length = cap;
		while (items.length > 1 && new TextEncoder().encode(JSON.stringify(items)).length > MAX_TOTAL_BYTES) items.length--;
		await env.OAUTH_KV.put(key, await maybeCompressString(JSON.stringify(items)));
	};
	const push = async (...entries: T[]): Promise<T[]> => {
		const items = await load();
		items.unshift(...entries);
		await save(items);
		return items;
	};
	return { load, save, push };
}
