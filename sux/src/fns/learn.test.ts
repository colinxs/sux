import { afterEach, describe, expect, it, vi } from "vitest";

// The vault mirror rides obsidian.run — mock it (its own suite covers it) so we test
// learn's KV store, embed-on-learn, kNN classify, batch-undo, and the hasAI gate.
vi.mock("./obsidian", () => ({ obsidian: { run: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })) } }));

import { learn } from "./learn";
import { obsidian } from "./obsidian";

const obs = obsidian.run as unknown as ReturnType<typeof vi.fn>;
const parse = (r: any) => JSON.parse(r.content[0].text);

/** A minimal Map-backed OAUTH_KV (get/put/delete/list) matching the CF KV surface. */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true as const,
			cursor: undefined as string | undefined,
		})),
	};
}

/** Deterministic fake embeddings: map a label keyword to a distinct near-orthogonal unit vector so
 *  kNN is predictable. Anything mentioning "cat" → e0, "invoice" → e1, else a neutral vector. */
function fakeEmbed(text: string): number[] {
	const t = text.toLowerCase();
	if (t.includes("cat") || t.includes("kitten") || t.includes("feline")) return [1, 0, 0];
	if (t.includes("invoice") || t.includes("billing") || t.includes("payment")) return [0, 1, 0];
	return [0, 0, 1];
}

function makeEnv() {
	const kv = makeKv();
	const run = vi.fn(async (_model: string, inputs: any) => {
		const texts: string[] = inputs.text;
		return { shape: [texts.length, 3], data: texts.map(fakeEmbed) };
	});
	return { env: { AI: { run }, OAUTH_KV: kv } as any, kv, run };
}

afterEach(() => vi.clearAllMocks());

