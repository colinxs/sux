import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recall composes obsidian/search/jmap — mock them (each has its own suite) so we test
// recall's fan-out, graceful degrade, citation collection, and untrusted-fenced synthesis.
// The git-backend vault leg now goes through _vault_semantic.ts's real vaultHead/vaultCfg
// (unmocked) to exercise the actual wiring — only obsidian.run (list/read/search) is a mock,
// same pattern vault-mcp.test.ts uses for vault_semantic. vaultHead's GitHub ref lookup rides
// smartFetch, so that's mocked too (routes.handler answers it).
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response) }));
vi.mock("../proxy", () => ({ smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)) }));
vi.mock("./obsidian", async () => {
	const actual = await vi.importActual<any>("./obsidian");
	return { ...actual, obsidian: { run: vi.fn() } };
});
vi.mock("./web_search", () => ({ webSearch: { run: vi.fn() }, defaultEngine: vi.fn(() => "ddg") }));
vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));
vi.mock("./imessage", () => ({ imessage: { run: vi.fn() }, hasImessage: vi.fn(() => false) }));
vi.mock("./_dropbox-full", () => ({ hasDropboxFull: vi.fn(() => false), searchFull: vi.fn(), readFull: vi.fn(), listFullChanges: vi.fn() }));
// Keep parseICal real (recall parses the ical reportObjects returns) — mock only the CalDAV I/O + the gate.
vi.mock("./_caldav", async () => {
	const actual = await vi.importActual<any>("./_caldav");
	return { ...actual, hasCalDav: vi.fn(() => false), listCalendars: vi.fn(), reportObjects: vi.fn() };
});

import { gatherRecall, recall } from "./recall";
import { obsidian } from "./obsidian";
import { webSearch } from "./web_search";
import { jmap } from "./jmap";
import { hasImessage, imessage } from "./imessage";
import { hasDropboxFull, listFullChanges, readFull, searchFull } from "./_dropbox-full";
import { hasCalDav, listCalendars, reportObjects } from "./_caldav";

