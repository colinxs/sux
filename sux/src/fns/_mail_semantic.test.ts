import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));

import { jmap } from "./jmap";
import { mailSemanticIndex, topKMailByCosine } from "./_mail_semantic";

const okR = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const run = jmap.run as unknown as ReturnType<typeof vi.fn>;

function kvStub() {
	const store = new Map<string, string>();
	return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)), delete: vi.fn(async (k: string) => void store.delete(k)) };
}

const EMAILS: Record<string, { id: string; subject: string; from: { email: string }[]; receivedAt: string; preview: string }> = {
	e1: { id: "e1", subject: "Scan results", from: [{ email: "chen@clinic.com" }], receivedAt: "2026-03-01T00:00:00Z", preview: "your imaging results are ready" },
	e2: { id: "e2", subject: "Newsletter", from: [{ email: "news@example.com" }], receivedAt: "2026-03-02T00:00:00Z", preview: "weekly digest" },
};

/** A minimal stand-in for _jmap.ts's real '#'-back-reference resolver (jmap.run is mocked here,
 *  so nothing else resolves buildFull's "#ids":{resultOf:'q',...,path:'/ids'} against the prior
 *  Email/query call's result within the same batch) — just enough (a plain property path, '*'
 *  flattens) to unwrap the one shape _mail_semantic.ts actually sends. */
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

const embedVec = (t: string): number[] => [t.toLowerCase().includes("imaging") || t.toLowerCase().includes("scan") ? 1 : 0, t.toLowerCase().includes("newsletter") || t.toLowerCase().includes("digest") ? 1 : 0, 0.1];
const aiEnv = () => ({ FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub(), AI: { run: vi.fn(async (_m: string, inputs: any) => ({ data: (inputs.text as string[]).map(embedVec) })) } }) as any;

afterEach(() => vi.clearAllMocks());

describe("_mail_semantic", () => {
	it("returns null when JMAP isn't configured", async () => {
		const idx = await mailSemanticIndex({ AI: { run: vi.fn() } } as any);
		expect(idx).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});

	it("builds a full index (Email/query→get) on a cold cache, anchored on the Email/get response's `state`", async () => {
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1", "e2"], total: 2 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const env = aiEnv();
		const idx = await mailSemanticIndex(env);
		expect(idx?.state).toBe("s1");
		expect(idx?.chunks.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
		expect(await env.OAUTH_KV.get("sux:mail:semantic")).toBeTruthy(); // persisted for the next call
	});

	it("a second call incrementally diffs via Email/changes instead of re-embedding the whole mailbox", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		// Now: e2 was created since s1; nothing destroyed.
		mockBatch({
			"Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: ["e2"], updated: [], destroyed: [] }],
			"Email/get": (a) => ["Email/get", { list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
		// Only e2's text was embedded on the incremental pass — not e1 again.
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild + 1);
		expect(env.AI.run.mock.calls[embedCallsAfterBuild][1].text).toEqual(["Newsletter\nweekly digest"]);
	});

	it("drops a destroyed id from the cached chunk set without re-embedding anything", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1", "e2"], total: 2 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		mockBatch({ "Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: [], updated: [], destroyed: ["e1"] }] });
		const idx2 = await mailSemanticIndex(env);
		expect(idx2?.chunks.map((c) => c.id)).toEqual(["e2"]);
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild); // nothing new to embed
	});

	it("falls back to a full rebuild when the server can no longer diff from the cached state (cannotCalculateChanges)", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);

		let queryCalledAgain = false;
		mockBatch({
			"Email/changes": () => ["error", { type: "cannotCalculateChanges" }],
			"Email/query": () => {
				queryCalledAgain = true;
				return ["Email/query", { ids: ["e1", "e2"], total: 2 }];
			},
			"Email/get": (a) => ["Email/get", { state: "s2", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		expect(queryCalledAgain).toBe(true);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
	});

	it("a transport failure during the incremental leg also falls back to a full rebuild rather than throwing", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);

		run.mockImplementationOnce(async () => errR("[upstream_error] JMAP server error (500)."));
		mockBatch({
			// mockImplementationOnce above answers the FIRST call (Email/changes) with a transport error;
			// mockBatch below re-installs the implementation for every call AFTER that one.
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		expect(idx2).toBeTruthy(); // recovered via full rebuild instead of throwing
	});

	it("topKMailByCosine ranks by cosine similarity and skips chunks with no embedding", () => {
		const chunks = [
			{ id: "a", subject: "s", from: "f", receivedAt: "r", text: "t", embedding: [1, 0, 0] },
			{ id: "b", subject: "s", from: "f", receivedAt: "r", text: "t", embedding: [0, 1, 0] },
			{ id: "c", subject: "s", from: "f", receivedAt: "r", text: "t", embedding: [] },
		];
		const hits = topKMailByCosine([1, 0, 0], chunks, 5);
		expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
		expect(hits[0].score).toBeCloseTo(1);
	});
});
