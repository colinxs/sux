import { describe, expect, it } from "vitest";
import { vaultDailyDir, vaultInboxDir } from "./_vaultpaths";

describe("vaultDailyDir/vaultInboxDir", () => {
	it("default to the current folder names when unset", () => {
		expect(vaultDailyDir({} as any)).toBe("Daily");
		expect(vaultInboxDir({} as any)).toBe("Inbox");
	});

	it("honor an env override", () => {
		expect(vaultDailyDir({ VAULT_DAILY_DIR: "06-daily" } as any)).toBe("06-daily");
		expect(vaultInboxDir({ VAULT_INBOX_DIR: "00-inbox" } as any)).toBe("00-inbox");
	});

	it("falls back to the default on a blank/whitespace override", () => {
		expect(vaultDailyDir({ VAULT_DAILY_DIR: "  " } as any)).toBe("Daily");
		expect(vaultInboxDir({ VAULT_INBOX_DIR: "" } as any)).toBe("Inbox");
	});
});
