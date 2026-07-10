import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, CONNECTOR_PATHS, CONNECTORS } from "./connectors";

describe("connectors — the one connector-surface source", () => {
	it("enumerates the four live namespaces with unique paths", () => {
		expect(CONNECTOR_PATHS).toEqual(["/mcp", "/vault/mcp", "/mail/mcp", "/files/mcp"]);
		expect(new Set(CONNECTOR_PATHS).size).toBe(CONNECTOR_PATHS.length); // no dupes
	});

	it("buildManifest joins origin+path and folds live tool counts (null when a count is missing)", () => {
		const m = buildManifest("https://sux.example.dev", { "/mcp": 94, "/vault/mcp": 9, "/mail/mcp": 12, "/files/mcp": 8 });
		expect(m.name).toBe("sux");
		expect(m.connectors).toHaveLength(4);
		expect(m.connectors[0]).toMatchObject({ name: "sux", plugin: "sux-router", url: "https://sux.example.dev/mcp", tools: 94 });
		expect(m.connectors.find((c) => c.name === "files")).toMatchObject({ url: "https://sux.example.dev/files/mcp", tools: 8 });
		expect(buildManifest("https://x", {}).connectors[0].tools).toBeNull(); // missing count → null, not a crash
	});

	it("every connector's plugin exists in the marketplace (drift guard)", () => {
		const marketplace = JSON.parse(readFileSync(join(process.cwd(), ".claude-plugin/marketplace.json"), "utf8"));
		const pluginNames = new Set((marketplace.plugins ?? []).map((p: { name: string }) => p.name));
		for (const c of CONNECTORS) expect(pluginNames.has(c.plugin), `marketplace is missing plugin '${c.plugin}' for connector ${c.path}`).toBe(true);
	});
});