describe("learn", () => {
	it("learn embeds + stores a retrievable record and mirrors to the vault once", async () => {
		const { env, kv } = makeEnv();
		const r = await learn.run(env, { action: "learn", input: "my cat is named Mochi", label: "pets" });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j.label).toBe("pets");
		expect(typeof j.id).toBe("string");
		expect(j.batch).toBe(j.id); // no explicit batch → the record is its own undo handle
		expect(j.undo_hint).toContain(j.batch);
		expect(j.mirrored_to_vault).toBe(true);

		// Persisted under the sux:learn:example: prefix with its embedding.
		const stored = [...kv.store.entries()].find(([k]) => k.startsWith("sux:learn:example:"));
		expect(stored).toBeTruthy();
		const rec = JSON.parse(stored![1]);
		expect(rec.label).toBe("pets");
		expect(rec.embedding).toEqual([1, 0, 0]);

		// The vault mirror went through obsidian append exactly once.
		const appends = obs.mock.calls.filter((c: any) => c[1].action === "append");
		expect(appends).toHaveLength(1);
		expect(appends[0][1].content).toContain("pets");
	});

	it("learn is idempotent on the vault mirror — a re-teach of identical content does not double-append", async () => {
		const { env } = makeEnv();
		await learn.run(env, { action: "learn", input: "same example", label: "L" });
		obs.mockClear();
		const r2 = await learn.run(env, { action: "learn", input: "same example", label: "L" });
		expect(parse(r2).mirrored_to_vault).toBe(false); // fingerprint dedup fired
		expect(obs.mock.calls.filter((c: any) => c[1].action === "append")).toHaveLength(0);
	});

	it("learn without the AI binding fails not_configured and writes NOTHING (dormant gate)", async () => {
		const kv = makeKv();
		const r = await learn.run({ OAUTH_KV: kv } as any, { action: "learn", input: "x", label: "y" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
		expect(kv.store.size).toBe(0); // no KV record
		expect(obs.mock.calls.filter((c: any) => c[1].action === "append")).toHaveLength(0); // no vault write
	});

	it("learn requires both input and label", async () => {
		const { env } = makeEnv();
		expect((await learn.run(env, { action: "learn", input: "x" })).errorCode).toBe("bad_input");
		expect((await learn.run(env, { action: "learn", label: "y" })).errorCode).toBe("bad_input");
	});

	it("classify returns the nearest label + a cosine confidence from a seeded set", async () => {
		const { env } = makeEnv();
		await learn.run(env, { action: "learn", input: "a fluffy cat", label: "animal" });
		await learn.run(env, { action: "learn", input: "an overdue invoice", label: "finance" });
		const r = await learn.run(env, { action: "classify", input: "the kitten meowed" });
		const j = parse(r);
		expect(j.label).toBe("animal"); // kitten → cat vector → nearest is the animal exemplar
		expect(j.confidence).toBeCloseTo(1, 5);
		expect(j.neighbors[0].label).toBe("animal");
	});

	it("classify on an empty store returns label:null (not an error)", async () => {
		const { env } = makeEnv();
		const r = await learn.run(env, { action: "classify", input: "anything" });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j.label).toBeNull();
		expect(j.neighbors).toEqual([]);
	});

	it("classify without the AI binding fails not_configured", async () => {
		const kv = makeKv();
		const r = await learn.run({ OAUTH_KV: kv } as any, { action: "classify", input: "x" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
	});

	it("undo(batch) deletes exactly that batch's records and leaves others untouched", async () => {
		const { env } = makeEnv();
		await learn.run(env, { action: "learn", input: "cat one", label: "A", batch: "B1" });
		await learn.run(env, { action: "learn", input: "cat two", label: "A", batch: "B1" });
		await learn.run(env, { action: "learn", input: "invoice one", label: "C", batch: "B2" });
		expect(parse(await learn.run(env, { action: "list" })).count).toBe(3);

		const u = parse(await learn.run(env, { action: "undo", batch: "B1" }));
		expect(u.deleted).toBe(2);
		const after = parse(await learn.run(env, { action: "list" }));
		expect(after.count).toBe(1);
		expect(after.examples[0].batch).toBe("B2"); // the other batch survived
	});

	it("undo requires a batch", async () => {
		const { env } = makeEnv();
		expect((await learn.run(env, { action: "undo" })).errorCode).toBe("bad_input");
	});

	it("list enumerates stored examples WITHOUT invoking AI", async () => {
		const { env, run } = makeEnv();
		await learn.run(env, { action: "learn", input: "a cat", label: "A" });
		run.mockClear();
		const j = parse(await learn.run(env, { action: "list" }));
		expect(j.count).toBe(1);
		expect(j.labels).toEqual({ A: 1 });
		expect(run).not.toHaveBeenCalled(); // list is a pure KV read
	});

	it("reset stages a preview by default, then clears the whole learned set on commit", async () => {
		const { env } = makeEnv();
		await learn.run(env, { action: "learn", input: "a cat", label: "A" });
		await learn.run(env, { action: "learn", input: "an invoice", label: "C" });
		// no stage/commit_token/force: auto-stages (learn_reset is irreversible), nothing cleared
		const staged = parse(await learn.run(env, { action: "reset" }));
		expect(staged.staged).toBe(true);
		expect(staged.commit_token).toBeTruthy();
		expect(parse(await learn.run(env, { action: "list" })).count).toBe(2);
		// commit with the returned token: clears
		const j = parse(await learn.run(env, { action: "reset", commit_token: staged.commit_token }));
		expect(j.deleted).toBe(2);
		expect(parse(await learn.run(env, { action: "list" })).count).toBe(0);
	});

	it("reset force:true skips staging and clears in one shot", async () => {
		const { env } = makeEnv();
		await learn.run(env, { action: "learn", input: "a cat", label: "A" });
		const j = parse(await learn.run(env, { action: "reset", force: true }));
		expect(j.deleted).toBe(1);
		expect(parse(await learn.run(env, { action: "list" })).count).toBe(0);
	});

	it("a single embed round-trip per learn (batched, bounded cost)", async () => {
		const { env, run } = makeEnv();
		await learn.run(env, { action: "learn", input: "a cat", label: "A" });
		// one AI.run for the embed; no per-word or per-neighbor extra calls.
		expect(run).toHaveBeenCalledTimes(1);
	});
});
