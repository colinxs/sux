import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_CLOSE, DATA_OPEN } from "../ai";
import { ASSIMILATE_DURABLE_BYTES, assimDomain, assimilate, hasAssimilate } from "./_assimilate";
import { listChunks, topKPassages } from "./_source";

// The spine composes real legs end-to-end wherever vitest can carry them: the guarded llm()
// distill, _source.ts's chunk+embed+profile substrate, ocr's vision call, and putBlob/putPhi's
// R2 writes all run for real against stubbed AI/KV/R2 bindings (the study/oracle suite idiom).
// Only the bindings themselves are fakes — no spine internals are mocked.

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

/** A minimal R2 bucket (put/get/head) recording every written key. */
function makeR2() {
	const objects = new Map<string, Uint8Array>();
	return {
		objects,
		put: vi.fn(async (key: string, body: any) => {
			objects.set(key, body instanceof Uint8Array ? body : new Uint8Array());
			return {};
		}),
		get: vi.fn(async (key: string) => {
			const b = objects.get(key);
			return b ? { arrayBuffer: async () => b.buffer } : null;
		}),
		head: vi.fn(async (key: string) => (objects.has(key) ? {} : null)),
	};
}

/** env driving the REAL guarded llm()/embed()/ocr: AI.run answers by call shape (embed →
 *  vectors, vision → OCR text, messages → distill/profile by system prompt), toMarkdown
 *  transcribes pdf bytes. All spine writes land in the kv/r2 fakes for assertion. */
function makeEnv(opts: { enabled?: string | undefined; toMarkdown?: (docs: any[]) => Promise<any>; distill?: string; r2?: boolean } = {}) {
	const kv = makeKv();
	const r2 = makeR2();
	const run = vi.fn(async (_model: string, inputs: any) => {
		if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [1, 0, 0]) };
		if (inputs?.image) return { response: "OCR-TEXT from the scanned image." };
		const system: string = inputs.messages.find((m: any) => m.role === "system").content;
		if (/^You are distilling an AUTHORITATIVE/.test(system)) return { response: "PROFILE-SUMMARY" };
		return { response: opts.distill ?? "DISTILLED-NOTE about the document." };
	});
	const AI: any = { run };
	if (opts.toMarkdown) AI.toMarkdown = vi.fn(opts.toMarkdown);
	const env: any = { AI, OAUTH_KV: kv };
	if (opts.r2 !== false) env.R2 = r2;
	if ("enabled" in opts) {
		if (opts.enabled !== undefined) env.ASSIMILATE_ENABLED = opts.enabled;
	} else {
		env.ASSIMILATE_ENABLED = "1";
	}
	return { env, kv, r2, run, toMarkdown: AI.toMarkdown };
}

const textCalls = (run: ReturnType<typeof vi.fn>) => run.mock.calls.filter(([, inputs]: any) => (inputs as any)?.messages);

afterEach(() => vi.clearAllMocks());

describe("assimilate — fail-closed flag", () => {
	it("unset/'0'/'false'/'off' ⇒ disabled no-op: reports so, touches NOTHING", async () => {
		for (const enabled of [undefined, "0", "false", "off"]) {
			const { env, kv, r2, run } = makeEnv({ enabled });
			expect(hasAssimilate(env)).toBe(false);
			const r = await assimilate(env, { source: "inline", text: "secret material", kind: "text", domain: "doc" });
			expect(r.status).toBe("disabled");
			if (r.status === "disabled") expect(r.note).toMatch(/ASSIMILATE_ENABLED/);
			// Never half-runs: no model call, no KV write, no R2 write.
			expect(run).not.toHaveBeenCalled();
			expect(kv.put).not.toHaveBeenCalled();
			expect(r2.put).not.toHaveBeenCalled();
		}
	});

	it("'1' arms it", () => {
		expect(hasAssimilate(makeEnv().env)).toBe(true);
	});
});

