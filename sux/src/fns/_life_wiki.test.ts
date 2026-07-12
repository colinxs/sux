import { describe, expect, it, vi } from "vitest";
import { FACETS, hasLifeWiki, renderFacetNote, renderIndex, renderLlms, runLifeWiki, SANDBOX_DIR, wikiPath, type LifeWikiDeps } from "./_life_wiki";

const envWith = (flags: Record<string, string | undefined> = {}) => ({ ...flags }) as any;

// A deps double that records every write path — the load-bearing spy for the two safety
// guarantees: dormancy (write is NEVER called when disabled) and sandbox-only (every path
// ever handed to write is under SANDBOX_DIR).
const mkDeps = (recallImpl?: LifeWikiDeps["recall"]): LifeWikiDeps & { writes: Array<{ path: string; content: string }>; recalled: ReturnType<typeof vi.fn> } => {
	const writes: Array<{ path: string; content: string }> = [];
	const recalled = vi.fn(recallImpl ?? (async () => ({ answer: "You know person A [vault:People.md].", citations: ["vault:People.md"], sources: { vault: "1 hit(s)" } })));
	return { recall: recalled as unknown as LifeWikiDeps["recall"], write: async (_e, path, content) => void writes.push({ path, content }), writes, recalled };
};

describe("gate — fail-closed", () => {
	it("hasLifeWiki is off unless LIFE_WIKI_ENABLED is truthy", () => {
		expect(hasLifeWiki(envWith())).toBe(false);
		expect(hasLifeWiki(envWith({ LIFE_WIKI_ENABLED: "" }))).toBe(false);
		expect(hasLifeWiki(envWith({ LIFE_WIKI_ENABLED: "0" }))).toBe(false);
		expect(hasLifeWiki(envWith({ LIFE_WIKI_ENABLED: "false" }))).toBe(false);
		expect(hasLifeWiki(envWith({ LIFE_WIKI_ENABLED: "off" }))).toBe(false);
		expect(hasLifeWiki(envWith({ LIFE_WIKI_ENABLED: "1" }))).toBe(true);
		expect(hasLifeWiki(envWith({ LIFE_WIKI_ENABLED: "true" }))).toBe(true);
	});
});

describe("wikiPath — sandbox choke point (non-destructive by construction)", () => {
	it("prefixes the sandbox dir for legitimate relative paths", () => {
		expect(wikiPath("People.md")).toBe(`${SANDBOX_DIR}/People.md`);
		expect(wikiPath("sub/Note.md")).toBe(`${SANDBOX_DIR}/sub/Note.md`);
		expect(wikiPath("llms.txt")).toBe(`${SANDBOX_DIR}/llms.txt`);
	});
	it("REFUSES any path that could escape the sandbox or hit repo/vault infra", () => {
		const bad = ["../secret.md", "../../etc/passwd", "/absolute.md", "a/../../b.md", "./People.md", ".obsidian/config", "a/.hidden/x.md", "", "   ", "a/\0/b"];
		for (const p of bad) expect(() => wikiPath(p), `expected refusal for '${p}'`).toThrow();
	});
	it("every resolved path stays strictly under the sandbox prefix", () => {
		for (const p of ["People.md", "deep/nested/note.md", "index.md"]) {
			expect(wikiPath(p).startsWith(`${SANDBOX_DIR}/`)).toBe(true);
			expect(wikiPath(p).includes("..")).toBe(false);
		}
	});
});

describe("runLifeWiki — dormancy", () => {
	it("is a total no-op when LIFE_WIKI_ENABLED is unset: no recall, NO writes", async () => {
		const deps = mkDeps();
		const report = await runLifeWiki(envWith(), {}, deps);
		expect(report.dormant).toBe(true);
		expect(report.written).toBe(0);
		expect(report.generated).toBe(0);
		expect(deps.writes).toHaveLength(0);
		expect(deps.recalled).not.toHaveBeenCalled();
	});
	it("stays dormant even when explicitly disabled with '0'", async () => {
		const deps = mkDeps();
		await runLifeWiki(envWith({ LIFE_WIKI_ENABLED: "0" }), {}, deps);
		expect(deps.writes).toHaveLength(0);
		expect(deps.recalled).not.toHaveBeenCalled();
	});
});

