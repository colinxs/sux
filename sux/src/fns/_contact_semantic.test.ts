import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));

import { jmap } from "./jmap";
import { contactSemanticIndex, topKContactByCosine } from "./_contact_semantic";
import { encodeEmbedding } from "./_embed";

const okR = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const run = jmap.run as unknown as ReturnType<typeof vi.fn>;

function kvStub() {
	const store = new Map<string, string>();
	return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)), delete: vi.fn(async (k: string) => void store.delete(k)) };
}

const CARDS: Record<string, { id: string; name: { full: string }; organizations: Record<string, { name: string }>; emails: Record<string, { address: string }>; phones: Record<string, { number: string }> }> = {
	c1: { id: "c1", name: { full: "Dr. Chen" }, organizations: { o: { name: "St. Luke's Clinic" } }, emails: { e: { address: "chen@clinic.com" } }, phones: {} },
	c2: { id: "c2", name: { full: "Jane Doe" }, organizations: {}, emails: { e: { address: "jane@example.com" } }, phones: {} },
};

/** A minimal stand-in for _jmap.ts's real '#'-back-reference resolver (jmap.run is mocked here),
 *  matching _mail_semantic.test.ts's identical helper — just enough to unwrap the one shape
 *  _contact_semantic.ts actually sends. */
function resolvePath(value: any, path: string): any {
	let cur = value;
	for (const seg of path.split("/").filter(Boolean)) {
		if (cur == null) return cur;
		cur = seg === "*" ? (Array.isArray(cur) ? cur : [cur]) : Array.isArray(cur) ? cur.map((v) => v?.[seg]) : cur[seg];
	}
	return cur;
}
function resolveArgs(args: any, results: Record<string, any>): any {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(args ?? {})) {
		if (k.startsWith("#") && v && typeof v === "object" && "resultOf" in (v as any)) out[k.slice(1)] = resolvePath(results[(v as any).resultOf], (v as any).path);
		else out[k] = v;
	}
	return out;
}

/** Route a jmapBatch call ([[method,args,callId], ...]) to canned per-method responses. */
function mockBatch(handlers: Record<string, (args: any, callId: string) => [string, any]>) {
	run.mockImplementation(async (_env: any, args: any) => {
		const results: Record<string, any> = {};
		const methodResponses = (args.calls as [string, any, string][]).map(([method, callArgs, callId]) => {
			const resolved = resolveArgs(callArgs, results);
			const h = handlers[method];
			if (!h) return ["error", { type: "unknownMethod" }, callId];
			const [rMethod, rArgs] = h(resolved, callId);
			results[callId] = rArgs;
			return [rMethod, rArgs, callId];
		});
		return okR({ methodResponses });
	});
}

const embedVec = (t: string): number[] => [t.toLowerCase().includes("chen") || t.toLowerCase().includes("clinic") ? 1 : 0, t.toLowerCase().includes("jane") || t.toLowerCase().includes("doe") ? 1 : 0, 0.1];
const aiEnv = () => ({ FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub(), AI: { run: vi.fn(async (_m: string, inputs: any) => ({ data: (inputs.text as string[]).map(embedVec) })) } }) as any;

afterEach(() => vi.clearAllMocks());

