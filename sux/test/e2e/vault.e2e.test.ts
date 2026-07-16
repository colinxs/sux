import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./harness";

// Real end-to-end MCP dispatch tests (issue #338): a real `wrangler dev` Worker,
// driven over real HTTP tools/list + tools/call — no mocked fetch, no in-process
// vitest shortcut. See harness.ts / e2e-worker.ts for what's actually running.
//
// Two tiers:
//  1. Always run (no secrets needed): tool-surface shape, and the "vault not
//     configured" / bad-input paths — these are real dispatch through the exact
//     code that had the recent silent-failure regressions (fns/obsidian.ts
//     vaultCfg, fns/ingest.ts's exactly-one-source check).
//  2. Opt-in (needs TEST_OBSIDIAN_VAULT_REPO + TEST_GITHUB_TOKEN): exercises the
//     real GitHub-backed git vault against a small fixture repo, reproducing the
//     class of bug fixed in 86f37a7 / 1374343 — a GitHub read must surface a clear
//     error, never a silently-empty result, and a folder-shaped read must error
//     rather than decode as note content. Run locally with:
//       TEST_OBSIDIAN_VAULT_REPO=colinxs/sux-e2e-vault-fixture TEST_GITHUB_TOKEN=$(gh auth token) npm run test:e2e

const hasRealVault = Boolean(process.env.TEST_OBSIDIAN_VAULT_REPO && process.env.TEST_GITHUB_TOKEN);

describe("MCP e2e: vault + ingest (real dispatch, unconfigured vault)", () => {
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

	it("tools/list exposes the vault and ingest front verbs with real schemas", async () => {
		const out = await h.rpc("tools/list");
		const tools = out.result.tools as Array<{ name: string; inputSchema: any }>;
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		expect(byName.vault).toBeDefined();
		expect(byName.vault.inputSchema.properties.action.enum).toEqual(
			expect.arrayContaining(["read", "list", "write", "capture", "backlinks", "query", "patch", "tags"]),
		);
		expect(byName.ingest).toBeDefined();
		expect(byName.ingest.inputSchema.properties).toHaveProperty("url");
		expect(byName.ingest.inputSchema.properties).toHaveProperty("text");
		expect(byName.ingest.inputSchema.properties).toHaveProperty("query");
	});

	it("vault: an unknown action fails with a typed bad_input error", async () => {
		const r = await h.callTool("vault", { action: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/action.*must be one of/i);
	});

	// Regression: vault reads/lists must fail LOUDLY when the git backend isn't
	// configured, never come back as a quiet empty success (the class of bug fixed
	// in 1374343 / 86f37a7 — a config or auth problem masquerading as "no notes").
	it("vault_list (via vault action) fails clearly when OBSIDIAN_VAULT_REPO is unset", async () => {
		const r = await h.callTool("vault", { action: "list" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});

	it("vault_read (via vault action) fails clearly when OBSIDIAN_VAULT_REPO is unset", async () => {
		const r = await h.callTool("vault", { action: "read", path: "Home.md" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});

	it("ingest fails clearly when the vault isn't configured (not a silent empty note)", async () => {
		const r = await h.callTool("ingest", { text: "hello" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});

	it("vault capture (delegates to ingest) also fails clearly when unconfigured", async () => {
		const r = await h.callTool("vault", { action: "capture", text: "quick thought" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});
});

describe.skipIf(!hasRealVault)("MCP e2e: vault against a real GitHub-backed fixture repo", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness({
			OBSIDIAN_VAULT_REPO: process.env.TEST_OBSIDIAN_VAULT_REPO!,
			GITHUB_TOKEN: process.env.TEST_GITHUB_TOKEN!,
			VAULT_TZ: "America/Los_Angeles",
		});
	}, 30_000);

	afterAll(async () => {
		// Guard against beforeAll having thrown before `h` was assigned — an unguarded
		// `h.stop()` here would mask the real bind/boot error behind "Cannot read
		// properties of undefined (reading 'stop')".
		await h?.stop();
	});

	it("vault_list returns the real seeded notes (happy path, real GitHub dispatch)", async () => {
		const r = await h.callTool("vault", { action: "list" });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.notes).toEqual(expect.arrayContaining(["Home.md", "Projects/sux.md", "Inbox/idea.md"]));
	});

	it("vault_read returns real note content (happy path)", async () => {
		const r = await h.callTool("vault", { action: "read", path: "Home.md" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/# Home/);
	});

	// Regression for 1374343: reading a path that resolves to a FOLDER (GitHub's
	// contents API returns a JSON array, not a file object) must surface a clear
	// error — never decode as an empty note body.
	it("vault_read on a folder path fails clearly instead of silently returning empty", async () => {
		const r = await h.callTool("vault", { action: "read", path: "Projects" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).not.toBe("");
	});

	it("vault_read on a genuinely missing note returns not_found, not empty", async () => {
		const r = await h.callTool("vault", { action: "read", path: "Nope/does-not-exist.md" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not found/i);
	});

	it("vault_backlinks resolves a real wikilink from the fixture vault", async () => {
		const r = await h.callTool("vault", { action: "backlinks", path: "Home.md" });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.backlinks.some((b: any) => b.path === "Projects/sux.md")).toBe(true);
	});

	// ingest's exactly-one-source check runs AFTER vaultCfg, so it needs a
	// configured vault to actually observe (an unconfigured vault short-circuits
	// on "not configured" first — see the unconfigured describe block above).
	it("ingest rejects zero sources (bad input, not a hang or a blank capture)", async () => {
		const r = await h.callTool("ingest", { title: "no source" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/exactly one source/i);
	});

	it("ingest rejects more than one source", async () => {
		const r = await h.callTool("ingest", { text: "a", query: "b" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/exactly one source/i);
	});
});