describe("runLifeWiki — armed synthesis writes ONLY inside the sandbox", () => {
	const enabled = envWith({ LIFE_WIKI_ENABLED: "1" });

	it("writes every facet note + index + llms.txt, all sandbox-fenced", async () => {
		const deps = mkDeps();
		const report = await runLifeWiki(enabled, {}, deps);
		// one write per facet, plus index.md and llms.txt
		expect(deps.writes).toHaveLength(FACETS.length + 2);
		for (const w of deps.writes) {
			expect(w.path.startsWith(`${SANDBOX_DIR}/`), `escaped sandbox: ${w.path}`).toBe(true);
			expect(w.path.includes("..")).toBe(false);
		}
		expect(report.generated).toBe(FACETS.length);
		expect(report.index).toBe(`${SANDBOX_DIR}/index.md`);
		expect(report.llms).toBe(`${SANDBOX_DIR}/llms.txt`);
		expect(deps.writes.some((w) => w.path === `${SANDBOX_DIR}/llms.txt`)).toBe(true);
	});

	it("dry_run synthesizes but writes NOTHING", async () => {
		const deps = mkDeps();
		const report = await runLifeWiki(enabled, { dry_run: true }, deps);
		expect(report.dry_run).toBe(true);
		expect(report.generated).toBe(FACETS.length);
		expect(report.written).toBe(0);
		expect(deps.writes).toHaveLength(0);
		expect(deps.recalled).toHaveBeenCalledTimes(FACETS.length);
	});

	it("regenerates only the requested facets", async () => {
		const deps = mkDeps();
		await runLifeWiki(enabled, { facets: ["people"] }, deps);
		// people note + index + llms
		expect(deps.writes.map((w) => w.path)).toContain(`${SANDBOX_DIR}/People.md`);
		expect(deps.writes.some((w) => w.path === `${SANDBOX_DIR}/Health.md`)).toBe(false);
		expect(deps.recalled).toHaveBeenCalledTimes(1);
	});

	it("a failing facet is isolated — it doesn't abort the run or block the others", async () => {
		let n = 0;
		const deps = mkDeps(async () => {
			n++;
			if (n === 1) throw new Error("recall blew up");
			return { answer: "ok", citations: [], sources: {} };
		});
		const report = await runLifeWiki(enabled, {}, deps);
		expect(report.facets[0].error).toContain("recall blew up");
		expect(report.generated).toBe(FACETS.length - 1);
		// the surviving facets + index + llms still wrote (and none escaped the sandbox)
		expect(deps.writes.length).toBe(FACETS.length - 1 + 2);
		for (const w of deps.writes) expect(w.path.startsWith(`${SANDBOX_DIR}/`)).toBe(true);
	});

	it("writes no index when nothing synthesized (all facets fail)", async () => {
		const deps = mkDeps(async () => {
			throw new Error("down");
		});
		const report = await runLifeWiki(enabled, {}, deps);
		expect(report.generated).toBe(0);
		expect(report.written).toBe(0);
		expect(deps.writes).toHaveLength(0);
		expect(report.index).toBeUndefined();
	});
});

describe("rendering — pure, human + robot shapes", () => {
	const res = FACETS.map((f) => ({ slug: f.slug, title: f.title, file: f.file, answer: `About ${f.title} [vault:x.md].`, citations: ["vault:x.md"], sourceStatus: { vault: "1 hit(s)" } }));

	it("facet note carries frontmatter, the answer, and its citations", () => {
		const note = renderFacetNote(FACETS[0], { answer: "Person A is my sister [vault:People.md].", citations: ["vault:People.md"] });
		expect(note).toContain("type: life-wiki");
		expect(note).toContain("Person A is my sister");
		expect(note).toContain("`vault:People.md`");
	});
	it("facet note degrades gracefully with no material", () => {
		expect(renderFacetNote(FACETS[0], { answer: "", citations: [] })).toContain("Nothing found for this facet yet");
	});
	it("human index links every facet", () => {
		const idx = renderIndex(res);
		expect(idx).toContain("What sux knows about my life");
		for (const f of FACETS) expect(idx).toContain(f.title);
	});
	it("robot llms.txt is a compact map with sandbox paths + summaries", () => {
		const llms = renderLlms(res);
		expect(llms).toContain("robot index");
		for (const f of FACETS) {
			expect(llms).toContain(`[${f.slug}]`);
			expect(llms).toContain(`${SANDBOX_DIR}/${f.file}`);
		}
	});
});
