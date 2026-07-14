import { type Fn, ok, failWith } from "../registry";
import { errMsg, oj } from "./_util";
import { hasConsolidate, runConsolidate, defaultDeps } from "./_consolidate";

// On-demand front door for the vault memory-consolidation sweep (see _consolidate.ts for the
// full design rationale — the personal-ai-landscape-2026.md "one bet"). The scheduled cron
// tick (index.ts) runs the same runConsolidate() once a week when armed; this fn lets Colin
// trigger a scan interactively regardless of the weekly gate (`force:true` bypasses only the
// once-a-week ledger — CONSOLIDATE_ENABLED is still required either way, fail-closed).
export const consolidate: Fn = {
	name: "consolidate",
	description:
		"Scan the vault for stale notes (no `last_verified` frontmatter, or older than the staleness threshold — 90d default) and likely-duplicate notes (same-looking title). DETECTION ONLY: reports findings and appends a digest to Consolidation/<ISO-week>.md — nothing is merged, deleted, or auto-patched. Dormant unless CONSOLIDATE_ENABLED is set (fail-closed); the scan itself is gated to once per ISO week unless `force:true`. Needs a configured vault (git-backed Obsidian).",
	inputSchema: { type: "object", additionalProperties: false, properties: { force: { type: "boolean", description: "Run the scan even if this ISO week already ran." } } },
	cacheable: false,
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	run: async (env, a) => {
		if (!hasConsolidate(env)) {
			return failWith("not_configured", "consolidate is disabled — set CONSOLIDATE_ENABLED to arm the vault staleness/duplicate scan. Detection only: nothing is merged, deleted, or patched.");
		}
		try {
			const deps = await defaultDeps();
			const report = await runConsolidate(env, { force: a?.force === true }, deps);
			return ok(oj(report));
		} catch (e) {
			return failWith("upstream_error", `consolidate failed: ${errMsg(e)}`);
		}
	},
};
