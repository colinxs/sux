import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recall composes obsidian/search/jmap — mock them (each has its own suite) so we test
// recall's fan-out, graceful degrade, citation collection, and untrusted-fenced synthesis.
vi.mock("./obsidian", () => ({ obsidian: { run: vi.fn() } }));
vi.mock("./search", () => ({ search: { run: vi.fn() } }));
vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));
vi.mock("./_dropbox-full", () => ({ hasDropboxFull: vi.fn(() => false), searchFull: vi.fn(), readFull: vi.fn() }));

import { recall } from "./recall";
import { obsidian } from "./obsidian";
import { search } from "./search";
import { jmap } from "./jmap";
import { hasDropboxFull, readFull, searchFull } from "./_dropbox-full";

const okR = (text: string) => ({ content: [{ type: "text", text }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const parse = (r: any) => JSON.parse(r.content[0].text);

const obs = obsidian.run as unknown as ReturnType<typeof vi.fn>;
const web = search.run as unknown as ReturnType<typeof vi.fn>;
const mail = jmap.run as unknown as ReturnType<typeof vi.fn>;
const dbxHas = hasDropboxFull as unknown as ReturnType<typeof vi.fn>;
const dbxSearch = searchFull as unknown as ReturnType<typeof vi.fn>;
const dbxRead = readFull as unknown as ReturnType<typeof vi.fn>;

let aiRun: ReturnType<typeof vi.fn>;
const env = () => ({ AI: { run: aiRun } }) as any;
const noAiEnv = () => ({}) as any;

beforeEach(() => {
	aiRun = vi.fn(async () => ({ response: "Your oncologist is Dr. Chen and the next scan is in March [mail:Scan]; appointments are Tuesdays [vault:Areas/Health.md]." }));
	// Vault: search → one hit; read → the note body.
	obs.mockImplementation(async (_e: any, a: any) =>
		a.action === "search" ? okR(JSON.stringify({ hits: [{ path: "Areas/Health.md" }] })) : okR("Dr. Chen is my oncologist. Appointments are Tuesdays."),
	);
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
		const out = parse(await recall.run(env(), { question: "who is my oncologist?" }));
		expect(out.answer).toContain("Dr. Chen");
		expect(out.sources).toMatchObject({ vault: "1 hit(s)", mail: "1 hit(s)", web: "1 hit(s)" });
		expect(out.citations).toEqual(expect.arrayContaining(["vault:Areas/Health.md", "mail:Scan", "web"]));
		// The untrusted material was fenced (llm() wraps the user arg) and the question rode the system role.
		const [system, user] = aiRun.mock.calls[0][1].messages.map((m: any) => m.content);
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
		obs.mockResolvedValue(okR(JSON.stringify({ hits: [] })));
		mail.mockResolvedValue(okR(JSON.stringify({ methodResponses: [["Email/get", { list: [] }, "g"]] })));
		web.mockResolvedValue(okR("(no results)"));
		const out = parse(await recall.run(env(), { question: "obscure thing" }));
		expect(out.answer).toContain("couldn't find anything");
		expect(out.citations).toEqual([]);
		expect(aiRun).not.toHaveBeenCalled();
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

	it("honors the sources filter (personal-only skips the web)", async () => {
		await recall.run(env(), { question: "oncologist?", sources: ["vault", "mail"] });
		expect(web).not.toHaveBeenCalled();
		expect(obs).toHaveBeenCalled();
		expect(mail).toHaveBeenCalled();
	});

	it("strips OBSIDIAN_VAULT_DIR from search-hit paths before reading (no double-prefix 404)", async () => {
		obs.mockImplementation(async (_e: any, a: any) => (a.action === "search" ? okR(JSON.stringify({ hits: [{ path: "notes/Areas/Health.md" }] })) : okR("Dr. Chen is my oncologist.")));
		const dirEnv = { AI: { run: aiRun }, OBSIDIAN_VAULT_DIR: "notes" } as any;
		const out = parse(await recall.run(dirEnv, { question: "oncologist?", sources: ["vault"] }));
		const readCall = obs.mock.calls.find((c: any) => c[1].action === "read");
		expect(readCall?.[1].path).toBe("Areas/Health.md"); // vault-relative, not the double-prefixed repo path
		expect(out.sources.vault).toBe("1 hit(s)"); // vault contributed rather than being silently dropped
	});
});