describe("assimDomain — #1242 namespacing + the phi fence", () => {
	it("streams land under assim:*, medical/phi ALWAYS under phi:medical", () => {
		expect(assimDomain("scan")).toBe("assim:scan");
		expect(assimDomain("mail")).toBe("assim:mail");
		expect(assimDomain("doc")).toBe("assim:doc");
		expect(assimDomain("medical")).toBe("phi:medical");
		expect(assimDomain("doc", true)).toBe("phi:medical");
	});
});

describe("assimilate — text happy path", () => {
	it("distills through the guarded fence, indexes retrievable passages under assim:doc, refreshes the profile", async () => {
		const { env, kv, run } = makeEnv();
		const r = await assimilate(env, { source: "toss:note-1", text: "Renew the passport before the September trip.", kind: "text", domain: "doc" });

		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(r.domain).toBe("assim:doc");
		expect(r.distilled).toBe("DISTILLED-NOTE about the document.");
		expect(r.indexed.chunks).toBeGreaterThan(0);
		expect(r.indexed.skipped).toBeUndefined();
		// Text input has no original bytes — the archive leg degrades honestly, not fatally.
		expect(r.archived.skipped).toMatch(/no original bytes/);

		// The material rode the guarded llm() as fenced untrusted data, with oracle's distill
		// instruction in the trusted system role.
		const [[, inputs]] = textCalls(run);
		const system = (inputs as any).messages.find((m: any) => m.role === "system").content;
		const user = (inputs as any).messages.find((m: any) => m.role === "user").content;
		expect(system).toMatch(/^Extract and condense the KEY KNOWLEDGE/);
		expect(user).toContain(DATA_OPEN);
		expect(user).toContain(DATA_CLOSE);
		expect(user).toContain("Renew the passport");

		// Chunks are provenance-stamped and retrievable via the EXISTING _source.ts kNN.
		const chunks = await listChunks(env, "assim:doc");
		expect(chunks.length).toBe(r.indexed.chunks);
		expect(chunks[0]).toMatchObject({ domain: "assim:doc", title: "toss:note-1", authority: "contextual", source_id: r.source_id });
		const hits = topKPassages([1, 0, 0], chunks, 3);
		expect(hits[0].text).toContain("DISTILLED-NOTE");

		// The rolling-summary tier (distillProfile) refreshed alongside the detail tier.
		expect(kv.store.get("sux:profile:assim:doc")).toContain("PROFILE-SUMMARY");
	});
});

describe("assimilate — pdf happy path (the W2 acceptance round-trip)", () => {
	it("pdf bytes → toMarkdown → distillate + CAS blob + retrievable passages", async () => {
		const { env, kv, r2, toMarkdown } = makeEnv({ toMarkdown: async () => [{ data: "# Scanned lease agreement\nRent due on the 1st." }] });
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]); // %PDF…
		const r = await assimilate(env, { source: "/Scans/lease.pdf", bytes, kind: "pdf", domain: "scan" });

		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(toMarkdown).toHaveBeenCalledOnce();
		expect(r.distilled).toBe("DISTILLED-NOTE about the document.");

		// Original archived to the R2 CAS (cas/<sha256>) with a KV handle — dedup by content.
		expect(r.archived.r2_key).toMatch(/^cas\/[0-9a-f]{64}$/);
		expect(r.archived.sha256).toHaveLength(64);
		expect(r.archived.size).toBe(bytes.length);
		expect(r2.objects.has(r.archived.r2_key!)).toBe(true);

		// Passages land under assim:scan and rank via the existing kNN.
		const chunks = await listChunks(env, "assim:scan");
		expect(chunks.length).toBeGreaterThan(0);
		expect(topKPassages([1, 0, 0], chunks, 1)[0].text).toContain("DISTILLED-NOTE");
		// And nothing leaked into any sibling domain's keyspace.
		expect(await listChunks(env, "assim:doc")).toHaveLength(0);
		expect([...kv.store.keys()].filter((k) => k.startsWith("sux:source:chunk:phi:"))).toHaveLength(0);
	});

	it("image kind rides ocr's vision call", async () => {
		const { env } = makeEnv();
		const r = await assimilate(env, { source: "scan-42.png", bytes: new Uint8Array([9, 9, 9]), kind: "image", domain: "scan", contentType: "image/png" });
		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(r.archived.r2_key).toMatch(/^cas\//);
		expect((await listChunks(env, "assim:scan")).length).toBeGreaterThan(0);
	});
});

