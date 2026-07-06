import { describe, expect, it } from "vitest";
import { fetchViaTailscale, hmacHex, isDirectHost, isTailscaleConfigured, willProxy } from "./proxy";

const ON = { TAILSCALE_PROXY_URL: "https://x.ts.net", TAILSCALE_PROXY_SECRET: "s" };

describe("smart routing", () => {
	it("classifies infra/API hosts as direct hosts", () => {
		expect(isDirectHost("https://mcp.kagi.com/mcp")).toBe(true);
		expect(isDirectHost("https://ipwho.is/8.8.8.8")).toBe(true);
		expect(isDirectHost("https://www.homedepot.com/p/123")).toBe(false);
		// rdap.org/crt.sh are NOT direct — they 403/502 datacenter IPs, so they route residential.
		expect(isDirectHost("https://rdap.org/domain/x.com")).toBe(false);
		expect(isDirectHost("https://crt.sh/?q=x")).toBe(false);
		expect(isDirectHost("not a url")).toBe(false);
	});

	it("auto-routes web pages through the proxy but direct hosts direct", () => {
		expect(willProxy(ON, "https://example.com")).toBe(true);
		expect(willProxy(ON, "https://mcp.kagi.com/mcp")).toBe(false); // Kagi: authed API, no residential benefit
	});

	it("never proxies when the proxy is off", () => {
		expect(willProxy({}, "https://example.com")).toBe(false);
		expect(willProxy({ ...ON, TAILSCALE_PROXY_ALL: "0" }, "https://example.com")).toBe(false);
	});

	it("honors forced routes", () => {
		expect(willProxy(ON, "https://mcp.kagi.com", "proxy")).toBe(true); // force proxy overrides direct-host
		expect(willProxy(ON, "https://example.com", "direct")).toBe(false); // force direct overrides auto
	});
});

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
