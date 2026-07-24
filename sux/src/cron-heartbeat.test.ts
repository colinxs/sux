import { describe, expect, it } from "vitest";
import { CRON_STALE_MS, readHeartbeats, readWatchHeartbeats, recordHeartbeat, recordWatchHeartbeat, runSubJob } from "./cron-heartbeat";

const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
};

const fakeListableKV = (init: Record<string, string> = {}) => {
	const kv = fakeKV(init);
	return { ...kv, list: async ({ prefix }: { prefix: string }) => ({ keys: [...kv.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
};

const K = (name: string) => `sux:cron:heartbeat:${name}`;

describe("recordHeartbeat / runSubJob (writer)", () => {
	it("runSubJob stamps ok=true after a clean sub-job", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		let ran = false;
		await runSubJob(env, "mail_triage", async () => void (ran = true));
		expect(ran).toBe(true);
		expect(JSON.parse(kv.store.get(K("mail_triage"))!)).toMatchObject({ ok: true });
	});

	it("runSubJob swallows a throwing sub-job and stamps ok=false + error", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await expect(runSubJob(env, "self_improve", async () => { throw new Error("boom"); })).resolves.toBeUndefined();
		const beat = JSON.parse(kv.store.get(K("self_improve"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBe("boom");
	});

	it("stamps ok=false when a sub-job resolves a report carrying an `error` (soft failure)", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "briefing", async () => ({ cycle: "d1", digest_written: false, error: "digest append failed: 503" }));
		const beat = JSON.parse(kv.store.get(K("briefing"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBe("digest append failed: 503");
	});

	it("keeps ok=true for a benign no-op report (dormant/skipped carry `note`, not `error`)", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "weekly_recall", async () => ({ dormant: true, note: "weekly_recall is disabled" }));
		expect(JSON.parse(kv.store.get(K("weekly_recall"))!)).toMatchObject({ ok: true });
	});

	// #1480: the live heartbeat showed mail_triage as { ok: false } with NO `error` key,
	// which runSubJob is the only writer for. An Error whose `.message` is "" lands on the
	// throw path as `String("" ?? e)` — `??` does not fall through, because "" is not
	// nullish — so recordHeartbeat's `if (error)` drops it. The result is a red sub-job
	// that is undiagnosable from outside: ok=false and nothing saying why.
	it("records a diagnosable error when the thrown Error has an empty message", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "mail_triage", async () => { throw new Error(""); });
		const beat = JSON.parse(kv.store.get(K("mail_triage"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	it("records a diagnosable error when a non-Error falsy value is thrown", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		// eslint-disable-next-line no-throw-literal
		await runSubJob(env, "adblock", async () => { throw ""; });
		const beat = JSON.parse(kv.store.get(K("adblock"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	// The mirror-image hole on the soft path: subJobError only accepts a string, so a tick
	// reporting `error` as an Error/object silently takes the success branch. A failure
	// recorded as ok=true is strictly worse than one recorded without its text.
	it("stamps ok=false when a report carries a non-string truthy `error`", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "briefing", async () => ({ error: new Error("upstream 503") }));
		const beat = JSON.parse(kv.store.get(K("briefing"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	it("stamps ok=false when a report carries a structured `error` object", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "agenda", async () => ({ error: { code: 503, detail: "upstream" } }));
		const beat = JSON.parse(kv.store.get(K("agenda"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	it("truncates long error text to keep the heartbeat bounded", async () => {
		const kv = fakeKV();
		await recordHeartbeat({ OAUTH_KV: kv } as any, "adblock", false, "x".repeat(1000));
		expect(JSON.parse(kv.store.get(K("adblock"))!).error).toHaveLength(300);
	});

	it("never throws when the KV binding is absent", async () => {
		await expect(runSubJob({} as any, "kroger_token", async () => {})).resolves.toBeUndefined();
	});
});

describe("readHeartbeats (staleness reader)", () => {
	it("reports { seen: false } for a sub-job that never ran", async () => {
		const cron: any = await readHeartbeats(fakeKV(), 1_000_000);
		expect(cron.mail_triage).toEqual({ seen: false });
	});

	it("flags a fresh healthy beat as not stale", async () => {
		const now = 10_000_000;
		const kv = fakeKV({ [K("mail_triage")]: JSON.stringify({ ok: true, at: now - 1000 }) });
		const cron: any = await readHeartbeats(kv, now);
		expect(cron.mail_triage).toMatchObject({ seen: true, ok: true, stale: false, age_ms: 1000 });
	});

	it("flags a beat older than the staleness window as stale", async () => {
		const now = 10_000_000;
		const kv = fakeKV({ [K("self_improve")]: JSON.stringify({ ok: true, at: now - CRON_STALE_MS - 1 }) });
		const cron: any = await readHeartbeats(kv, now);
		expect(cron.self_improve).toMatchObject({ seen: true, ok: true, stale: true });
	});

	it("degrades unparseable KV to { seen: false } without throwing", async () => {
		const kv = fakeKV({ [K("adblock")]: "not json" });
		const cron: any = await readHeartbeats(kv, 1_000_000);
		expect(cron.adblock).toEqual({ seen: false });
	});
});

describe("recordWatchHeartbeat / readWatchHeartbeats (#1414: local `watch` scheduled-task ingest)", () => {
	it("recordWatchHeartbeat then readWatchHeartbeats round-trips an ok beat, namespaced apart from CRON_JOBS", async () => {
		const kv = fakeListableKV();
		await recordWatchHeartbeat({ OAUTH_KV: kv } as any, "mychart-doors", true);
		const watch: any = await readWatchHeartbeats(kv);
		expect(watch["mychart-doors"]).toMatchObject({ seen: true, ok: true });
		expect(watch.mail_triage).toBeUndefined(); // never pollutes the CRON_JOBS const list
	});

	it("honors a per-watch staleAfterMs instead of the cron default", async () => {
		const now = 10_000_000;
		const kv = fakeListableKV();
		await recordWatchHeartbeat({ OAUTH_KV: kv } as any, "fast-watch", true, undefined, 1000);
		// Monkey-patch `at` into the past via a direct KV overwrite (recordWatchHeartbeat stamps `now`).
		const raw = JSON.parse(kv.store.get("sux:watch:heartbeat:fast-watch")!);
		kv.store.set("sux:watch:heartbeat:fast-watch", JSON.stringify({ ...raw, at: now - 2000 }));
		const watch: any = await readWatchHeartbeats(kv, now);
		expect(watch["fast-watch"]).toMatchObject({ seen: true, stale: true, age_ms: 2000 });
	});

	it("a failing watch stamps ok=false with the error text, never fails the poster's pass", async () => {
		const kv = fakeListableKV();
		await expect(recordWatchHeartbeat({ OAUTH_KV: kv } as any, "flaky-watch", false, "condition check timed out")).resolves.toBeUndefined();
		const watch: any = await readWatchHeartbeats(kv);
		expect(watch["flaky-watch"]).toMatchObject({ ok: false, error: "condition check timed out" });
	});

	it("readWatchHeartbeats degrades to {} without a KV binding, never throws", async () => {
		await expect(readWatchHeartbeats(undefined)).resolves.toEqual({});
	});
});
