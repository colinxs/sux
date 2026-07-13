import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The plugin's semantic version is declared twice — in the marketplace manifest and
// in the plugin manifest — that must agree by convention. Nothing else cross-checks
// them, so a bump to one file that forgets the other would go green and the
// marketplace would advertise a stale version indefinitely. This is the drift gate:
// a mismatch fails `npm test`, no CI workflow step needed.
const read = (...p: string[]) => JSON.parse(readFileSync(join(process.cwd(), ...p), "utf8"));

describe("plugin version is consistent across both manifests", () => {
	it("marketplace.json plugins[0].version equals plugin.json version", () => {
		const marketplace = read(".claude-plugin", "marketplace.json");
		const plugin = read("plugins", "sux", ".claude-plugin", "plugin.json");

		const sux = (marketplace.plugins ?? []).find((p: { name: string }) => p.name === "sux");
		expect(sux, "no plugin named 'sux' in marketplace.json").toBeDefined();

		expect(plugin.version, "plugin.json is missing a version").toBeTruthy();
		expect(sux.version).toBe(plugin.version);
	});
});
