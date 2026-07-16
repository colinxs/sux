import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./harness";

// Real end-to-end MCP dispatch tests for the `mail` front verb — same harness/style as
// vault.e2e.test.ts (a real `wrangler dev` Worker, driven over real HTTP tools/list +
// tools/call, no mocked fetch). mail-mcp.ts's TOOLS compile down to the raw `jmap`
// conduit (fns/jmap.ts), which fails loudly with a typed `not_configured` error when
// FASTMAIL_TOKEN is unset (mirrors the vault "not configured" regression-guard pattern —
// a config problem must never masquerade as an empty/successful result).
//
// Only one tier here (always run, no secrets needed): there's no equivalent opt-in
// "real Fastmail account" tier — unlike the vault fixture repo, we don't stand up a
// disposable mailbox for CI. The unconfigured-mail path is still exactly the code that
// had the "not configured" class of regression (see jmap.ts's NOT_CONFIGURED message),
// so it's the real dispatch chain this harness exists to cover.

describe("MCP e2e: mail (real dispatch, unconfigured JMAP)", () => {
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

	it("tools/list exposes the mail front verb with a real schema", async () => {
		const out = await h.rpc("tools/list");
		const tools = out.result.tools as Array<{ name: string; inputSchema: any }>;
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		expect(byName.mail).toBeDefined();
		expect(byName.mail.inputSchema.properties.action.enum).toEqual(
			expect.arrayContaining(["search", "read", "thread", "mailboxes", "identities", "draft", "send", "archive", "move"]),
		);
	});

	it("mail: an unknown action fails with a typed bad_input error", async () => {
		const r = await h.callTool("mail", { action: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/action.*must be one of/i);
	});

	// Regression: mail reads must fail LOUDLY when FASTMAIL_TOKEN isn't configured, never
	// come back as a quiet empty success — the same class of guard vault.e2e.test.ts
	// enforces for the git vault backend.
	it("mail_mailboxes (via mail action) fails clearly when FASTMAIL_TOKEN is unset", async () => {
		const r = await h.callTool("mail", { action: "mailboxes" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});

	it("mail_search (via mail action) fails clearly when FASTMAIL_TOKEN is unset", async () => {
		const r = await h.callTool("mail", { action: "search", query: "hello" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});

	it("mail_read (via mail action) fails clearly when FASTMAIL_TOKEN is unset", async () => {
		const r = await h.callTool("mail", { action: "read", id: "e1" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});
});
