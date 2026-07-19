import { describe, expect, it } from "vitest";
import { autonomy_status } from "./autonomy_status";

const run = async (flags: Record<string, string | undefined> = {}) => {
	const r = await autonomy_status.run(flags as any, {});
	expect(r.isError).toBeFalsy();
	return JSON.parse(r.content[0].text);
};

describe("autonomy_status — read-only gate mirror", () => {
	it("reports every surface dormant on a bare env (fail-closed default)", async () => {
		const j = await run();
		expect(j.armed_count).toBe(0);
		expect(j.armed).toEqual([]);
		expect(j.surfaces.map((s: any) => s.surface)).toEqual([
			"mail_triage",
			"dropbox_full_write",
			"self_improve",
			"cron_trigger",
			"briefing",
			"weekly_recall",
			"consolidate",
			"agenda",
			"mail_triage_plan",
			"ask_gate_reminder",
			"life_wiki",
			"learning_folder",
		]);
		for (const s of j.surfaces) expect(s.armed).toBe(false);
	});

	it("briefing arms only when STAGE_DRAFTS is set atop ENABLED; digest-only otherwise", async () => {
		const byName = (j: any, name: string) => j.surfaces.find((s: any) => s.surface === name);
		expect(byName(await run({ BRIEFING_ENABLED: "1" }), "briefing")).toMatchObject({ armed: false, mode: "suggest-only (digest, no drafts)" });
		const j = await run({ BRIEFING_ENABLED: "1", BRIEFING_STAGE_DRAFTS: "1" });
		expect(byName(j, "briefing")).toMatchObject({ armed: true });
		expect(j.armed).toContain("briefing");
	});

	it("weekly_recall arms on its own enable flag", async () => {
		const j = await run({ WEEKLY_RECALL_ENABLED: "1" });
		expect(j.surfaces.find((s: any) => s.surface === "weekly_recall")).toMatchObject({ armed: true });
		expect(j.armed).toContain("weekly_recall");
	});

	it("consolidate arms on its own enable flag", async () => {
		const j = await run({ CONSOLIDATE_ENABLED: "1" });
		expect(j.surfaces.find((s: any) => s.surface === "consolidate")).toMatchObject({ armed: true, mode: "armed (detection-only, appends a weekly digest note)" });
		expect(j.armed).toContain("consolidate");
	});

	it("mail_triage is armed only when BOTH ENABLED and ACT are truthy; suggest-only otherwise", async () => {
		expect((await run({ MAIL_TRIAGE_ENABLED: "1" })).surfaces[0]).toMatchObject({ armed: false, mode: "suggest-only" });
		const j = await run({ MAIL_TRIAGE_ENABLED: "1", MAIL_TRIAGE_ACT: "1" });
		expect(j.surfaces[0]).toMatchObject({ surface: "mail_triage", armed: true });
		expect(j.armed).toContain("mail_triage");
	});

	it("self_improve reports killed even when enabled — kill wins", async () => {
		const j = await run({ SELF_IMPROVE_ENABLE: "1", SELF_IMPROVE_KILL: "1" });
		expect(j.surfaces[2]).toMatchObject({ surface: "self_improve", armed: false, mode: "killed" });
	});

	it("dropbox_full_write stays read-only on the credential alone — arms only when DROPBOX_FULL_WRITE_ENABLED is also set", async () => {
		const byName = (j: any) => j.surfaces.find((s: any) => s.surface === "dropbox_full_write");
		// Credential-only: READ is live but the write surface must report NOT armed (the security split).
		const readOnly = await run({ DROPBOX_FULL_REFRESH_TOKEN: "rt", DROPBOX_FULL_APP_KEY: "ak" });
		expect(byName(readOnly)).toMatchObject({ armed: false });
		expect(byName(readOnly).mode).toMatch(/read-only/);
		expect(readOnly.armed).not.toContain("dropbox_full_write");
		// Credential + arm flag: now armed.
		const armed = await run({ DROPBOX_FULL_REFRESH_TOKEN: "rt", DROPBOX_FULL_APP_KEY: "ak", DROPBOX_FULL_WRITE_ENABLED: "1" });
		expect(byName(armed)).toMatchObject({ armed: true });
		expect(armed.armed).toContain("dropbox_full_write");
	});

	it("cron_trigger arms on its own config, without printing secret values", async () => {
		const j = await run({ SUX_CRON_TOKEN: "s3cr3t" });
		expect(j.armed).toContain("cron_trigger");
		expect(r_text(j)).not.toContain("s3cr3t");
	});

	it("mail_triage_plan arms on its own enable flag, separate from mail_triage", async () => {
		const j = await run({ MAIL_TRIAGE_PLAN_ENABLED: "1" });
		expect(j.surfaces.find((s: any) => s.surface === "mail_triage_plan")).toMatchObject({ armed: true });
		expect(j.armed).toContain("mail_triage_plan");
		expect(j.armed).not.toContain("mail_triage");
	});

	it("ask_gate_reminder arms on its own two-stage gate — email mode only atop the base flag", async () => {
		const byName = (j: any) => j.surfaces.find((s: any) => s.surface === "ask_gate_reminder");
		const base = await run({ ASK_GATE_REMINDER_ENABLED: "1" });
		expect(byName(base)).toMatchObject({ armed: true, mode: "armed (vault append only)" });
		const withEmail = await run({ ASK_GATE_REMINDER_ENABLED: "1", ASK_GATE_REMINDER_EMAIL: "1" });
		expect(byName(withEmail)).toMatchObject({ armed: true, mode: "armed (vault append + emails you the reminder)" });
		expect((await run({ ASK_GATE_REMINDER_EMAIL: "1" })).armed).not.toContain("ask_gate_reminder");
	});

	it("life_wiki arms on its own enable flag", async () => {
		const j = await run({ LIFE_WIKI_ENABLED: "1" });
		expect(j.surfaces.find((s: any) => s.surface === "life_wiki")).toMatchObject({ armed: true });
		expect(j.armed).toContain("life_wiki");
	});

	it("learning_folder arms only when ENABLED is set AND Dropbox is configured", async () => {
		const enabledOnly = await run({ LEARNING_FOLDER_ENABLED: "1" });
		expect(enabledOnly.armed).not.toContain("learning_folder");
		const j = await run({ LEARNING_FOLDER_ENABLED: "1", DROPBOX_TOKEN: "t" });
		expect(j.surfaces.find((s: any) => s.surface === "learning_folder")).toMatchObject({ armed: true });
		expect(j.armed).toContain("learning_folder");
	});
});

// The whole report is booleans + fixed prose — a secret value must never appear in it.
const r_text = (j: unknown): string => JSON.stringify(j);
