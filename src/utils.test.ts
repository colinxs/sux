import { describe, expect, it } from "vitest";
import { isAllowedLogin, parseAllowedLogins } from "./utils";

describe("parseAllowedLogins", () => {
	it("splits, trims, lower-cases, and drops empties", () => {
		expect([...parseAllowedLogins(" Alice, bob ,,CAROL ")]).toEqual(["alice", "bob", "carol"]);
	});
	it("is empty for undefined/blank", () => {
		expect(parseAllowedLogins(undefined).size).toBe(0);
		expect(parseAllowedLogins("   ").size).toBe(0);
	});
});

describe("isAllowedLogin", () => {
	it("matches case-insensitively", () => {
		expect(isAllowedLogin("Alice", "alice,bob")).toBe(true);
		expect(isAllowedLogin("BOB", "alice,bob")).toBe(true);
	});
	it("rejects non-members", () => {
		expect(isAllowedLogin("carol", "alice,bob")).toBe(false);
	});
	it("fails closed on empty allowlist or missing login", () => {
		expect(isAllowedLogin("alice", "")).toBe(false);
		expect(isAllowedLogin("alice", undefined)).toBe(false);
		expect(isAllowedLogin(undefined, "alice")).toBe(false);
	});
});
