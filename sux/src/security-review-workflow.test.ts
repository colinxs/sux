import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The security-review workflow is a requireable branch-protection gate, so three
// invariants must hold or the gate silently stops protecting `main`. This test guards
// them as plain text (no YAML dep): a regression here is a merge-blocking policy hole.
const wf = (name: string) => readFileSync(join(process.cwd(), ".github/workflows", name), "utf8");

describe("security-review workflow is a real, requireable gate", () => {
	const sec = wf("security-review.yml");

	it("uses a DISTINCT job id + name so its check-run context doesn't collide with claude.yml's `review`", () => {
		// job id
		expect(sec).toMatch(/^\s{2}security-review:/m);
		expect(sec).not.toMatch(/^\s{2}review:/m);
		// explicit name pins the check-run context string
		expect(sec).toMatch(/^\s{4}name:\s*security-review\s*$/m);
		// the colliding job actually exists in claude.yml — prove we're not requiring it by accident
		expect(wf("claude.yml")).toMatch(/^\s{2}review:/m);
	});

	it("has a job-level timeout so a hung review can't run unbounded", () => {
		expect(sec).toMatch(/^\s{4}timeout-minutes:\s*\d+\s*$/m);
	});

	it("fails CLOSED on a missing verdict after an armed run — never advisory-pass", () => {
		// the missing-verdict branch must apply `hold` and exit 1, not exit 0
		const gate = sec.slice(sec.indexOf("if [ ! -f .sec-verdict.json ]"));
		expect(gate).toContain("--add-label hold");
		expect(gate).toContain("exit 1");
		// the old fail-open behavior (advisory pass on missing verdict) must be gone
		expect(sec).not.toContain("treating as advisory pass");
		expect(sec).not.toMatch(/no verdict file produced[^\n]*exit 0/);
	});

	it("only skips the gate when genuinely disarmed (no ANTHROPIC_API_KEY)", () => {
		// the gate step is guarded by the same preflight `go` that requires the key
		expect(sec).toMatch(/steps\.pre\.outputs\.go == 'true'/);
		expect(sec).toMatch(/ANTHROPIC_API_KEY != ''/);
	});
});