describe("assimilate — phi fence (#613)", () => {
	it("phi material indexes under phi:medical, archives under phi/, and NEVER mints a /s/ handle", async () => {
		const { env, kv, r2 } = makeEnv();
		// Seed a non-phi chunk first to prove isolation both ways.
		await assimilate(env, { source: "toss:plain", text: "Plain household note.", kind: "text", domain: "doc" });
		const storeHandlesBefore = [...kv.store.keys()].filter((k) => k.startsWith("store:")).length;

		const bytes = new Uint8Array([1, 2, 3, 4]);
		const r = await assimilate(env, { source: "mychart:lab-report.pdf", bytes, text: "Creatinine 1.1 mg/dL, within range.", kind: "text", domain: "medical" });
		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(r.domain).toBe("phi:medical");

		// Archive landed under the private phi/ prefix — no cas/ object, no public /s/ handle.
		expect(r.archived.r2_key).toMatch(/^phi\/assimilate\/[0-9a-f]{64}-/);
		expect([...r2.objects.keys()].filter((k) => k.startsWith("cas/"))).toHaveLength(0);
		expect([...kv.store.keys()].filter((k) => k.startsWith("store:")).length).toBe(storeHandlesBefore);

		// Index isolation: phi chunks under phi:medical only; assim:doc untouched by this call.
		const phiChunks = await listChunks(env, "phi:medical");
		expect(phiChunks.length).toBeGreaterThan(0);
		for (const c of phiChunks) expect(c.domain).toBe("phi:medical");
		const docChunks = await listChunks(env, "assim:doc");
		for (const c of docChunks) expect(c.title).toBe("toss:plain");
	});
});

describe("assimilate — one leg degrading never corrupts the others", () => {
	it("R2 unbound: archive skipped, distillate + index intact", async () => {
		const { env } = makeEnv({ r2: false });
		const r = await assimilate(env, { source: "s.pdf", bytes: new Uint8Array([1]), text: "material", kind: "text", domain: "doc" });
		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(r.archived.skipped).toMatch(/archive skipped/);
		expect(r.distilled).toBeTruthy();
		expect(r.indexed.chunks).toBeGreaterThan(0);
	});

	it("embed failure: index skipped, distillate + archive intact", async () => {
		const { env, r2, run } = makeEnv();
		run.mockImplementation(async (_model: string, inputs: any) => {
			if (Array.isArray(inputs?.text)) throw new Error("embedder melted");
			return { response: "DISTILLED-NOTE about the document." };
		});
		const r = await assimilate(env, { source: "s.pdf", bytes: new Uint8Array([1]), text: "material", kind: "text", domain: "doc" });
		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(r.indexed).toMatchObject({ chunks: 0 });
		expect(r.indexed.skipped).toMatch(/embedder melted/);
		expect(r.distilled).toBe("DISTILLED-NOTE about the document.");
		expect(r.archived.r2_key).toMatch(/^cas\//);
		expect(r2.objects.size).toBeGreaterThan(0);
	});

	it("profile-refresh failure only degrades the summary tier — chunks still land", async () => {
		const { env, run } = makeEnv();
		run.mockImplementation(async (_model: string, inputs: any) => {
			if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [1, 0, 0]) };
			const system: string = inputs.messages.find((m: any) => m.role === "system").content;
			if (/^You are distilling an AUTHORITATIVE/.test(system)) throw new Error("profile pass melted");
			return { response: "DISTILLED-NOTE about the document." };
		});
		const r = await assimilate(env, { source: "toss:x", text: "material", kind: "text", domain: "doc" });
		expect(r.status).toBe("assimilated");
		if (r.status !== "assimilated") return;
		expect(r.indexed.chunks).toBeGreaterThan(0);
		expect(r.indexed.skipped).toBeUndefined();
		expect((await listChunks(env, "assim:doc")).length).toBe(r.indexed.chunks);
	});
});

