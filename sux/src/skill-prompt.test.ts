import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUX_SKILL_DESCRIPTION, SUX_SKILL_PROMPT } from "./skill-prompt";

// The embed is committed (a Worker has no runtime FS); this test is the drift gate
// — no CI workflow step needed. It re-derives the prompt from SKILL.md + any
// references/*.md the same way gen-skill-prompt.mjs does (the Worker can't lazily
// load references/ at request time, so the embed inlines them) and asserts the
// checked-in constant matches, so an edit that wasn't regenerated
// (`npm run gen:skill`) fails `npm test`.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_DIR = join(ROOT, ".claude", "skills", "sux");
const SKILL = join(SKILL_DIR, "SKILL.md");

describe("skill-prompt embed", () => {
	it("matches the current SKILL.md + references/ (regenerate with `npm run gen:skill`)", () => {
		const raw = readFileSync(SKILL, "utf8");
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		let body = (m ? m[2] : raw).trim();
		const description = (m?.[1].match(/^description:\s*(.*)$/m)?.[1] ?? "sux edge-function routing guidance").trim();

		const refsDir = join(SKILL_DIR, "references");
		if (existsSync(refsDir)) {
			const refs = readdirSync(refsDir).filter((f) => f.endsWith(".md")).sort();
			for (const f of refs) {
				body += `\n\n${readFileSync(join(refsDir, f), "utf8").trim()}`;
			}
		}
		expect(SUX_SKILL_PROMPT).toBe(body);
		expect(SUX_SKILL_DESCRIPTION).toBe(description);
	});

	it("is non-empty and starts at the SKILL heading", () => {
		expect(SUX_SKILL_PROMPT.startsWith("# sux")).toBe(true);
		expect(SUX_SKILL_PROMPT).toContain("edge function engine");
	});
});
