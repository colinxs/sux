import { describe, expect, it } from "vitest";
import type { Props } from "./utils";
import { isAllowedLogin, parseAllowedLogins } from "./utils";
import type { RtEnv } from "./registry";
import { rtServer } from "./index";

// The authorization gate is security-critical: it is the single check that keeps
// the MCP tool surface closed to any authenticated GitHub user who is not on the
// allowlist. These tests pin the fail-closed invariants so a refactor that
// inverts, case-folds, or short-circuits the gate breaks CI instead of silently
// opening the surface.

describe("parseAllowedLogins", () => {
	it("returns an empty set for undefined or empty raw", () => {
		expect(parseAllowedLogins(undefined).size).toBe(0);
		expect(parseAllowedLogins("").size).toBe(0);
		expect(parseAllowedLogins("   ").size).toBe(0);
	});

	it("splits a comma list, trimming whitespace and lowercasing", () => {
		const set = parseAllowedLogins("  Octocat , MonaLisa ,");
		expect(set.has("octocat")).toBe(true);
		expect(set.has("monalisa")).toBe(true);
		// The trailing empty entry is dropped, not stored as "".
		expect(set.has("")).toBe(false);
		expect(set.size).toBe(2);
	});
});

describe("isAllowedLogin", () => {
	it("rejects an undefined login even when the allowlist is non-empty", () => {
		expect(isAllowedLogin(undefined, "octocat")).toBe(false);
	});

	it("fails closed when the allowlist is empty or unset", () => {
		expect(isAllowedLogin("octocat", undefined)).toBe(false);
		expect(isAllowedLogin("octocat", "")).toBe(false);
		expect(isAllowedLogin("octocat", "   ")).toBe(false);
	});

	it("matches case-insensitively against a trimmed comma list", () => {
		expect(isAllowedLogin("OctoCat", " octocat , monalisa ")).toBe(true);
		expect(isAllowedLogin("monalisa", "octocat, MonaLisa")).toBe(true);
	});

	it("rejects a login that is not on the allowlist", () => {
		expect(isAllowedLogin("intruder", "octocat, monalisa")).toBe(false);
	});
});

function makeCtx(login: string | undefined): ExecutionContext & { props?: Props } {
	return {
		props: login === undefined ? undefined : ({ login } as Props),
		waitUntil: () => {},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext & { props?: Props };
}

describe("rtServer.fetch gate", () => {
	const req = () => new Request("https://sux.example/mcp", { method: "POST", body: "{}" });

	it("returns 403 for a login that is not on the allowlist", async () => {
		const env = { ALLOWED_GITHUB_LOGIN: "octocat", MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as RtEnv;
		const res = await rtServer.fetch(req(), env, makeCtx("intruder"));
		expect(res.status).toBe(403);
	});

	it("returns 403 when no login is present at all", async () => {
		const env = { ALLOWED_GITHUB_LOGIN: "octocat" } as unknown as RtEnv;
		const res = await rtServer.fetch(req(), env, makeCtx(undefined));
		expect(res.status).toBe(403);
	});

	it("returns 429 for an allowed login when the rate limiter denies", async () => {
		const env = { ALLOWED_GITHUB_LOGIN: "octocat", MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as RtEnv;
		const res = await rtServer.fetch(req(), env, makeCtx("octocat"));
		expect(res.status).toBe(429);
	});
});
