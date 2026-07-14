import { afterEach, describe, expect, it, vi } from "vitest";

// The vault mirror rides obsidian.run — mock it (its own suite covers it) so we can
// assert the learn action mirrors the re-distilled voice spec without a configured vault.
vi.mock("./obsidian", () => ({ obsidian: { run: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })) } }));

import { maybeDecompressString } from "./_gzip";
import { obsidian } from "./obsidian";
import { preferences } from "./preferences";
import { voice } from "./voice";
import { DATA_CLOSE, DATA_OPEN } from "../ai";

const obs = obsidian.run as unknown as ReturnType<typeof vi.fn>;

// We exercise the REAL guarded llm() (from ../ai) and only stub env.AI.run + a
// Map-backed OAUTH_KV — so the assertions see the actual <<<DATA>>> fence
// wrapUntrusted() puts around the untrusted examples, and real KV round-trips.

/** A minimal Map-backed OAUTH_KV (get/put/delete/list) matching the CF KV surface. */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true as const,
		})),
	};
}

/** env with the real llm() driving a stubbed AI.run that echoes a distilled spec. */
function makeEnv(spec = "Terse. Lowercase openers. No hedging.") {
	const kv = makeKv();
	const run = vi.fn(async () => ({ response: spec }));
	return { env: { AI: { run }, OAUTH_KV: kv } as any, kv, run };
}

/** Pull the system + user messages from a captured AI.run call. */
function messages(run: ReturnType<typeof vi.fn>, callIndex = 0) {
	const [, inputs] = run.mock.calls[callIndex];
	const msgs = (inputs as any).messages as Array<{ role: string; content: string }>;
	return { system: msgs.find((m) => m.role === "system")!.content, user: msgs.find((m) => m.role === "user")!.content };
}

afterEach(() => vi.clearAllMocks());

