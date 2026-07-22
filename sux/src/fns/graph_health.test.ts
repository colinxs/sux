import { describe, expect, it } from "vitest";
import { computeGraphHealth } from "./graph_health";
import type { VaultRecord } from "../vault-mcp";

const rec = (path: string, links: string[] = [], fm: Record<string, unknown> = {}): VaultRecord => ({
	path,
	fm,
	links,
	tags: [],
	tasks: [],
	excerpt: "",
	keywords: [],
});

describe("computeGraphHealth", () => {
	it("flags a note with no inbound and no outbound links as an orphan", () => {
		const h = computeGraphHealth([rec("Notes/Island.md")]);
		expect(h.orphans).toEqual(["Notes/Island.md"]);
		expect(h.orphan_count).toBe(1);
	});

	it("does not flag a note with an outbound link, or its inbound target, as an orphan", () => {
		const h = computeGraphHealth([rec("Notes/A.md", ["B"]), rec("Notes/B.md")]);
		expect(h.orphans).toEqual([]);
	});

	it("detects a dead link whose target resolves to no note", () => {
		const h = computeGraphHealth([rec("Notes/A.md", ["Nonexistent"])]);
		expect(h.dead_links).toEqual([{ path: "Notes/A.md", link: "Nonexistent" }]);
		expect(h.dead_link_count).toBe(1);
	});

	it("does not flag a link that resolves by basename as dead", () => {
		const h = computeGraphHealth([rec("Notes/A.md", ["B"]), rec("Folder/B.md")]);
		expect(h.dead_links).toEqual([]);
	});

	it("groups notes by folder, root-level notes bucketed as (root)", () => {
		const h = computeGraphHealth([rec("Notes/A.md"), rec("Notes/B.md"), rec("Top.md")]);
		expect(h.folder_counts).toEqual({ Notes: 2, "(root)": 1 });
	});

	it("buckets staleness off the newest available date signal, relative to an injected now", () => {
		const now = new Date("2026-07-22T00:00:00Z");
		const h = computeGraphHealth(
			[
				rec("Fresh.md", [], { updated: "2026-07-10" }),
				rec("MidStale.md", [], { created: "2025-10-01" }),
				rec("OldStale.md", [], { created: "2024-01-01" }),
				rec("NoDate.md", [], {}),
			],
			now,
		);
		expect(h.stale_distribution["<30d"]).toBe(1);
		expect(h.stale_distribution["90-365d"]).toBe(1);
		expect(h.stale_distribution[">365d"]).toBe(1);
		expect(h.stale_distribution.unknown).toBe(1);
	});

	it("totals match the input record count", () => {
		const h = computeGraphHealth([rec("A.md"), rec("B.md")]);
		expect(h.total).toBe(2);
	});
});
