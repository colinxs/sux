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
		expect(j.surfaces.map((s: any) => s.surface)).toEqual(["mail_triage", "dropbox_full_write", "self_improve", "cron_trigger"]);
		for (const s of j.surfaces) expect(s.armed).toBe(false);
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

	it("dropbox_full_write + cron_trigger arm on their own config, without printing secret values", async () => {
		const j = await run({ DROPBOX_FULL_REFRESH_TOKEN: "rt", DROPBOX_FULL_APP_KEY: "ak", SUX_CRON_TOKEN: "s3cr3t" });
		expect(j.armed).toEqual(expect.arrayContaining(["dropbox_full_write", "cron_trigger"]));
		expect(r_text(j)).not.toContain("s3cr3t");
	});
});

// The whole report is booleans + fixed prose — a secret value must never appear in it.
const r_text = (j: unknown): string => JSON.stringify(j);
