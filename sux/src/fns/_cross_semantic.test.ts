import { describe, expect, it } from "vitest";
import { crossDomainLinks, filesToCrossItems, hasCrossSemantic, mailToCrossItems, type CrossDomainItem } from "./_cross_semantic";
import type { SemanticChunk } from "./_vault_semantic";
import type { MailSemanticChunk } from "./_mail_semantic";
import type { FilesSemanticChunk } from "./_files_semantic";

const vaultChunk = (path: string, embedding: number[], title = path): SemanticChunk => ({ path, title, text: `text of ${path}`, embedding });

describe("hasCrossSemantic", () => {
	it("is disabled unless CROSS_SEMANTIC_ENABLED is truthy", () => {
		expect(hasCrossSemantic({} as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "0" } as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "false" } as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "1" } as any)).toBe(true);
	});
});

describe("mailToCrossItems / filesToCrossItems", () => {
	it("pools mail chunks into domain-tagged items and drops ones that never embedded", () => {
		const chunks: MailSemanticChunk[] = [
			{ id: "m1", subject: "Invoice", from: "a@b.com", receivedAt: "2024-01-01", text: "preview", embedding: [1, 0] },
			{ id: "m2", subject: "empty", from: "", receivedAt: "", text: "", embedding: [] },
		];
		expect(mailToCrossItems(chunks)).toEqual([{ domain: "mail", key: "m1", label: "Invoice", embedding: [1, 0] }]);
	});

	it("pools files chunks with path doubling as both key and label", () => {
		const chunks: FilesSemanticChunk[] = [{ path: "notes/a.md", text: "x", embedding: [0, 1] }];
		expect(filesToCrossItems(chunks)).toEqual([{ domain: "files", key: "notes/a.md", label: "notes/a.md", embedding: [0, 1] }]);
	});
});

describe("crossDomainLinks", () => {
	it("matches a vault note against its nearest mail/files targets above the threshold", () => {
		const vaultChunks = [vaultChunk("Projects/alpha.md", [1, 0, 0])];
		const targets: CrossDomainItem[] = [
			{ domain: "mail", key: "m1", label: "Re: alpha kickoff", embedding: [1, 0, 0] },
			{ domain: "files", key: "alpha/spec.md", label: "alpha/spec.md", embedding: [0, 1, 0] },
		];
		const links = crossDomainLinks(vaultChunks, targets);
		expect(links).toEqual([{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "Re: alpha kickoff", score: 1 }]);
	});

	it("returns nothing when every target scores below minScore", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0])];
		const targets: CrossDomainItem[] = [{ domain: "mail", key: "m1", label: "unrelated", embedding: [0, 1] }];
		expect(crossDomainLinks(vaultChunks, targets)).toEqual([]);
	});

	it("caps matches per note at maxPerNote, keeping the highest scores", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0])];
		const targets: CrossDomainItem[] = [
			{ domain: "mail", key: "m1", label: "closest", embedding: [1, 0] },
			{ domain: "mail", key: "m2", label: "close", embedding: [0.99, 0.01] },
			{ domain: "mail", key: "m3", label: "less close", embedding: [0.9, 0.1] },
		];
		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5, maxPerNote: 2 });
		expect(links).toHaveLength(2);
		expect(links.map((l) => l.key)).toEqual(["m1", "m2"]);
	});

	it("caps total matches across notes at maxTotal, ranked by score", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0]), vaultChunk("B.md", [0, 1])];
		const targets: CrossDomainItem[] = [
			{ domain: "mail", key: "m1", label: "matches A well", embedding: [1, 0] },
			{ domain: "files", key: "f1", label: "matches B well", embedding: [0, 1] },
		];
		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5, maxTotal: 1 });
		expect(links).toHaveLength(1);
		expect(links[0].score).toBeCloseTo(1);
	});

	it("dedupes a note matching the same target through more than one of its own chunks, keeping the best score", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0]), vaultChunk("A.md", [0.95, 0.05])];
		const targets: CrossDomainItem[] = [{ domain: "mail", key: "m1", label: "x", embedding: [1, 0] }];
		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5 });
		expect(links).toHaveLength(1);
		expect(links[0].score).toBe(1);
	});

	it("skips vault chunks with no embedding and returns [] when there are no targets", () => {
		const vaultChunks = [{ ...vaultChunk("A.md", []), embedding: [] }];
		expect(crossDomainLinks(vaultChunks, [{ domain: "mail", key: "m1", label: "x", embedding: [1, 0] }])).toEqual([]);
		expect(crossDomainLinks([vaultChunk("A.md", [1, 0])], [])).toEqual([]);
	});

	it("caps the vault chunks scanned so a huge vault × target set can't blow the pair budget (#959)", () => {
		// A target set large enough to force a chunk cap well below the vault's real chunk count.
		const targets: CrossDomainItem[] = Array.from({ length: 200_000 }, (_, i) => ({
			domain: "mail" as const,
			key: `m${i}`,
			label: `msg ${i}`,
			embedding: [0, 1],
		}));
		// Put the only matching chunk PAST where a 2,000,000-pair budget / 200,000 targets = 10
		// chunk cap would stop scanning — if the cap weren't applied, this would still match.
		const vaultChunks = [...Array.from({ length: 20 }, (_, i) => vaultChunk(`filler${i}.md`, [0, 1])), vaultChunk("late.md", [1, 0])];
		targets.push({ domain: "mail", key: "exact", label: "exact match", embedding: [1, 0] });

		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5 });

		// Without the cap, "late.md" would be the only chunk to clear minScore (it exactly
		// matches the "exact" target); the fillers all score 0 against every target.
		expect(links.some((l) => l.key === "exact")).toBe(false);
	});
});