describe("_contact_semantic", () => {
	it("returns null when JMAP isn't configured", async () => {
		const idx = await contactSemanticIndex({ AI: { run: vi.fn() } } as any);
		expect(idx).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});

	it("builds a full index (ContactCard/query→get) on a cold cache, anchored on the ContactCard/get response's `state`", async () => {
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1", "c2"], total: 2 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		const env = aiEnv();
		const idx = await contactSemanticIndex(env);
		expect(idx?.state).toBe("s1");
		expect(idx?.chunks.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
		expect(await env.OAUTH_KV.get("sux:contact:semantic")).toBeTruthy(); // persisted for the next call
	});

	it("a second call incrementally diffs via ContactCard/changes instead of re-embedding the whole address book", async () => {
		const env = aiEnv();
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1"], total: 1 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		await contactSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		mockBatch({
			"ContactCard/changes": (a) => ["ContactCard/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: ["c2"], updated: [], destroyed: [] }],
			"ContactCard/get": (a) => ["ContactCard/get", { list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		const idx2 = await contactSemanticIndex(env);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild + 1); // only c2 was embedded
		expect(env.AI.run.mock.calls[embedCallsAfterBuild][1].text).toEqual(["Jane Doe\njane@example.com"]);
	});

	it("an `updated` id whose embedding is already cached is kept as-is, not re-embedded", async () => {
		const env = aiEnv();
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1"], total: 1 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		await contactSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		mockBatch({ "ContactCard/changes": (a) => ["ContactCard/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: [], updated: ["c1"], destroyed: [] }] });
		const idx2 = await contactSemanticIndex(env);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id)).toEqual(["c1"]);
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild); // no re-embed
	});

	it("drops a destroyed id from the cached chunk set without re-embedding anything", async () => {
		const env = aiEnv();
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1", "c2"], total: 2 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		await contactSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		mockBatch({ "ContactCard/changes": (a) => ["ContactCard/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: [], updated: [], destroyed: ["c1"] }] });
		const idx2 = await contactSemanticIndex(env);
		expect(idx2?.chunks.map((c) => c.id)).toEqual(["c2"]);
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild);
	});

	it("falls back to a full rebuild when the server can no longer diff from the cached state (cannotCalculateChanges)", async () => {
		const env = aiEnv();
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1"], total: 1 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		await contactSemanticIndex(env);

		let queryCalledAgain = false;
		mockBatch({
			"ContactCard/changes": () => ["error", { type: "cannotCalculateChanges" }],
			"ContactCard/query": () => {
				queryCalledAgain = true;
				return ["ContactCard/query", { ids: ["c1", "c2"], total: 2 }];
			},
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s2", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		const idx2 = await contactSemanticIndex(env);
		expect(queryCalledAgain).toBe(true);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
	});

	it("a transport failure during the incremental leg also falls back to a full rebuild rather than throwing", async () => {
		const env = aiEnv();
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1"], total: 1 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		await contactSemanticIndex(env);

		run.mockImplementationOnce(async () => errR("[upstream_error] JMAP server error (500)."));
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1"], total: 1 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		const idx2 = await contactSemanticIndex(env);
		expect(idx2).toBeTruthy();
	});

	it("a no-op incremental pass (no created/updated/destroyed) skips the KV write entirely", async () => {
		const env = aiEnv();
		mockBatch({
			"ContactCard/query": () => ["ContactCard/query", { ids: ["c1"], total: 1 }],
			"ContactCard/get": (a) => ["ContactCard/get", { state: "s1", list: (a.ids as string[]).map((id) => CARDS[id]) }],
		});
		const idx1 = await contactSemanticIndex(env);
		const putCallsAfterBuild = env.OAUTH_KV.put.mock.calls.length;

		mockBatch({ "ContactCard/changes": (a) => ["ContactCard/changes", { oldState: a.sinceState, newState: "s1", hasMoreChanges: false, created: [], updated: [], destroyed: [] }] });
		const idx2 = await contactSemanticIndex(env);
		expect(idx2?.chunks.map((c) => c.id)).toEqual(idx1?.chunks.map((c) => c.id));
		expect(env.OAUTH_KV.put.mock.calls.length).toBe(putCallsAfterBuild);
	});

	it("truncation past INDEX_MAX keeps just-(re-)embedded cards over stale cached ones — contacts have no recency field to sort eviction by", async () => {
		const env = aiEnv();
		const staleChunks = Array.from({ length: 1999 }, (_, i) => ({ id: `stale${i}`, name: "s", company: "", emails: [], phones: [], embedding: [0, 0, 0.1] }));
		const cached = { state: "s1", version: 1, at: 0, total: 1999, truncated: false, chunks: staleChunks };
		const stored = { ...cached, chunks: cached.chunks.map((c) => ({ ...c, embedding: encodeEmbedding(c.embedding) })) };
		env.OAUTH_KV.store.set("sux:contact:semantic", JSON.stringify(stored));

		const NEW_IDS = [0, 1, 2, 3, 4].map((i) => `new${i}`);
		const NEW_CARDS: Record<string, any> = Object.fromEntries(NEW_IDS.map((id) => [id, { id, name: { full: "fresh" }, organizations: {}, emails: {}, phones: {} }]));
		mockBatch({
			"ContactCard/changes": (a) => ["ContactCard/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: NEW_IDS, updated: [], destroyed: [] }],
			"ContactCard/get": (a) => ["ContactCard/get", { list: (a.ids as string[]).map((id) => NEW_CARDS[id]) }],
		});
		const idx2 = await contactSemanticIndex(env);
		const ids = new Set(idx2?.chunks.map((c) => c.id));
		expect(ids.size).toBe(2000); // 2004 combined, evicted down to INDEX_MAX
		for (const id of NEW_IDS) expect(ids.has(id)).toBe(true); // brand new chunks always survive
	});

	it("topKContactByCosine ranks by cosine similarity and skips chunks with no embedding", () => {
		const chunks = [
			{ id: "a", name: "n", company: "", emails: [], phones: [], embedding: [1, 0, 0] },
			{ id: "b", name: "n", company: "", emails: [], phones: [], embedding: [0, 1, 0] },
			{ id: "c", name: "n", company: "", emails: [], phones: [], embedding: [] },
		];
		const hits = topKContactByCosine([1, 0, 0], chunks, 5);
		expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
		expect(hits[0].score).toBeCloseTo(1);
	});
});
