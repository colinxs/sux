import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Stage 0.1 of the placement fabric (docs/design/2026-07-23-placement-fabric-architecture.md
// §11, sux#1455): `invokeFn` (registry.ts) is meant to be the ONE boundary through which an
// Fn's handler is entered, so later fabric stages (per-request context, the sensitivity/
// provenance join, placement resolution) have a single seam to attach to.
//
// This is a structural RATCHET, not full coverage — it only enforces the invariant on the
// dispatch-layer files this stage actually migrated (registry's own tools/call handling, plus
// the fns that dynamically select or compose a target fn by name). It deliberately does NOT
// cover the ~150 fixed fn-to-fn composition calls scattered across the other ~90 fn modules
// (e.g. vault-mcp.ts calling obsidian.run) — see invokeFn's own doc comment in registry.ts for
// why that's an explicit, documented follow-up rather than part of this seam. A source-grep
// assertion like this is the norm for a structural check in this repo (see plugin-version.test.ts).
const DISPATCH_FILES = ["sux/src/index.ts", "sux/src/fns/batch.ts", "sux/src/fns/pipe.ts", "sux/src/fns/oracle.ts", "sux/src/fns/product_search.ts", "sux/src/fns/shop.ts", "sux/src/fns/_namespace.ts"];

// Strip `//` line comments (naive but sufficient for this repo's comment style) before
// matching, so a comment that mentions `.run(` in prose (e.g. withDeadline's own doc comment
// in index.ts) never produces a false failure.
function stripLineComments(src: string): string {
	return src
		.split("\n")
		.map((line) => {
			const idx = line.indexOf("//");
			return idx === -1 ? line : line.slice(0, idx);
		})
		.join("\n");
}

describe("registry-lint: invokeFn is the only path into a Fn's handler on the migrated dispatch files", () => {
	it.each(DISPATCH_FILES)("%s never calls a Fn directly via `.run(` — invokeFn is the seam", (relPath) => {
		const src = stripLineComments(readFileSync(join(process.cwd(), relPath), "utf8"));
		const direct = [...src.matchAll(/\b[A-Za-z_$][\w$]*\.run\(/g)].map((m) => m[0]);
		expect(direct, `found direct .run( call(s) bypassing invokeFn: ${direct.join(", ")}`).toEqual([]);
	});
});
