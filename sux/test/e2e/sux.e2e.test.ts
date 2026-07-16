import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./harness";

// Real end-to-end MCP dispatch tests for the general `sux` front-verb surface — same
// harness/style as vault.e2e.test.ts and mail.e2e.test.ts (a real `wrangler dev`
// Worker, driven over real HTTP tools/list + tools/call, no mocked fetch).
//
// Unlike vault/ingest/mail, this covers the OTHER half of the dispatch chain: a leaf
// fn reached through the general registry (index.ts handleRpc -> findFn -> fn.run()),
// not a namespace verb. Two real-dispatch paths, both zero-network/zero-creds so they
// need no opt-in tier:
//   1. `sux` itself (the capability map front verb) — pure, reads only the live
//      registry, no I/O.
//   2. `fn` (the escape hatch front verb) routing to `yaml` (a pure, deterministic
//      JSON->YAML converter, fns/yaml.ts) — proves a real leaf actually runs through
//      fn.run(), not just that the front verb responds.

describe("MCP e2e: sux (real dispatch, general fn registry)", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness({});
	}, 30_000);

	afterAll(async () => {
		// Guard against beforeAll having thrown before `h` was assigned — an unguarded
		// `h.stop()` here would mask the real bind/boot error behind "Cannot read
		// properties of undefined (reading 'stop')".
		await h?.stop();
	});

	it("tools/list exposes sux and fn with real schemas", async () => {
		const out = await h.rpc("tools/list");
		const tools = out.result.tools as Array<{ name: string; inputSchema: any }>;
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		expect(byName.sux).toBeDefined();
		expect(byName.sux.inputSchema.properties).toHaveProperty("domain");
		expect(byName.fn).toBeDefined();
		expect(byName.fn.inputSchema.required).toEqual(expect.arrayContaining(["name"]));
	});

	it("sux() returns the live capability map (real dispatch, no mocking)", async () => {
		const r = await h.callTool("sux", {});
		expect(r.isError).toBeFalsy();
		// The overview lists the curated domains, e.g. the `convert` group covering
		// yaml/json/csv/xml — real output from the deployed registry, not a stub.
		expect(r.content[0].text).toMatch(/convert/i);
		expect(r.content[0].text).toMatch(/yaml/i);
	});

	it("sux({domain:'convert'}) zooms into one domain", async () => {
		const r = await h.callTool("sux", { domain: "convert" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/yaml/i);
	});

	it("fn({name:'yaml'}) real-dispatches a leaf fn through the general registry (not vault/ingest)", async () => {
		const r = await h.callTool("fn", { name: "yaml", args: { data: JSON.stringify({ a: 1, b: [1, 2], c: "hi" }) } });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("a: 1\nb:\n  - 1\n  - 2\nc: hi");
	});

	it("yaml can also be called directly by name (a leaf is still reachable outside the fn escape)", async () => {
		const r = await h.callTool("yaml", { data: JSON.stringify({ ok: true }) });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("ok: true");
	});

	it("fn: an unknown leaf name fails with a typed not_found error", async () => {
		const r = await h.callTool("fn", { name: "definitely_not_a_real_tool" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/unknown tool/i);
	});

	it("yaml: bad input (missing data) fails with a typed error, not a silent empty result", async () => {
		const r = await h.callTool("yaml", {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/data.*required/i);
	});
});