describe("preferences", () => {
	it("get on an unknown profile returns a not-found note", async () => {
		const { env } = makeEnv();
		const r = await preferences.run(env, { action: "get", profile: "ghost" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.found).toBe(false);
		expect(j.note).toMatch(/No profile 'ghost'/);
	});

	it("learn stores + distills, fencing the untrusted sample as DATA", async () => {
		const { env, kv, run } = makeEnv("Terse spec v1.");
		const r = await preferences.run(env, { action: "learn", profile: "colin", sample: "ship it. tests green." });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.distilled_spec).toBe("Terse spec v1.");
		expect(j.example_count).toBe(1);
		expect(typeof j.updated_at).toBe("number");

		// The distill rode the guarded llm(): sample fenced in <<<DATA>>>, instruction in system.
		const { system, user } = messages(run);
		expect(system).toMatch(/concise style spec/i);
		expect(user).toContain(DATA_OPEN);
		expect(user).toContain(DATA_CLOSE);
		expect(user).toContain("ship it. tests green.");

		// Persisted in the exact shape voice reads back.
		const stored = JSON.parse(await maybeDecompressString(kv.store.get("sux:prefs:colin")!));
		expect(stored.distilled_spec).toBe("Terse spec v1.");
		expect(stored.examples).toEqual(["ship it. tests green."]);
		expect(typeof stored.updated_at).toBe("number");
	});

	it("mirrors the re-distilled voice spec into the vault, idempotently", async () => {
		const { env } = makeEnv("Terse. No hedging.");
		await preferences.run(env, { action: "learn", profile: "colin", sample: "ship it. tests green." });

		// One vault append with the profile-headed section containing the spec.
		expect(obs).toHaveBeenCalledTimes(1);
		const [, append] = obs.mock.calls[0];
		expect(append).toMatchObject({ action: "append", path: "sux/Voice.md" });
		expect(append.content).toContain("## colin —");
		expect(append.content).toContain("Terse. No hedging.");

		// A learn that re-distills to the same spec does not double-append.
		obs.mockClear();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "another sample" });
		expect(obs).not.toHaveBeenCalled();
	});

	it("get returns the stored spec + example count after a learn", async () => {
		const { env } = makeEnv("Stored spec.");
		await preferences.run(env, { action: "learn", profile: "colin", sample: "one" });
		const r = await preferences.run(env, { action: "get", profile: "colin" });
		const j = JSON.parse(r.content[0].text);
		expect(j.found).toBe(true);
		expect(j.distilled_spec).toBe("Stored spec.");
		expect(j.example_count).toBe(1);
	});

	it("a second learn re-distills from BOTH accumulated examples", async () => {
		const { env, run } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "first sample" });
		run.mockResolvedValueOnce({ response: "Distilled from two." });
		const r = await preferences.run(env, { action: "learn", profile: "colin", sample: "second sample" });
		const j = JSON.parse(r.content[0].text);
		expect(j.example_count).toBe(2);
		expect(j.distilled_spec).toBe("Distilled from two.");
		// The re-distill's fenced input carried BOTH exemplars — the continual model update.
		const { user } = messages(run, 1);
		expect(user).toContain("first sample");
		expect(user).toContain("second sample");
	});

	it("caps the rolling few-shot at the last 20 examples, dropping the oldest", async () => {
		const { env, kv } = makeEnv();
		for (let i = 0; i < 25; i++) await preferences.run(env, { action: "learn", profile: "cap", sample: `sample ${i}` });
		const stored = JSON.parse(await maybeDecompressString(kv.store.get("sux:prefs:cap")!));
		expect(stored.examples).toHaveLength(20);
		expect(stored.examples[0]).toBe("sample 5"); // 0..4 dropped
		expect(stored.examples[19]).toBe("sample 24");
	});

	it("learn requires a sample", async () => {
		const { env, run } = makeEnv();
		const r = await preferences.run(env, { action: "learn", profile: "colin" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(run).not.toHaveBeenCalled();
	});

	it("learn fails not_configured without the AI binding", async () => {
		const kv = makeKv();
		const r = await preferences.run({ OAUTH_KV: kv } as any, { action: "learn", profile: "colin", sample: "x" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
	});

	it("reset deletes the profile", async () => {
		const { env, kv } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "one" });
		expect(kv.store.has("sux:prefs:colin")).toBe(true);
		const r = await preferences.run(env, { action: "reset", profile: "colin" });
		const j = JSON.parse(r.content[0].text);
		expect(j.deleted).toBe(true);
		expect(kv.store.has("sux:prefs:colin")).toBe(false);
	});

	it("reset on a missing profile reports nothing deleted", async () => {
		const { env } = makeEnv();
		const r = await preferences.run(env, { action: "reset", profile: "ghost" });
		expect(JSON.parse(r.content[0].text).deleted).toBe(false);
	});

	it("list enumerates profile names under the sux:prefs: prefix", async () => {
		const { env } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "alpha", sample: "a" });
		await preferences.run(env, { action: "learn", profile: "beta", sample: "b" });
		const r = await preferences.run(env, { action: "list" });
		const j = JSON.parse(r.content[0].text);
		expect(j.profiles).toEqual(["alpha", "beta"]);
		expect(j.count).toBe(2);
	});

	it("defaults to action=get on the default profile and never throws", async () => {
		const { env } = makeEnv();
		const r = await preferences.run(env, {});
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).profile).toBe("default");
	});

	it("get with examples:true returns the raw exemplars so a caller can pick one to forget", async () => {
		const { env } = makeEnv("Spec.");
		await preferences.run(env, { action: "learn", profile: "colin", sample: "first" });
		await preferences.run(env, { action: "learn", profile: "colin", sample: "second" });
		const r = await preferences.run(env, { action: "get", profile: "colin", examples: true });
		const j = JSON.parse(r.content[0].text);
		expect(j.example_count).toBe(2);
		expect(j.examples).toEqual(["first", "second"]);
		// Default get omits the raw exemplars.
		const bare = JSON.parse((await preferences.run(env, { action: "get", profile: "colin" })).content[0].text);
		expect(bare.examples).toBeUndefined();
	});

	it("forget drops the most recent exemplar and re-distills from the rest", async () => {
		const { env, kv, run } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "keep me" });
		await preferences.run(env, { action: "learn", profile: "colin", sample: "bad sample" });
		run.mockResolvedValueOnce({ response: "Re-distilled without the bad one." });
		const r = await preferences.run(env, { action: "forget", profile: "colin" });
		const j = JSON.parse(r.content[0].text);
		expect(j.removed_index).toBe(2);
		expect(j.example_count).toBe(1);
		expect(j.distilled_spec).toBe("Re-distilled without the bad one.");
		const stored = JSON.parse(await maybeDecompressString(kv.store.get("sux:prefs:colin")!));
		expect(stored.examples).toEqual(["keep me"]);
	});

	it("forget honors a 1-based index and re-distills from the survivors", async () => {
		const { env, kv, run } = makeEnv();
		for (const s of ["a", "b", "c"]) await preferences.run(env, { action: "learn", profile: "colin", sample: s });
		run.mockResolvedValueOnce({ response: "From a and c." });
		const r = await preferences.run(env, { action: "forget", profile: "colin", index: 2 });
		expect(JSON.parse(r.content[0].text).removed_index).toBe(2);
		const stored = JSON.parse(await maybeDecompressString(kv.store.get("sux:prefs:colin")!));
		expect(stored.examples).toEqual(["a", "c"]);
	});

	it("forget rejects an out-of-range index without touching the store", async () => {
		const { env, run } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "only" });
		run.mockClear();
		const r = await preferences.run(env, { action: "forget", profile: "colin", index: 5 });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(run).not.toHaveBeenCalled();
	});

	it("forgetting the last exemplar removes the profile (no voice left to distill)", async () => {
		const { env, kv } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "only" });
		const r = await preferences.run(env, { action: "forget", profile: "colin" });
		const j = JSON.parse(r.content[0].text);
		expect(j.deleted).toBe(true);
		expect(j.example_count).toBe(0);
		expect(kv.store.has("sux:prefs:colin")).toBe(false);
	});

	it("forget on a missing profile reports nothing to forget", async () => {
		const { env } = makeEnv();
		const r = await preferences.run(env, { action: "forget", profile: "ghost" });
		expect(JSON.parse(r.content[0].text).found).toBe(false);
	});

	it("learn refuses to overwrite a profile updated concurrently mid-distill (#288)", async () => {
		const { env, kv, run } = makeEnv();
		await preferences.run(env, { action: "learn", profile: "colin", sample: "first" });
		// Simulate a concurrent writer landing during our distill: the re-read after llm()
		// must see the bumped version and refuse to clobber the interleaving contribution.
		run.mockImplementationOnce(async () => {
			const cur = JSON.parse(await maybeDecompressString(kv.store.get("sux:prefs:colin")!));
			kv.store.set("sux:prefs:colin", JSON.stringify({ ...cur, version: cur.version + 1, examples: [...cur.examples, "raced-in"] }));
			return { response: "would-be-lost spec" };
		});
		const r = await preferences.run(env, { action: "learn", profile: "colin", sample: "second" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(r.content[0].text).toMatch(/concurrently|retry/i);
		// The concurrent writer's contribution survived — nothing was clobbered.
		const stored = JSON.parse(kv.store.get("sux:prefs:colin")!);
		expect(stored.examples).toContain("raced-in");
	});

	// Cross-check: what preferences(learn) stores is exactly what voice(profile) reads.
	it("integration: voice(profile:X) picks up what preferences(learn, profile:X) taught", async () => {
		const { env, run } = makeEnv("VOICE-SPEC: lowercase, terse, no hedging.");
		await preferences.run(env, { action: "learn", profile: "colin", sample: "ship it. tests green." });

		run.mockResolvedValueOnce({ response: "restyled" });
		const r = await voice.run(env, { text: "The deployment completed successfully.", profile: "colin" });
		expect(r.isError).toBeFalsy();
		// voice folded the distilled spec + the stored sample into its system prompt.
		const { system } = messages(run, 1);
		expect(system).toContain("VOICE-SPEC: lowercase, terse, no hedging.");
		expect(system).toContain("ship it. tests green.");
	});
});
