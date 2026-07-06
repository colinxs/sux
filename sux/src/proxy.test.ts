import { describe, expect, it } from "vitest";
import { fetchViaTailscale, hmacHex, isTailscaleConfigured } from "./proxy";

describe("isTailscaleConfigured", () => {
	it("is true only when both url and secret are set", () => {
		expect(isTailscaleConfigured({})).toBe(false);
		expect(isTailscaleConfigured({ TAILSCALE_PROXY_URL: "https://x.ts.net" })).toBe(false);
		expect(isTailscaleConfigured({ TAILSCALE_PROXY_SECRET: "s" })).toBe(false);
		expect(isTailscaleConfigured({ TAILSCALE_PROXY_URL: "https://x.ts.net", TAILSCALE_PROXY_SECRET: "s" })).toBe(true);
	});
});

describe("fetchViaTailscale", () => {
	it("throws when the proxy is not configured", async () => {
		await expect(fetchViaTailscale({}, "https://example.com")).rejects.toThrow(/not configured/);
	});
});

describe("hmacHex", () => {
	it("matches the known HMAC-SHA256 test vector", async () => {
		// RFC-style vector: key "key", msg "The quick brown fox jumps over the lazy dog"
		expect(await hmacHex("key", "The quick brown fox jumps over the lazy dog")).toBe(
			"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
		);
	});
	it("is deterministic and secret-sensitive", async () => {
		expect(await hmacHex("s1", "m")).toBe(await hmacHex("s1", "m"));
		expect(await hmacHex("s1", "m")).not.toBe(await hmacHex("s2", "m"));
	});
});
