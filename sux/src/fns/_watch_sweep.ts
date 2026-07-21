// The watch directory's cron sweep (#899) — the missing proactive half of `watch.ts`.
// `watch` itself only checks a page when explicitly called; this walks the directory
// index it now maintains (watch.ts's sux:watch:index, upserted on first_seen/change,
// pruned on reset:true) and re-checks a bounded slice of it each cron tick, so "did this
// page change" stops requiring a manual re-call. Detection only — it never acts on a
// change itself; `_agenda.ts`'s detectWatchDrops (W2) turns a changed watch into the same
// reversible Todoist-proposal + digest loop every other sense already feeds.
//
// SAFETY (fail-closed): WATCH_SWEEP_ENABLED unset ⇒ total no-op (dormant). Read-only
// against every watched page except for the SAME hash-store write `watch` itself already
// does on a real change; the sweep records no other state of its own beyond a rotating
// cursor + a bounded findings cache for the agenda loop to read.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { errMsg } from "./_util";
import { sweepWindow } from "./_consolidate";
import type { WatchIndexEntry } from "./watch";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The sweep may run at all. Unset ⇒ the feature is dormant (no-op). */
export const hasWatchSweep = (env: RtEnv): boolean => flagOn(env.WATCH_SWEEP_ENABLED);

/** Bounds how many watches get re-fetched (through the residential proxy) per cron tick —
 *  a directory with more entries than this is covered over several ticks via the rotating
 *  cursor below, same shape as _consolidate's note sweep. */
export const DEFAULT_MAX_PER_SWEEP = 10;

/** WATCH_SWEEP_MAX override, clamped to [1,50]; falls back to DEFAULT_MAX_PER_SWEEP on an
 *  unset/invalid value. */
export function maxPerSweep(env: RtEnv): number {
	const n = Number(env.WATCH_SWEEP_MAX);
	return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : DEFAULT_MAX_PER_SWEEP;
}

/** The ledger key holding the rotating sweep cursor (an index into the directory's order)
 *  — mirrors _consolidate's CURSOR_KEY so a directory bigger than one sweep's cap still
 *  gets fully covered over time instead of the same leading slice forever. */
const CURSOR_KEY = "sweep-offset";

/** The ledger key holding the most recent sweep's findings (bounded), so a read-only
 *  consumer (the agenda loop, #899) can pick them up without re-checking every page. */
const LAST_REPORT_KEY = "last-report";

/** Caps how many changed entries the cached last-report carries — enough for a digest,
 *  not an unbounded log (mirrors _consolidate's MAX_CACHED_FINDINGS). */
const MAX_CACHED_CHANGES = 20;

export type WatchChange = {
	url: string;
	selector?: string;
	label?: string;
	hash: string;
	previous_hash?: string;
	numeric_value?: number;
	previous_numeric_value?: number;
	checked_at: string;
};

export type WatchFindings = { checked_at: string; changed: WatchChange[]; changed_count: number };

/** The most recent sweep's findings (bounded to MAX_CACHED_CHANGES), read from the ledger
 *  cache — never re-checks any page. Returns null if the sweep has never completed a tick
 *  (dormant, KV unavailable, or a corrupt/missing cache entry). */
export async function lastWatchFindings(env: RtEnv): Promise<WatchFindings | null> {
	const raw = await ledger(env, "watch_sweep").get(LAST_REPORT_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.checked_at !== "string") return null;
		const changed = Array.isArray(parsed.changed) ? parsed.changed : [];
		return { checked_at: parsed.checked_at, changed, changed_count: typeof parsed.changed_count === "number" ? parsed.changed_count : changed.length };
	} catch {
		return null;
	}
}

export type WatchCheckResult = {
	changed: boolean;
	first_seen: boolean;
	hash: string;
	previous_hash?: string;
	numeric_value?: number;
	previous_numeric_value?: number;
};

export type WatchSweepDeps = {
	listWatches: (env: RtEnv) => Promise<WatchIndexEntry[]>;
	checkWatch: (env: RtEnv, entry: { url: string; selector?: string; label?: string; threshold?: number; thresholdPct?: number }) => Promise<WatchCheckResult>;
};

