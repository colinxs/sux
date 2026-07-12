import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, CONNECTOR_PATHS, CONNECTORS } from "./connectors";

describe("connectors — the one connector-surface source", () => {
	it("enumerates the single live namespace (retired /<domain>/mcp routes are gone)", () => {
		expect(CONNECTOR_PATHS).toEqual(["/mcp"]);
		expect(new Set(CONNECTOR_PATHS).size).toBe(CONNECTOR_PATHS.length); // no dupes
	});

	it("buildManifest surfaces the one sux connector with its live count", () => {
		const m = buildManifest("https://sux.example.dev", { "/mcp": 94 });
		expect(m.name).toBe("sux");
		expect(m.connectors).toHaveLength(1);
		expect(m.connectors[0]).toMatchObject({ name: "sux", plugin: "sux", url: "https://sux.example.dev/mcp", tools: 94 });
		expect(m.connectors.find((c) => c.name === "vault")).toBeUndefined();
		expect(m.connectors.find((c) => c.name === "mail")).toBeUndefined();
		expect(m.connectors.find((c) => c.name === "files")).toBeUndefined();
		expect(buildManifest("https://x", {}).connectors[0].tools).toBeNull(); // missing count → null, not a crash
	});

	it("every connector maps to a real marketplace plugin (drift guard)", () => {
		const marketplace = JSON.parse(readFileSync(join(process.cwd(), ".claude-plugin/marketplace.json"), "utf8"));
		const pluginNames = new Set((marketplace.plugins ?? []).map((p: { name: string }) => p.name));
		for (const c of CONNECTORS) {
			expect(c.plugin, `${c.path} needs a plugin`).toBeTruthy();
			expect(pluginNames.has(c.plugin), `marketplace missing '${c.plugin}' for ${c.path}`).toBe(true);
		}
	});
});
