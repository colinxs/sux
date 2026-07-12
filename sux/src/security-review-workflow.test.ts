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

	it("scopes the missing-verdict branch: fail-closed on high-blast diffs, advisory-pass otherwise", () => {
		// Isolate ONLY the missing-verdict block — from its `if` guard to where verdict
		// parsing begins (`crit=$(jq …`) — so these assertions can't leak into the later
		// crit/high branch and pass vacuously (that earlier slice-to-EOF bug is the whole
		// point of this test). Both the fail-closed and advisory paths must live in HERE.
		const start = sec.indexOf("if [ ! -f .sec-verdict.json ]");
		const end = sec.indexOf("crit=$(jq", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const missing = sec.slice(start, end);

		// It decides by BLAST RADIUS: inspect the changed files, match high-blast paths.
		expect(missing).toMatch(/gh pr diff\b.*--name-only/);
		expect(missing).toContain(".github/workflows/");
		expect(missing).toContain("auth");
		expect(missing).toContain("secret");

		// High-blast (and unreadable-diff) → FAIL CLOSED: apply `hold` + exit 1, in-block.
		expect(missing).toContain("--add-label hold");
		expect(missing).toContain("exit 1");
		// Non-high-blast → ADVISORY PASS: warn + exit 0, in-block (never a blanket DoS).
		expect(missing).toContain("::warning::");
		expect(missing).toContain("exit 0");

		// The old unconditional advisory-pass (exit 0 with no blast-radius check) is gone:
		// there must be an `exit 1` before the first `exit 0` inside the block.
		expect(missing.indexOf("exit 1")).toBeLessThan(missing.indexOf("exit 0"));
	});

	it("only skips the gate when genuinely disarmed (no ANTHROPIC_API_KEY)", () => {
		// the gate step is guarded by the same preflight `go` that requires the key
		expect(sec).toMatch(/steps\.pre\.outputs\.go == 'true'/);
		expect(sec).toMatch(/ANTHROPIC_API_KEY != ''/);
	});
});