export type WatchSweepReport = {
	dormant?: boolean;
	checked?: number;
	total_watches?: number;
	window_offset?: number;
	next_offset?: number;
	changed?: WatchChange[];
	note?: string;
	error?: string;
};

/** Run one sweep tick. Fail-closed: dormant no-op unless WATCH_SWEEP_ENABLED. Re-checks a
 *  bounded, rotating slice of the directory (each entry via `watch` itself, so the same
 *  fetch-ladder/hash/store logic applies — see checkWatch in defaultDeps), and caches
 *  whichever changed for the agenda loop to pick up. One unreachable watch is skipped, not
 *  fatal to the rest of the tick. */
export async function runWatchSweep(env: RtEnv, opts: { max?: number }, deps: WatchSweepDeps): Promise<WatchSweepReport> {
	if (!hasWatchSweep(env)) {
		return { dormant: true, note: "watch sweep is disabled — set WATCH_SWEEP_ENABLED to have the daily cron re-check active `watch` pages and surface changes through the agenda digest. Fail-closed: nothing runs until the flag is set." };
	}

	let entries: WatchIndexEntry[];
	try {
		entries = await deps.listWatches(env);
	} catch (e) {
		const msg = `watch index read failed: ${errMsg(e)}`;
		return { error: msg, note: msg };
	}
	if (!entries.length) return { checked: 0, total_watches: 0, changed: [], note: "no active watches" };

	const led = ledger(env, "watch_sweep");
	const size = Math.max(1, Math.min(50, opts.max ?? maxPerSweep(env)));
	const storedOffset = Number(await led.get(CURSOR_KEY));
	const windowOffset = Number.isFinite(storedOffset) && storedOffset >= 0 ? storedOffset : 0;
	const { window, nextOffset } = sweepWindow(entries, windowOffset, size);

	const checkedAt = new Date().toISOString();
	const changed: WatchChange[] = [];
	for (const entry of window) {
		try {
			const r = await deps.checkWatch(env, { url: entry.url, selector: entry.selector, label: entry.label, threshold: entry.threshold, thresholdPct: entry.thresholdPct });
			if (r.changed)
				changed.push({
					url: entry.url,
					selector: entry.selector,
					label: entry.label,
					hash: r.hash,
					previous_hash: r.previous_hash,
					numeric_value: r.numeric_value,
					previous_numeric_value: r.previous_numeric_value,
					checked_at: checkedAt,
				});
		} catch {
			continue; // one unreachable watch must not sink the whole sweep
		}
	}

	await led.mark(CURSOR_KEY, String(nextOffset));
	await led.mark(LAST_REPORT_KEY, JSON.stringify({ checked_at: checkedAt, changed: changed.slice(0, MAX_CACHED_CHANGES), changed_count: changed.length }));

	return { checked: window.length, total_watches: entries.length, window_offset: windowOffset, next_offset: nextOffset, changed };
}

/** The real deps: enumerate via watch.ts's directory index, re-check each entry through
 *  the `watch` fn itself (so a real change advances its own hash-store + index exactly as
 *  a manual call would). Dynamically imported by the caller to keep the cron path from
 *  pulling in the fetch surface when the feature is dormant, mirroring _consolidate's
 *  defaultDeps. Tests inject fakes instead. */
export async function defaultDeps(): Promise<WatchSweepDeps> {
	const { watch, listWatches } = await import("./watch");
	return {
		listWatches,
		checkWatch: async (env, entry) => {
			const r = await watch.run(env, { url: entry.url, selector: entry.selector, label: entry.label, threshold: entry.threshold, threshold_pct: entry.thresholdPct });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "watch failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return {
				changed: Boolean(parsed.changed),
				first_seen: Boolean(parsed.first_seen),
				hash: String(parsed.hash ?? ""),
				previous_hash: typeof parsed.previous_hash === "string" ? parsed.previous_hash : undefined,
				numeric_value: typeof parsed.numeric_value === "number" ? parsed.numeric_value : undefined,
				previous_numeric_value: typeof parsed.previous_numeric_value === "number" ? parsed.previous_numeric_value : undefined,
			};
		},
	};
}