const okR = (text: string) => ({ content: [{ type: "text", text }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const parse = (r: any) => JSON.parse(r.content[0].text);

const obs = obsidian.run as unknown as ReturnType<typeof vi.fn>;
const web = webSearch.run as unknown as ReturnType<typeof vi.fn>;
const mail = jmap.run as unknown as ReturnType<typeof vi.fn>;
const dbxHas = hasDropboxFull as unknown as ReturnType<typeof vi.fn>;
const dbxSearch = searchFull as unknown as ReturnType<typeof vi.fn>;
const dbxRead = readFull as unknown as ReturnType<typeof vi.fn>;
const dbxListChanges = listFullChanges as unknown as ReturnType<typeof vi.fn>;
const calHas = hasCalDav as unknown as ReturnType<typeof vi.fn>;
const calList = listCalendars as unknown as ReturnType<typeof vi.fn>;
const calReport = reportObjects as unknown as ReturnType<typeof vi.fn>;
const imgHas = hasImessage as unknown as ReturnType<typeof vi.fn>;
const img = imessage.run as unknown as ReturnType<typeof vi.fn>;

// A KV-backed HEAD sha for the git-backend semantic vault leg (vaultHead → smartFetch → this route).
const HEAD = "head-1";

let aiRun: ReturnType<typeof vi.fn>;
let kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
const env = () => ({ AI: { run: aiRun }, OAUTH_KV: kv, OBSIDIAN_VAULT_REPO: "me/vault" }) as any;
const noAiEnv = () => ({}) as any;

beforeEach(() => {
	const store = new Map<string, string>();
	kv = {
		get: vi.fn(async (k: string) => store.get(k) ?? null),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({ keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true as const })),
	};
	routes.handler = (url: string) => (url.includes("/git/ref/heads/") ? new Response(JSON.stringify({ object: { sha: HEAD } }), { status: 200 }) : new Response(JSON.stringify({ message: "not needed by this test" }), { status: 404 }));
	// AI.run answers embeddings ({data}) for the embed model (query AND the vault's chunks all
	// score identically, so a single note surfaces as one hit) and synthesis ({response}) for text.
	aiRun = vi.fn(async (model: string, inputs: any) =>
		model.includes("bge")
			? { data: (inputs.text as string[]).map(() => [1, 0, 0]) }
			: { response: "Your oncologist is Dr. Chen and the next scan is in March [mail:Scan]; appointments are Tuesdays [vault:Areas/Health.md]." },
	);
	// Vault: list → one note; read → the note body; search (remote-backend path) → one hit.
	obs.mockImplementation(async (_e: any, a: any) => {
		if (a.action === "list") return okR(JSON.stringify({ notes: ["Areas/Health.md"] }));
		if (a.action === "search") return okR(JSON.stringify({ hits: [{ path: "Areas/Health.md" }] }));
		return okR("Dr. Chen is my oncologist. Appointments are Tuesdays.");
	});
	mail.mockResolvedValue(okR(JSON.stringify({ methodResponses: [["Email/get", { list: [{ id: "e1", subject: "Scan", from: [{ email: "chen@clinic.com" }], receivedAt: "2026-03-01", preview: "next scan in March" }] }, "g"]] })));
	web.mockResolvedValue(okR("1. Oncology scans — https://ex.com — what to expect from a scan"));
});
afterEach(() => vi.clearAllMocks());

describe("recall", () => {
	it("requires a question", async () => {
		const r = await recall.run(env(), {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
	});

	it("needs the AI binding", async () => {
		const r = await recall.run(noAiEnv(), { question: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
	});

	it("fans out across vault+mail+web, cites, and synthesizes one answer", async () => {
		// web is opt-in (not a default source), so request it explicitly here.
		const out = parse(await recall.run(env(), { question: "who is my oncologist?", sources: ["vault", "mail", "web"] }));
		expect(out.answer).toContain("Dr. Chen");
		expect(out.sources).toMatchObject({ vault: "1 hit(s)", mail: "1 hit(s)", web: "1 hit(s)" });
		expect(out.citations).toEqual(expect.arrayContaining(["vault:Areas/Health.md", "mail:Scan", "web"]));
		// The untrusted material was fenced (llm() wraps the user arg) and the question rode the system role.
		// The vault leg embeds first (query + note chunks), so find the synthesis call by model, not index 0.
		const synthCall = aiRun.mock.calls.find((c: any) => !String(c[0]).includes("bge"))!;
		const [system, user] = synthCall[1].messages.map((m: any) => m.content);
		expect(system).toContain("who is my oncologist?");
		expect(user).toContain("<<<DATA>>>");
		expect(user).toContain("Dr. Chen is my oncologist"); // the vault note body is in the fenced data
	});

	it("degrades gracefully when a source is unavailable", async () => {
		mail.mockResolvedValue(errR("[not_configured] Fastmail JMAP not configured."));
		const out = parse(await recall.run(env(), { question: "oncologist?" }));
		expect(out.sources.mail).toContain("unavailable");
		expect(out.sources.mail).not.toContain("[not_configured]"); // code prefix stripped
		expect(out.sources.vault).toBe("1 hit(s)");
		expect(out.answer).toContain("Dr. Chen"); // still answers from the reachable stores
	});

	it("says so (and skips the LLM) when nothing matches", async () => {
		obs.mockImplementation(async (_e: any, a: any) => (a.action === "list" ? okR(JSON.stringify({ notes: [] })) : okR(JSON.stringify({ hits: [] }))));
		mail.mockResolvedValue(okR(JSON.stringify({ methodResponses: [["Email/get", { list: [] }, "g"]] })));
		web.mockResolvedValue(okR("(no results)"));
		const out = parse(await recall.run(env(), { question: "obscure thing" }));
		expect(out.answer).toContain("couldn't find anything");
		expect(out.citations).toEqual([]);
		// The embed model may still be called to rank an empty vault/learned set, but the
		// (expensive) text-synthesis model must never run when nothing was gathered.
		expect(aiRun.mock.calls.some((c) => !String(c[0]).includes("bge"))).toBe(false);
	});

	it("adds files (Mode B) as a source when configured: inlines a small text hit, cites [files:…]", async () => {
		dbxHas.mockReturnValue(true);
		dbxSearch.mockResolvedValue({ matches: [{ path: "/Health/labs.md", size: 400, modified: "2026-02-01" }, { path: "/Health/scan.pdf", size: 9_000_000 }] });
		dbxRead.mockResolvedValue({ path: "/Health/labs.md", text: "CA-125 trending down per Dr. Chen." });
		const out = parse(await recall.run(env(), { question: "labs?", sources: ["files"] }));
		expect(dbxSearch).toHaveBeenCalled();
		expect(dbxRead).toHaveBeenCalledTimes(1); // only the small .md is read; the 9MB pdf is cited by handle, not inlined
		expect(out.sources.files).toBe("2 hit(s)");
		expect(out.citations).toEqual(expect.arrayContaining(["files:/Health/labs.md", "files:/Health/scan.pdf"]));
		const user = aiRun.mock.calls[0][1].messages[1].content;
		expect(user).toContain("CA-125 trending down"); // the small text file's content rode the fenced data
		expect(user).toContain("[files:/Health/scan.pdf]"); // the pdf is cited by handle (metadata only) — never read/inlined
	});

	it("files source degrades to nothing when Mode B is unconfigured", async () => {
		dbxHas.mockReturnValue(false);
		const out = parse(await recall.run(env(), { question: "labs?", sources: ["files", "vault"] }));
		expect(dbxSearch).not.toHaveBeenCalled();
		expect(out.sources.files).toBe("no matches");
		expect(out.sources.vault).toBe("1 hit(s)"); // the other source still answers
	});

	it("files' semantic leg (_files_semantic.ts) merges in a hit the keyword search (searchFull) missed", async () => {
		dbxHas.mockReturnValue(true);
		dbxSearch.mockResolvedValue({ matches: [] }); // keyword search finds nothing
		dbxListChanges.mockResolvedValue({ entries: [{ ".tag": "file", kind: "file", name: "labs.md", path: "/Health/labs.md", size: 500 }], deleted: [], has_more: false, cursor: "c1" });
		dbxRead.mockResolvedValue({ path: "/Health/labs.md", text: "CA-125 trending down per Dr. Chen." });
		// Keyword-shaped embeddings so the semantic hit ranks unambiguously (mirrors the git-backend
		// vault_semantic test's embedVec pattern).
		aiRun = vi.fn(async (model: string, inputs: any) => {
			if (!model.includes("bge")) return { response: "labs note [files:/Health/labs.md]." };
			const embedVec = (t: string) => [t.toLowerCase().includes("labs") || t.toLowerCase().includes("ca-125") ? 1 : 0, 0.1];
			return { data: (inputs.text as string[]).map(embedVec) };
		});
		const out = parse(await recall.run(env(), { question: "labs?", sources: ["files"] }));
		expect(dbxListChanges).toHaveBeenCalled(); // the semantic index was built (no keyword hits to short-circuit it)
		expect(dbxRead).toHaveBeenCalledWith(expect.anything(), "/Health/labs.md");
		expect(out.sources.files).toBe("1 hit(s)");
		expect(out.citations).toEqual(["files:/Health/labs.md"]);
		const user = aiRun.mock.calls.find((c: any) => !String(c[0]).includes("bge"))![1].messages[1].content;
		expect(user).toContain("CA-125 trending down"); // the semantic hit's text rode the fenced data
	});

	it("files' semantic leg is never attempted when hasAI(env) is false — the keyword leg's result stands alone", async () => {
		dbxHas.mockReturnValue(true);
		dbxSearch.mockResolvedValue({ matches: [] });
		const out = await gatherRecall({} as any, "labs?", ["files"]);
		expect(dbxSearch).toHaveBeenCalled(); // the keyword leg has no AI gate — it still ran
		expect(dbxListChanges).not.toHaveBeenCalled(); // but the semantic leg (gated on hasAI) never touched Dropbox
		expect(out.status.files).toBe("no matches");
	});

	it("honors the sources filter (personal-only skips the web)", async () => {
		await recall.run(env(), { question: "oncologist?", sources: ["vault", "mail"] });
		expect(web).not.toHaveBeenCalled();
		expect(obs).toHaveBeenCalled();
		expect(mail).toHaveBeenCalled();
	});

	it("web is NOT a default source without free Kagi (KAGI_SESSION unset)", async () => {
		const out = parse(await recall.run(env(), { question: "oncologist?" })); // no sources → defaults
		expect(web).not.toHaveBeenCalled(); // web stays opt-in so recall never bills a search
		expect(out.sources.web).toBeUndefined();
	});

	it("web IS a default source when free Kagi is configured (KAGI_SESSION set)", async () => {
		const freeEnv = { AI: { run: aiRun }, KAGI_SESSION: "tok" } as any;
		const out = parse(await recall.run(freeEnv, { question: "oncologist?" })); // no sources → defaults include web
		expect(web).toHaveBeenCalled();
		expect(out.sources.web).toBe("1 hit(s)");
		expect(out.citations).toContain("web");
	});

	// A Map-backed OAUTH_KV seeded with a taught example, plus an embed-aware AI.run so the
	// `learned` source (fromLearned → listExamples + embedOne + kNN) can be exercised.
	function learnedEnv(examples: Array<{ id: string; label: string; input: string; embedding: number[] }>, queryVec: number[]) {
		const store = new Map<string, string>();
		for (const e of examples) store.set(`sux:learn:example:${e.id}`, JSON.stringify({ ...e, batch: e.id, ts: 1 }));
		const kv = {
			get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
			put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
			delete: vi.fn(async (k: string) => void store.delete(k)),
			list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({ keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true as const })),
		};
		// AI.run answers embeddings ({data}) for the embed model and synthesis ({response}) for text.
		const run = vi.fn(async (model: string, inputs: any) => (model.includes("bge") ? { data: (inputs.text as string[]).map(() => queryVec) } : { response: "From what you taught me [learned:vip]." }));
		return { env: { AI: { run }, OAUTH_KV: kv } as any, run };
	}

	it("adds `learned` as a 5th source — kNN over the taught set surfaces the nearest label, cited [learned:…]", async () => {
		const { env } = learnedEnv([{ id: "x1", label: "vip", input: "escalate anything from the board", embedding: [1, 0, 0] }], [1, 0, 0]);
		const out = parse(await recall.run(env, { question: "how do I handle board mail?", sources: ["learned"] }));
		expect(out.sources.learned).toBe("1 hit(s)");
		expect(out.citations).toEqual(expect.arrayContaining(["learned:vip"]));
		expect(out.answer).toContain("learned:vip");
	});

	it("`learned` degrades to 'no matches' (not 'unavailable') when nothing has been taught", async () => {
		// No OAUTH_KV → listExamples returns [] → the source degrades quietly, mirroring fromFiles-unconfigured.
		const out = parse(await recall.run(env(), { question: "anything?", sources: ["learned", "vault"] }));
		expect(out.sources.learned).toBe("no matches");
		expect(out.sources.vault).toBe("1 hit(s)"); // the other source still answers
	});

	// A Map-backed OAUTH_KV seeded with oracle KBs (sux:oracle:<topic> → StoredKb JSON), plus an
	// AI.run that echoes a citation, so the `oracle` source (fromOracle → list + get + distilled) runs.
	function oracleEnv(kbs: Array<{ topic: string; distilled: string }>) {
		const store = new Map<string, string>();
		for (const kb of kbs) store.set(`sux:oracle:${kb.topic}`, JSON.stringify({ distilled: kb.distilled, chunks: [], sources: [], updated_at: 1 }));
		const kv = {
			get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
			put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
			delete: vi.fn(async (k: string) => void store.delete(k)),
			list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({ keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true as const })),
		};
		const run = vi.fn(async () => ({ response: "Rebasing keeps history linear [oracle:git-workflow]." }));
		return { AI: { run }, OAUTH_KV: kv } as any;
	}

	it("adds `oracle` as a 6th source — inlines each topic's distilled KB, cited [oracle:topic]", async () => {
		const env = oracleEnv([{ topic: "git-workflow", distilled: "Rebase onto main; never merge main back in." }]);
		const out = parse(await recall.run(env, { question: "how do we update a branch?", sources: ["oracle"] }));
		expect(out.sources.oracle).toBe("1 hit(s)");
		expect(out.citations).toEqual(expect.arrayContaining(["oracle:git-workflow"]));
		const user = (env.AI.run as any).mock.calls[0][1].messages[1].content;
		expect(user).toContain("[oracle:git-workflow]");
		expect(user).toContain("Rebase onto main"); // the distilled KB rode the fenced data
	});

	it("`oracle` degrades to 'no matches' when no KBs exist / no KV binding", async () => {
		const out = parse(await recall.run(env(), { question: "anything?", sources: ["oracle", "vault"] }));
		expect(out.sources.oracle).toBe("no matches"); // env() has no OAUTH_KV → quiet degrade, not "unavailable"
		expect(out.sources.vault).toBe("1 hit(s)");
	});

	it("uses the REMOTE backend for vault search when OBSIDIAN_REMOTE_URL/KEY are set (git can't search a private repo)", async () => {
		const backends: string[] = [];
		obs.mockImplementation(async (_e: any, a: any) => {
			backends.push(a.backend);
			return a.action === "search" ? okR(JSON.stringify({ hits: [{ path: "Areas/Health.md" }] })) : okR("Dr. Chen is my oncologist.");
		});
		const remoteEnv = { AI: { run: aiRun }, OBSIDIAN_REMOTE_URL: "https://vault.ts.net", OBSIDIAN_REMOTE_KEY: "k" } as any;
		const out = parse(await recall.run(remoteEnv, { question: "oncologist?", sources: ["vault"] }));
		expect(backends).toContain("remote");
		expect(backends.every((b) => b === "remote")).toBe(true); // search AND read hit the live vault, not dead git code-search
		expect(out.sources.vault).toBe("1 hit(s)");
	});

	it("falls back to the local semantic index when the REMOTE backend is configured but errors at runtime (#1121)", async () => {
		obs.mockImplementation(async (_e: any, a: any) => {
			if (a.backend === "remote") throw new Error("HTTP 502"); // sleeping/offline Tailscale Funnel
			if (a.action === "list") return okR(JSON.stringify({ notes: ["Areas/Health.md"] }));
			return okR("Dr. Chen is my oncologist.");
		});
		const remoteEnv = { ...env(), OBSIDIAN_REMOTE_URL: "https://vault.ts.net", OBSIDIAN_REMOTE_KEY: "k" } as any;
		const out = parse(await recall.run(remoteEnv, { question: "oncologist?", sources: ["vault"] }));
		expect(out.sources.vault).toBe("1 hit(s)"); // recovered via fromVaultSemantic, not "unavailable"
		expect(out.citations).toContain("vault:Areas/Health.md");
	});

	it("uses vault_semantic's cosine kNN (not lexical search) for the git-backend vault leg — GitHub code-search can't see a private repo", async () => {
		obs.mockImplementation(async (_e: any, a: any) => {
			if (a.action === "search") throw new Error("git backend must not lexically search — code-search returns nothing on a private repo");
			if (a.action === "list") return okR(JSON.stringify({ notes: ["Diet/plan.md", "Fitness/walk.md"] }));
			const body = a.path === "Diet/plan.md" ? "Avoid sodium above 1500mg daily." : "Walk for exercise thirty minutes.";
			return okR(body);
		});
		// Keyword-shaped embeddings so kNN ranking is testable (mirrors advise.test.ts's embedVec).
		aiRun = vi.fn(async (model: string, inputs: any) => {
			if (!model.includes("bge")) return { response: "sodium note [vault:Diet/plan.md]." };
			const embedVec = (t: string) => [t.toLowerCase().includes("sodium") ? 1 : 0, t.toLowerCase().includes("exercise") ? 1 : 0, 0.1];
			return { data: (inputs.text as string[]).map(embedVec) };
		});
		const out = parse(await recall.run(env(), { question: "how much sodium can I have", sources: ["vault"] }));
		expect(out.citations[0]).toBe("vault:Diet/plan.md"); // the sodium note ranks first by cosine similarity
	});

	const VEVENT = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:evt1",
		"SUMMARY:Oncology follow-up",
		"DTSTART:20260715T090000Z",
		"LOCATION:Chen Clinic",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	it("adds `calendar` — keyword-filters CalDAV events in the window and cites [calendar:…]", async () => {
		calHas.mockReturnValue(true);
		calList.mockResolvedValue([{ href: "/cal/personal/", name: "Personal", isTasks: false }, { href: "/cal/todo/", name: "Tasks", isTasks: true }]);
		calReport.mockResolvedValue([{ href: "/cal/personal/evt1.ics", etag: '"1"', ical: VEVENT }]);
		const out = parse(await recall.run(env(), { question: "when's my oncologist follow-up?", sources: ["calendar"] }));
		expect(calReport).toHaveBeenCalledTimes(1); // only the event calendar is queried, not the task list
		expect(out.sources.calendar).toBe("1 hit(s)");
		expect(out.citations).toEqual(expect.arrayContaining(["calendar:Oncology follow-up"]));
		const user = aiRun.mock.calls[0][1].messages[1].content;
		expect(user).toContain("[calendar:Oncology follow-up] on 2026-07-15T09:00:00Z @ Chen Clinic");
	});

	it("`calendar` drops events whose title/notes share no keyword with the question", async () => {
		calHas.mockReturnValue(true);
		calList.mockResolvedValue([{ href: "/cal/personal/", name: "Personal", isTasks: false }]);
		calReport.mockResolvedValue([{ href: "/cal/personal/evt1.ics", etag: '"1"', ical: VEVENT }]);
		const out = parse(await recall.run(env(), { question: "plumber appointment?", sources: ["calendar", "vault"] }));
		expect(out.sources.calendar).toBe("no matches"); // the oncology event doesn't match "plumber"
		expect(out.sources.vault).toBe("1 hit(s)");
	});

	it("`calendar` degrades to nothing when CalDAV is unconfigured (no PROPFIND/REPORT issued)", async () => {
		calHas.mockReturnValue(false);
		const out = parse(await recall.run(env(), { question: "oncologist follow-up?", sources: ["calendar", "vault"] }));
		expect(calList).not.toHaveBeenCalled();
		expect(calReport).not.toHaveBeenCalled();
		expect(out.sources.calendar).toBe("no matches");
		expect(out.sources.vault).toBe("1 hit(s)");
	});

	it("adds `contacts` — JMAP ContactCard query→get, cites [contact:…] with emails/phones (never the full card)", async () => {
		mail.mockResolvedValue(
			okR(JSON.stringify({ methodResponses: [["ContactCard/get", { list: [{ id: "c1", name: { full: "Dr. Chen" }, emails: { e: { address: "chen@clinic.com" } }, phones: { p: { number: "+15551234" } }, organizations: { o: { name: "Chen Clinic" } } }] }, "g"]] })),
		);
		const out = parse(await recall.run(env(), { question: "who is Dr. Chen?", sources: ["contacts"] }));
		expect(out.sources.contacts).toBe("1 hit(s)");
		expect(out.citations).toEqual(expect.arrayContaining(["contact:Dr. Chen"]));
		const user = aiRun.mock.calls[0][1].messages[1].content;
		expect(user).toContain("[contact:Dr. Chen] · Chen Clinic · chen@clinic.com · +15551234");
	});

	it("`contacts` degrades to 'unavailable' when the token isn't scoped for contacts", async () => {
		mail.mockResolvedValue(errR("[not_configured] Fastmail JMAP not configured."));
		const out = parse(await recall.run(env(), { question: "who?", sources: ["contacts", "vault"] }));
		expect(out.sources.contacts).toContain("unavailable");
		expect(out.sources.vault).toBe("1 hit(s)");
	});

	it("adds `imessage` (#849) — keyword-filters recent thread messages and cites [imessage:contact]", async () => {
		imgHas.mockReturnValue(true);
		img.mockImplementation(async (_e: any, a: any) => {
			if (a.action === "threads") return okR(JSON.stringify({ threads: [{ id: 1, contact: "+15551234", name: "Jeanne" }] }));
			if (a.action === "messages") return okR(JSON.stringify({ messages: [{ id: 1, from_me: false, text: "did the oncologist call you back?", at: "2026-07-10T10:00:00Z" }] }));
			return errR("unknown action");
		});
		const out = parse(await recall.run(env(), { question: "oncologist call", sources: ["imessage"] }));
		expect(out.sources.imessage).toBe("1 hit(s)");
		expect(out.citations).toEqual(["imessage:Jeanne"]);
		const user = aiRun.mock.calls.find((c: any) => !String(c[0]).includes("bge"))![1].messages[1].content;
		expect(user).toContain("did the oncologist call you back?");
	});

	it("`imessage` degrades to nothing when unconfigured (no IMESSAGE_URL/SECRET)", async () => {
		imgHas.mockReturnValue(false);
		const out = parse(await recall.run(env(), { question: "oncologist call", sources: ["imessage", "vault"] }));
		expect(img).not.toHaveBeenCalled();
		expect(out.sources.imessage).toBe("no matches");
		expect(out.sources.vault).toBe("1 hit(s)");
	});

	// WHITELISTED weighting — the `oracle` source surfaces studied (whitelisted) KBs, tags them
	// [whitelisted:topic], leads the synthesis input with them, and the prompt states the precedence.
	describe("whitelisted (study) material outranks web + model", () => {
		function kvWith(entries: Record<string, unknown>) {
			const store = new Map<string, string>(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
			return {
				get: vi.fn(async (k: string) => store.get(k) ?? null),
				list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({ keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true as const })),
			};
		}
		const kvEnv = (kv: any) => ({ AI: { run: aiRun }, OAUTH_KV: kv }) as any;

		it("tags a studied KB [whitelisted:topic] and leads the material with it (ahead of [web])", async () => {
			const kv = kvWith({
				"sux:oracle:dbt": { distilled: "DBT-FACT: opposite action for unjustified emotions.", chunks: ["c"], sources: ["book.pdf"], updated_at: 1, whitelist: { source: "book.pdf", kind: "pdf", via: "study", learned_at: 1 } },
				"sux:oracle:trivia": { distilled: "TRIVIA-FACT: plain oracle note.", chunks: ["c"], sources: ["x"], updated_at: 1 },
			});
			const out = parse(await recall.run(kvEnv(kv), { question: "how do I handle an unjustified urge?", sources: ["web", "oracle"] }));

			// Cited by tier: whitelisted vs plain oracle.
			expect(out.citations).toEqual(expect.arrayContaining(["whitelisted:dbt", "oracle:trivia"]));

			// The synthesis input leads with the whitelisted block — ahead of the plain oracle KB AND the web.
			const user = aiRun.mock.calls[0][1].messages[1].content as string;
			expect(user.indexOf("[whitelisted:dbt]")).toBeGreaterThanOrEqual(0);
			expect(user.indexOf("[whitelisted:dbt]")).toBeLessThan(user.indexOf("[web results]"));
			expect(user.indexOf("[whitelisted:dbt]")).toBeLessThan(user.indexOf("[oracle:trivia]"));

			// The system prompt states the precedence: whitelisted OUTRANKS own knowledge OUTRANKS web.
			const system = aiRun.mock.calls[0][1].messages[0].content as string;
			expect(system).toContain("SOURCE PRECEDENCE");
			expect(system).toContain("[whitelisted:*]");
			expect(system).toMatch(/OUTRANKS your own general knowledge/);
		});

		it("doesn't drag a non-whitelisted oracle topic bundled with a whitelisted one ahead of more relevant vault material (#1135)", async () => {
			const e = env();
			await e.OAUTH_KV.put("sux:oracle:dbt", JSON.stringify({ distilled: "DBT-FACT: opposite action for unjustified emotions.", chunks: ["c"], sources: ["book.pdf"], updated_at: 1, whitelist: { source: "book.pdf", kind: "pdf", via: "study", learned_at: 1 } }));
			await e.OAUTH_KV.put("sux:oracle:trivia", JSON.stringify({ distilled: "TRIVIA-FACT: unrelated plain oracle note.", chunks: ["c"], sources: ["x"], updated_at: 1 }));
			const out = await gatherRecall(e, "who is my oncologist?", ["vault", "oracle"]);
			const dbtIdx = out.materials.findIndex((m) => m.includes("[whitelisted:dbt]"));
			const vaultIdx = out.materials.findIndex((m) => m.includes("[vault:"));
			const triviaIdx = out.materials.findIndex((m) => m.includes("[oracle:trivia]"));
			expect(dbtIdx).toBeGreaterThanOrEqual(0);
			expect(vaultIdx).toBeGreaterThanOrEqual(0);
			expect(triviaIdx).toBeGreaterThanOrEqual(0);
			// Whitelisted still leads everything...
			expect(dbtIdx).toBeLessThan(vaultIdx);
			// ...but the unrelated plain topic bundled with it in the same fromOracle call no longer
			// rides ahead of the more relevant vault material just because they share one call.
			expect(vaultIdx).toBeLessThan(triviaIdx);
		});
	});
});
