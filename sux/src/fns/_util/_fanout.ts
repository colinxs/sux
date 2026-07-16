// Fan-out budget constants + the bounded-concurrency pool they size. Split out of
// _util.ts (#565) — kept together because the budget and the pool that spends it
// are one concern (a fan-out site tunes both at once).

// Fan-out time budget. A fn.run is killed by index.ts's FN_DEADLINE_MS (60s) with
// ZERO partials returned — so a wide batch/pipe/batch_fetch that runs long yields
// nothing. Each fan-out site stops DISPATCHING new work at this soft budget (< the
// 60s hard deadline, leaving headroom to reduce + serialize the collected partials)
// and returns what it has, flagged truncated. Kept here so the sites share one number.
export const FANOUT_BUDGET_MS = 50_000;

/** Default self-expiry for the CAS handles a bulk fan-out download mints (put /
 * batch_fetch as:"url"). These are staging artifacts, not durable records — a
 * permanent handle per URL would accrete R2/KV storage forever, so they expire
 * unless the caller overrides. Reach for `store` directly when you want permanence. */
export const FANOUT_STORE_TTL_S = 7 * 24 * 60 * 60;

/** Aggregate in-flight download budget for a SINGLE fan-out run. The per-item cap
 * (MAX_STORE_BYTES) bounds ONE download; CONCURRENCY (8) of them buffered at once
 * would blow the isolate's ~128MB ceiling, so a run shares this budget across its
 * workers via byteBudget(). Sized to admit a few full-size downloads concurrently
 * while leaving isolate headroom. */
export const FANOUT_BYTE_BUDGET = 96 * 1024 * 1024;

export type ByteBudget = { acquire: (n: number) => Promise<void>; release: (n: number) => void };

/**
 * A FIFO byte-budget gate for fan-out downloads: a worker `acquire()`s the bytes it
 * may buffer before starting a download and `release()`s them after storing, so the
 * concurrent downloads in one run can never sum past `cap` (the per-item cap alone
 * bounds only a single download — 8 × 25MB would OOM the isolate). A single request
 * larger than `cap` is clamped to the whole budget (it is already per-item bounded)
 * so it runs alone instead of deadlocking. FIFO ordering keeps a large reservation
 * from being starved by an endless stream of small ones. Always pair acquire(n)/
 * release(n) with the SAME n (a try/finally) so the ledger stays balanced.
 */
export function byteBudget(cap: number): ByteBudget {
	let available = cap;
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	const pump = (): void => {
		while (waiters.length && waiters[0].n <= available) {
			const w = waiters.shift()!;
			available -= w.n;
			w.resolve();
		}
	};
	return {
		acquire(n: number): Promise<void> {
			const need = Math.min(Math.max(0, n), cap);
			// Head-of-line: a new claim only jumps the fast path when nothing is already
			// waiting, so a queued large reservation can't be starved.
			if (waiters.length === 0 && need <= available) {
				available -= need;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				waiters.push({ n: need, resolve });
			});
		},
		release(n: number): void {
			available = Math.min(cap, available + Math.min(Math.max(0, n), cap));
			pump();
		},
	};
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order in the
 * result. Index-claiming worker pool (was hand-rolled identically in batch and
 * batch_fetch). `fn` should handle its own per-item errors — a throw rejects the
 * whole pool.
 *
 * When `deadline` (an absolute epoch-ms timestamp) is given, workers stop CLAIMING
 * new items once `Date.now() >= deadline`, AND each in-flight leaf is raced against
 * the deadline — a single leaf that overruns must not push the whole fan-out past
 * index.ts's FN_DEADLINE_MS, where `withDeadline` drops the run promise and loses
 * ALL collected partials. On timeout the still-running leaf is abandoned (its value
 * dropped) and its slot stays `undefined`. The result array is DENSE (pre-filled),
 * so the caller can detect skipped items with `=== undefined` (a sparse-array
 * `.map`/`.filter` would silently skip holes) and report a partial/truncated result
 * instead of the whole run being abandoned at the hard deadline.
 */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>, deadline?: number): Promise<R[]> {
	const results = new Array<R>(items.length).fill(undefined as R);
	let next = 0;
	const workers = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
	// Distinguishes "the deadline fired" from any real value `fn` may resolve.
	const TIMED_OUT = Symbol("pool-deadline");
	await Promise.all(
		Array.from({ length: workers }, async () => {
			for (;;) {
				if (deadline !== undefined && Date.now() >= deadline) return;
				const i = next++;
				if (i >= items.length) return;
				if (deadline === undefined) {
					results[i] = await fn(items[i], i);
					continue;
				}
				// Race the leaf against the deadline: abandon an overrunning leaf (slot
				// stays `undefined`, the same partial/truncated path as an unclaimed
				// item) rather than let it sink the whole run. `.finally(clearTimeout)`
				// so the timer never leaks or holds the isolate open.
				let timer: ReturnType<typeof setTimeout>;
				const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
					timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
				});
				const r = await Promise.race([fn(items[i], i), timeout]).finally(() => clearTimeout(timer));
				if (r === TIMED_OUT) return;
				results[i] = r as R;
			}
		}),
	);
	return results;
}
