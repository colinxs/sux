import { describe, expect, it } from "vitest";

import type { RtEnv } from "../registry";
import { FUNCTIONS } from "./index";
import { sux } from "./sux";

const env = {} as unknown as RtEnv;

describe("sux root verb", () => {
	it("is registered and marked a front-surface tool", () => {
		expect(FUNCTIONS.some((f) => f.name === "sux")).toBe(true);
		expect(sux.surface).toBe("front");
		// Self-description is a free, side-effect-free read.
		expect(sux.annotations?.readOnlyHint).toBe(true);
		expect(sux.annotations?.openWorldHint).toBe(false);
	});

	it("the overview names every registered leaf (no leaf hidden from the map)", async () => {
		const r = await sux.run(env, {});
		const text = r.content[0].text;
		expect(r.isError).toBeFalsy();
		for (const f of FUNCTIONS) {
			expect(text, `overview mentions \`${f.name}\``).toContain(`\`${f.name}\``);
		}
		// The personal-data namespaces are pointed at via their front verbs on the one
		// /mcp connector (the retired /<domain>/mcp mounts must NOT reappear).
		for (const verb of ["`vault` verb", "`mail` verb", "`files` verb"]) expect(text).toContain(verb);
		for (const mount of ["/vault/mcp", "/mail/mcp", "/files/mcp"]) expect(text).not.toContain(mount);
	});

	it("zooms a domain into per-leaf summaries", async () => {
		const r = await sux.run(env, { domain: "shop" });
		const text = r.content[0].text;
		expect(text).toContain("# sux · shop");
		expect(text).toContain("`amazon`");
		// A summary line, not just the bare name.
		expect(text).toMatch(/`shop`\s+—\s+\S/);
	});

	it("rejects an unknown domain with the list of known ones", async () => {
		const r = await sux.run(env, { domain: "nope" });
		const text = r.content[0].text;
		expect(text).toContain('Unknown domain "nope"');
		expect(text).toContain("search");
	});
});
