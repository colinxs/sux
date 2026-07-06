import { afterEach, describe, expect, it, vi } from "vitest";
import { drainRouteTally, fetchPageViaTailscale, fetchViaTailscale, hmacHex, isDirectHost, isTailscaleConfigured, isTextualContentType, smartFetch, willProxy } from "./proxy";

const ON = { TAILSCALE_PROXY_URL: "https://x.ts.net", TAILSCALE_PROXY_SECRET: "s" };

/** A fetch stub for the proxy endpoint: returns `payload` as the proxy's JSON envelope. */
const proxyEnvelope = (payload: Record<string, unknown>) =>
	new Response(JSON.stringify({ status: 200, statusText: "OK", headers: {}, bytes: 0, truncated: false, ...payload }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

afterEach(() => {
	vi.unstubAllGlobals();
	drainRouteTally(); // don't leak route counts between tests
});

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

describe("binary safety through the proxied path", () => {
	// Every possible byte value — the payload that a JSON-string transport mangles.
	const allBytes = new Uint8Array(256).map((_, i) => i);
	const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

	it("round-trips bytes 0x00-0xFF byte-for-byte when the proxy base64-encodes the body", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: { body?: string }) =>
			proxyEnvelope({ headers: { "content-type": "application/octet-stream" }, bytes: allBytes.length, body: b64(allBytes), bodyEncoding: "base64" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch(ON, "https://example.com/blob.bin");
		expect(new Uint8Array(await resp.arrayBuffer())).toEqual(allBytes);
		// Served entirely by the proxy — no direct refetch needed.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/x\.ts\.net\/fetch\?ts=\d+&sig=[a-f0-9]+$/);
		// The request advertises that this client accepts base64 bodies.
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).acceptBodyEncoding).toBe("base64");
	});

	it("fetchPageViaTailscale preserves a PNG header exactly", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => proxyEnvelope({ headers: { "content-type": "image/png" }, bytes: pngHeader.length, body: b64(pngHeader), bodyEncoding: "base64" })),
		);
		const resp = await fetchPageViaTailscale(ON, "https://example.com/logo.png");
		expect(new Uint8Array(await resp.arrayBuffer())).toEqual(pngHeader);
	});

	it("refetches direct when a legacy proxy returns a binary body as a lossy string", async () => {
		const fetchMock = vi.fn(async (u: string | URL) => {
			if (String(u).startsWith("https://x.ts.net/")) {
				// Legacy transport: the proxy node UTF-8-decoded the PNG → U+FFFD soup.
				return proxyEnvelope({ headers: { "content-type": "image/png" }, bytes: pngHeader.length, body: new TextDecoder().decode(pngHeader) });
			}
			return new Response(pngHeader, { status: 200, headers: { "content-type": "image/png" } });
		});
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch(ON, "https://example.com/logo.png");
		expect(new Uint8Array(await resp.arrayBuffer())).toEqual(pngHeader);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1][0])).toBe("https://example.com/logo.png");
	});

	it("still serves textual bodies from the legacy string transport without a refetch", async () => {
		const fetchMock = vi.fn(async () => proxyEnvelope({ headers: { "content-type": "text/html; charset=utf-8" }, body: "<p>hé</p>" }));
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch(ON, "https://example.com/");
		expect(await resp.text()).toBe("<p>hé</p>");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("classifies content types for string-transport safety", () => {
		expect(isTextualContentType("text/html; charset=utf-8")).toBe(true);
		expect(isTextualContentType("application/json")).toBe(true);
		expect(isTextualContentType("application/rss+xml")).toBe(true);
		expect(isTextualContentType(null)).toBe(true); // no header → legacy behavior
		expect(isTextualContentType("image/png")).toBe(false);
		expect(isTextualContentType("application/pdf")).toBe(false);
		expect(isTextualContentType("application/octet-stream")).toBe(false);
	});
});

describe("smartFetch direct-path timeout", () => {
	it("passes an AbortSignal to the direct/fallback fetch (30s bound)", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		await smartFetch({}, "https://example.com/", {}, "direct");
		const init = fetchMock.mock.calls[0]?.[1];
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("route tally", () => {
	const html = () => proxyEnvelope({ headers: { "content-type": "text/html" }, body: "<p>ok</p>" });

	it("tallies proxied fetches and drains to empty", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => html()));
		await smartFetch(ON, "https://example.com/");
		await smartFetch(ON, "https://example.com/2");
		expect(drainRouteTally()).toEqual({ proxied: 2 });
		expect(drainRouteTally()).toEqual({}); // drained
	});

	it("tallies direct when the proxy is off, forced direct, or the host is direct", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
		await smartFetch({}, "https://example.com/"); // proxy off
		await smartFetch(ON, "https://example.com/", {}, "direct"); // forced
		await smartFetch(ON, "https://mcp.kagi.com/mcp"); // direct host
		expect(drainRouteTally()).toEqual({ direct: 3 });
	});

	it("tallies proxy_fallback when the proxy errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL) => (String(u).startsWith("https://x.ts.net/") ? new Response("boom", { status: 502 }) : new Response("ok"))),
		);
		await smartFetch(ON, "https://example.com/");
		expect(drainRouteTally()).toEqual({ proxy_fallback: 1 });
	});

	it("tallies binary_refetch when a legacy proxy mangles a binary body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL) =>
				String(u).startsWith("https://x.ts.net/")
					? proxyEnvelope({ headers: { "content-type": "image/png" }, body: "�PNG" })
					: new Response("bytes", { status: 200 }),
			),
		);
		await smartFetch(ON, "https://example.com/logo.png");
		expect(drainRouteTally()).toEqual({ binary_refetch: 1 });
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
