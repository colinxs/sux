import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./obsidian", () => ({ obsidian: { run: vi.fn() } }));

import { citation } from "./citation";
import { obsidian } from "./obsidian";

const okR = (text: string) => ({ content: [{ type: "text", text }] });
const parse = (r: any) => JSON.parse(r.content[0].text);
const obs = obsidian.run as unknown as ReturnType<typeof vi.fn>;
afterEach(() => vi.clearAllMocks());

const PAPER = { title: "On Quantum Supremacy", authors: ["Preskill, John", { family: "Chen", given: "Amy" }], year: 2019, doi: "10.1/x", container: "Nature", url: "https://ex.com/p" };

describe("citation.format (pure)", () => {
	it("renders BibTeX with a deterministic citekey, normalized authors, and journal→article", async () => {
		const out = parse(await citation.run({} as any, { action: "format", entries: [PAPER] } as any));
		expect(out.bibtex).toContain("@article{preskill2019quantum,"); // family+year+first significant title word
		expect(out.bibtex).toContain("author = {Preskill, John and Chen, Amy}"); // "Given Family" and {family,given} both normalize
		expect(out.bibtex).toContain("journal = {Nature}");
		expect(out.bibtex).toContain("doi = {10.1/x}");
	});

	it("emits CSL-JSON with issued date-parts and mapped type", async () => {
		const out = parse(await citation.run({} as any, { action: "format", entries: [PAPER] } as any));
		expect(out.csl[0]).toMatchObject({ id: "preskill2019quantum", type: "article-journal", "container-title": "Nature", DOI: "10.1/x", issued: { "date-parts": [[2019]] } });
		expect(out.csl[0].author).toEqual([{ family: "Preskill", given: "John" }, { family: "Chen", given: "Amy" }]);
	});

	it("accepts a single inline entry and defaults type to misc without a container", async () => {
		const out = parse(await citation.run({} as any, { action: "format", title: "A Report", authors: ["Doe, Jane"], year: 2020 } as any));
		expect(out.bibtex).toContain("@misc{doe2020report,");
	});

	it("bad_input when there are no entries", async () => {
		const r = await citation.run({} as any, { action: "format" } as any);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
	});
});

describe("citation.capture", () => {
	it("writes a type:citation note to References/<citekey>.md and returns the key + bibtex", async () => {
		obs.mockResolvedValue(okR(JSON.stringify({ ok: true })));
		const out = parse(await citation.run({} as any, { action: "capture", ...PAPER } as any));
		expect(out).toMatchObject({ ok: true, citekey: "preskill2019quantum", path: "References/preskill2019quantum.md" });
		const call = obs.mock.calls[0][1];
		expect(call).toMatchObject({ action: "write", path: "References/preskill2019quantum.md", backend: "git" });
		expect(call.content).toContain("type: citation");
		expect(call.content).toContain("citekey: preskill2019quantum");
		expect(call.content).toContain("# On Quantum Supremacy");
		expect(out.bibtex).toContain("@article{preskill2019quantum,");
	});

	it("requires a title", async () => {
		const r = await citation.run({} as any, { action: "capture", authors: ["X"] } as any);
		expect(r.isError).toBe(true);
		expect(obs).not.toHaveBeenCalled();
	});
});

describe("citation.export", () => {
	it("walks References/, parses citation frontmatter, and emits a combined .bib", async () => {
		obs.mockImplementation(async (_e: any, a: any) => {
			if (a.action === "list") return okR(JSON.stringify({ files: ["References/preskill2019quantum.md", "References/notes.md"] }));
			if (a.action === "read" && a.path.includes("preskill")) return okR(JSON.stringify({ content: '---\ntype: citation\ncitekey: preskill2019quantum\ntitle: "On Quantum Supremacy"\nauthors: ["Preskill, John"]\nyear: 2019\ncontainer: "Nature"\ndoi: "10.1/x"\n---\n\n# On Quantum Supremacy\n' }));
			return okR(JSON.stringify({ content: "# just a note, no frontmatter" }));
		});
		const out = parse(await citation.run({} as any, { action: "export" } as any));
		expect(out.count).toBe(1); // only the citation note, not the plain note
		expect(out.bibtex).toContain("@article{preskill2019quantum,");
		expect(out.bibtex).toContain("journal = {Nature}");
	});

	it("write:true saves the combined bib to References/library.bib", async () => {
		obs.mockImplementation(async (_e: any, a: any) => {
			if (a.action === "list") return okR(JSON.stringify({ files: ["References/doe2020report.md"] }));
			if (a.action === "read") return okR(JSON.stringify({ content: '---\ntype: citation\ncitekey: doe2020report\ntitle: "A Report"\nauthors: ["Doe, Jane"]\nyear: 2020\n---\n' }));
			return okR(JSON.stringify({ ok: true }));
		});
		const out = parse(await citation.run({} as any, { action: "export", write: true } as any));
		expect(out.written).toBe("References/library.bib");
		const writeCall = obs.mock.calls.find((c: any) => c[1].action === "write" && c[1].path === "References/library.bib");
		expect(writeCall?.[1].content).toContain("@misc{doe2020report,");
	});
});