describe("assimilate — book-scale auto-route", () => {
	const bigPdf = () => new Uint8Array(ASSIMILATE_DURABLE_BYTES + 1);

	it("oversize pdf bytes route to the durable assimilate-pdfs workflow — automatic, no caller flag", async () => {
		const { env, run } = makeEnv();
		env.OP_WORKFLOW = { create: vi.fn(async () => ({ id: "wf-assim-1" })) };
		const r = await assimilate(env, { source: "book.pdf", bytes: bigPdf(), kind: "pdf", domain: "doc" });
		expect(r.status).toBe("routed_durable");
		if (r.status !== "routed_durable") return;
		expect(r.instanceId).toBe("wf-assim-1");
		expect(env.OP_WORKFLOW.create).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ opId: "assimilate-pdfs" }) }));
		// The one-entry zip input landed in the CAS store as the workflow's Handle…
		const handle = env.OP_WORKFLOW.create.mock.calls[0][0].params.input;
		expect(handle.r2Key).toMatch(/^cas\//);
		expect(handle.type).toBe("application/zip");
		// …and NO inline transcription/distill/index ran.
		expect(textCalls(run)).toHaveLength(0);
	});

	it("just-under-threshold bytes stay inline", async () => {
		const { env } = makeEnv({ toMarkdown: async () => [{ data: "small doc text" }] });
		env.OP_WORKFLOW = { create: vi.fn(async () => ({ id: "wf-never" })) };
		const r = await assimilate(env, { source: "small.pdf", bytes: new Uint8Array(64), kind: "pdf", domain: "doc" });
		expect(r.status).toBe("assimilated");
		expect(env.OP_WORKFLOW.create).not.toHaveBeenCalled();
	});

	it("PHI never routes durable — oversize phi input processes inline", async () => {
		const { env, toMarkdown } = makeEnv({ toMarkdown: async () => [{ data: "long medical record text" }] });
		env.OP_WORKFLOW = { create: vi.fn(async () => ({ id: "wf-never" })) };
		const r = await assimilate(env, { source: "records.pdf", bytes: bigPdf(), kind: "pdf", domain: "medical" });
		expect(r.status).toBe("assimilated");
		expect(env.OP_WORKFLOW.create).not.toHaveBeenCalled();
		expect(toMarkdown).toHaveBeenCalledOnce();
		if (r.status !== "assimilated") return;
		expect(r.domain).toBe("phi:medical");
		expect(r.archived.r2_key).toMatch(/^phi\//);
	});

	it("no OP_WORKFLOW binding: oversize input degrades to inline instead of failing", async () => {
		const { env } = makeEnv({ toMarkdown: async () => [{ data: "book text" }] });
		const r = await assimilate(env, { source: "book.pdf", bytes: bigPdf(), kind: "pdf", domain: "doc" });
		expect(r.status).toBe("assimilated");
	});
});

describe("assimilate — extract/distill failures fail the call (nothing to protect yet)", () => {
	it("empty text is an error", async () => {
		const { env } = makeEnv();
		await expect(assimilate(env, { source: "x", text: "   ", kind: "text", domain: "doc" })).rejects.toThrow(/non-empty/);
	});

	it("an empty distillation is an error, and no chunks land", async () => {
		const { env, run } = makeEnv();
		run.mockImplementation(async (_model: string, inputs: any) => {
			if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [1, 0, 0]) };
			return { response: "   " };
		});
		await expect(assimilate(env, { source: "x", text: "material", kind: "text", domain: "doc" })).rejects.toThrow(/empty note/);
		expect(await listChunks(env, "assim:doc")).toHaveLength(0);
	});

	it("missing AI binding is an error", async () => {
		const kv = makeKv();
		await expect(assimilate({ OAUTH_KV: kv, ASSIMILATE_ENABLED: "1" } as any, { source: "x", text: "t", kind: "text", domain: "doc" })).rejects.toThrow(/Workers AI/);
	});
});
