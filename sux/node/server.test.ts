import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { assertPublicTarget, encodeBody, fetchFollowingSafely, hostAllowed, isPrivateIp, pinnedFetch, verifySignature } from "./server.mjs";

// Guards the residential-proxy binary-egress contract: the node must base64 the
// upstream body and flag bodyEncoding:"base64" so arbitrary bytes survive the
// JSON transport (src/proxy.ts decodes them). Returning a plain utf8 string —
// the previous behavior — mangled non-UTF-8 bytes to U+FFFD and forced the Worker
// to refetch DIRECT, silently defeating residential egress for images/PDFs.
describe("encodeBody (node residential proxy)", () => {
	it("flags base64 and round-trips every byte 0x00-0xFF byte-for-byte", () => {
		const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
		const out = encodeBody(raw);
		expect(out.bodyEncoding).toBe("base64");
		expect(Buffer.from(out.body, "base64").equals(raw)).toBe(true);
	});

	it("base64s text too (uniform with openwrt/fetch.sh — the Worker decodes both)", () => {
		const out = encodeBody(Buffer.from("hello, world", "utf8"));
		expect(out.bodyEncoding).toBe("base64");
		expect(Buffer.from(out.body, "base64").toString("utf8")).toBe("hello, world");
	});

	it("preserves a PNG magic header (the binary that used to trip binary_refetch)", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const decoded = Buffer.from(encodeBody(png).body, "base64");
		expect(decoded.equals(png)).toBe(true);
	});
});

// The SSRF guard is the node's trust boundary: a regression here opens fetches
// into the tailnet / cloud-metadata. These were untested until now.
describe("isPrivateIp (SSRF guard)", () => {
	it("rejects loopback / private / link-local / CGNAT / metadata (IPv4)", () => {
		for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "100.127.0.1", "0.0.0.0"]) {
			expect(isPrivateIp(ip)).toBe(true);
		}
	});
	it("allows genuine public IPv4", () => {
		for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.0.1", "100.128.0.1", "172.15.0.1", "172.32.0.1"]) {
			expect(isPrivateIp(ip)).toBe(false);
		}
	});
	it("handles IPv6 loopback/ULA/link-local and v4-mapped, allows public v6", () => {
		// `::` (unspecified) is the v6 twin of 0.0.0.0 — connect() reaches loopback on Linux.
		for (const ip of ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
		for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPrivateIp(ip)).toBe(false);
	});
	it("catches the compressed HEX v4-mapped form the URL parser emits (::ffff:7f00:1 = 127.0.0.1)", () => {
		// new URL("http://[::ffff:127.0.0.1]") serializes the tail to compressed hex,
		// which matched no IPv4 range before the mappedV4ToDotted decode was added.
		for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:c0a8:101", "::ffff:a00:1"]) expect(isPrivateIp(ip)).toBe(true);
		expect(isPrivateIp("::ffff:808:808")).toBe(false); // 8.8.8.8 mapped — public
	});
	it("fails closed on malformed input (wrong shape / NaN octets)", () => {
		for (const ip of ["not-an-ip", "1.2.3", "1.2.3.4.5", ""]) expect(isPrivateIp(ip)).toBe(true);
	});
});

// assertPublicTarget is the node's entry-point SSRF gate: parse, scheme check,
// allowlist, then resolve + reject any private/loopback/metadata address. IPv6
// literals used to slip past isPrivateIp entirely — the URL parser keeps them
// bracketed, isIP("[::1]") is 0, so the guard degenerated to a DNS lookup that
// merely threw. These pin that the private-range check now actually runs on the
// literal (and public IPv6 literals are accepted), with no DNS round-trip.
describe("assertPublicTarget (entry SSRF gate)", () => {
	// A lookup seam that must never be reached for IP literals (isIP short-circuits).
	const noLookup = async () => {
		throw new Error("lookup must not run for an IP literal");
	};

	it("rejects a non-http(s) scheme and unparseable garbage", async () => {
		await expect(assertPublicTarget("file:///etc/passwd", noLookup)).rejects.toThrow(/only http\/https/);
		await expect(assertPublicTarget("not a url", noLookup)).rejects.toThrow();
	});

	it("rejects IPv6-literal private targets without any DNS lookup (bracket-stripped)", async () => {
		for (const url of ["http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/"]) {
			await expect(assertPublicTarget(url, noLookup)).rejects.toThrow(/private address/);
		}
	});

	it("rejects IPv4-literal private/metadata targets", async () => {
		for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://10.0.0.1/"]) {
			await expect(assertPublicTarget(url, noLookup)).rejects.toThrow(/private address/);
		}
	});

	it("accepts a public IPv6 literal (previously rejected as unresolvable)", async () => {
		const { url, address } = await assertPublicTarget("http://[2606:4700:4700::1111]/", noLookup);
		expect(url.hostname).toBe("[2606:4700:4700::1111]");
		expect(address).toBe("2606:4700:4700::1111"); // bracket-stripped literal is the pin target
	});

	it("re-checks every DNS-resolved address and rejects a host that resolves private (rebinding)", async () => {
		const lookupPrivate = async () => [{ address: "203.0.113.10" }, { address: "10.1.2.3" }];
		await expect(assertPublicTarget("http://rebind.example/", lookupPrivate)).rejects.toThrow(/private address \(10\.1\.2\.3\)/);
	});

	it("accepts a hostname that resolves to only public addresses and pins the first vetted address", async () => {
		const lookupPublic = async () => [{ address: "93.184.216.34" }, { address: "2606:4700::1" }];
		const { url, address } = await assertPublicTarget("https://public.example/path", lookupPublic);
		expect(url.href).toBe("https://public.example/path");
		// The connection must go to an address we actually checked, not a re-resolution.
		expect(address).toBe("93.184.216.34");
	});
});

// The DNS-rebinding TOCTOU fix: vetting an address is worthless if the connection
// re-resolves the hostname. pinnedFetch forces the socket onto the vetted IP via
// node's low-level `lookup` hook while keeping the hostname for the Host header and
// TLS SNI/cert check — so a TTL-0 rebind after assertPublicTarget's check can't
// steer the connection to 127.0.0.1 / 169.254.169.254 / the LAN.
describe("pinnedFetch (DNS-pinned connection)", () => {
	// Fake node http(s).request that captures the options and streams a canned response.
	function fakeTransport(bodyChunks: string[] = ["OK"], resHeaders: Record<string, unknown> = { "content-type": "text/plain" }, status = 200) {
		const captured: { url?: unknown; options?: any } = {};
		const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
		req.write = () => {};
		req.end = () => {};
		req.destroy = () => {};
		const requestImpl = (urlArg: unknown, options: any, cb: (res: unknown) => void) => {
			captured.url = urlArg;
			captured.options = options;
			const res = Readable.from(bodyChunks.map((c) => Buffer.from(c))) as Readable & { statusCode: number; statusMessage: string; headers: Record<string, unknown> };
			res.statusCode = status;
			res.statusMessage = "OK";
			res.headers = resHeaders;
			queueMicrotask(() => cb(res));
			return req;
		};
		return { captured, requestImpl };
	}

	it("pins the socket to the vetted IP (lookup ignores the hostname) and keeps SNI = hostname", async () => {
		const { captured, requestImpl } = fakeTransport(["OK"]);
		const resp = await pinnedFetch("https://shop.example/p", { method: "GET", headers: {} }, "93.184.216.34", { requestImpl });
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("OK");
		// lookup yields the vetted IP no matter what host it's asked to resolve.
		const seen = await new Promise<{ addr: string; fam: number }>((res) => captured.options.lookup("shop.example", {}, (_e: unknown, addr: string, fam: number) => res({ addr, fam })));
		expect(seen.addr).toBe("93.184.216.34");
		expect(seen.fam).toBe(4);
		// SNI/cert still validated against the real hostname, not the literal IP.
		expect(captured.options.servername).toBe("shop.example");
	});

	it("pins an IPv6 address with family 6 and sets no servername for plain http", async () => {
		const { captured, requestImpl } = fakeTransport(["hi"]);
		await pinnedFetch("http://ipv6.example/", { headers: {} }, "2606:4700::1", { requestImpl });
		const fam = await new Promise<number>((res) => captured.options.lookup("ipv6.example", {}, (_e: unknown, _a: string, f: number) => res(f)));
		expect(fam).toBe(6);
		expect(captured.options.servername).toBeUndefined();
	});

	it("refuses to connect without a vetted address (no unpinned fetch fallback)", () => {
		expect(() => pinnedFetch("https://x.example/", {}, undefined as unknown as string, {})).toThrow(/vetted address/);
	});
});

describe("hostAllowed", () => {
	it("allows anything when the allowlist is empty", () => {
		expect(hostAllowed("evil.example.com", [])).toBe(true);
	});
	it("suffix-matches the allowlist (exact + subdomain), rejects others", () => {
		const allow = ["homedepot.com", "kagi.com"];
		expect(hostAllowed("homedepot.com", allow)).toBe(true);
		expect(hostAllowed("www.homedepot.com", allow)).toBe(true);
		expect(hostAllowed("KAGI.COM", allow)).toBe(true);
		expect(hostAllowed("evil.com", allow)).toBe(false);
		expect(hostAllowed("nothomedepot.com", allow)).toBe(false); // not a real subdomain
	});
});

describe("verifySignature (HMAC auth)", () => {
	const secret = "test-secret-0123456789";
	const sign = (ts: string, body: string) => createHmac("sha256", secret).update(`${ts}\n${body}`).digest("hex");

	it("accepts a correct, fresh signature", () => {
		const ts = String(Date.now());
		expect(verifySignature(ts, '{"url":"https://x"}', sign(ts, '{"url":"https://x"}'), secret)).toBe(true);
	});
	it("rejects a tampered body, wrong sig, missing fields, and a stale timestamp", () => {
		const ts = String(Date.now());
		const body = '{"url":"https://x"}';
		expect(verifySignature(ts, '{"url":"https://EVIL"}', sign(ts, body), secret)).toBe(false); // body tampered
		expect(verifySignature(ts, body, "deadbeef", secret)).toBe(false); // wrong sig
		expect(verifySignature(ts, body, "", secret)).toBe(false); // missing sig
		expect(verifySignature("", body, sign(ts, body), secret)).toBe(false); // missing ts
		const stale = String(Date.now() - 10 * 60 * 1000); // 10 min > 5 min skew
		expect(verifySignature(stale, body, sign(stale, body), secret)).toBe(false);
	});
	it("rejects non-hex signatures without throwing", () => {
		const ts = String(Date.now());
		expect(verifySignature(ts, "body", "nothex!!", secret)).toBe(false);
	});
});

// The entry URL is SSRF-guarded, but the node used to follow redirects with
// undici's redirect:"follow", which chases a 3xx Location WITHOUT re-checking —
// so a public page that 302-redirects to http://192.168.1.1/ or the cloud
// metadata IP would be fetched from inside the home LAN. fetchFollowingSafely
// re-validates every hop; these pin that the guard runs on redirect targets too.
describe("fetchFollowingSafely (SSRF-safe redirect follower)", () => {
	// Stand-in for assertPublicTarget: throws for the known-private hosts, else returns
	// the { url, address } shape the real guard hands back (address pins the connection).
	const assertTarget = async (href: string) => {
		const h = new URL(href).hostname;
		if (h === "169.254.169.254" || h === "192.168.1.1") throw new Error(`target resolves to a private address (${h})`);
		return { url: new URL(href), address: "203.0.113.5" };
	};

	it("re-runs the SSRF guard on a redirect hop and refuses a redirect into the LAN", async () => {
		let privateFetched = false;
		const fetchImpl = async (url: Parameters<typeof fetch>[0]) => {
			if (String(url).includes("169.254.169.254")) {
				privateFetched = true; // must never happen — the guard runs BEFORE the hop is fetched
				return new Response("SECRET", { status: 200 });
			}
			return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
		};
		await expect(fetchFollowingSafely("https://example.com/", {}, { fetchImpl, assertTarget })).rejects.toThrow(/private address/);
		expect(privateFetched).toBe(false);
	});

	it("resolves a relative Location against the current hop before the SSRF re-check", async () => {
		// A bare "/path" Location must resolve against the *redirecting* host, not be
		// treated as opaque — the guard must see the real absolute target of the hop.
		const seen: string[] = [];
		const fetchImpl = async (url: Parameters<typeof fetch>[0]) => {
			seen.push(String(url));
			return String(url).endsWith("/next")
				? new Response("OK", { status: 200 })
				: new Response(null, { status: 302, headers: { location: "/next" } });
		};
		const resp = await fetchFollowingSafely("https://pub.example/start", {}, { fetchImpl, assertTarget: async (h) => ({ url: new URL(h), address: "203.0.113.5" }) });
		expect(resp.status).toBe(200);
		// The relative "/next" resolved to the redirecting host, not some bare path.
		expect(seen).toEqual(["https://pub.example/start", "https://pub.example/next"]);
	});

	it("follows a redirect to another public host and returns the final response", async () => {
		const pass = async (href: string) => ({ url: new URL(href), address: "203.0.113.5" });
		const fetchImpl = async (url: Parameters<typeof fetch>[0]) =>
			String(url).includes("start.example")
				? new Response(null, { status: 301, headers: { location: "https://final.example/ok" } })
				: new Response("OK", { status: 200 });
		const resp = await fetchFollowingSafely("https://start.example/", {}, { fetchImpl, assertTarget: pass });
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe("OK");
	});

	it("caps the redirect chain instead of looping forever", async () => {
		const pass = async (href: string) => ({ url: new URL(href), address: "203.0.113.5" });
		const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://loop.example/next" } });
		await expect(fetchFollowingSafely("https://loop.example/", {}, { fetchImpl, assertTarget: pass, maxHops: 3 })).rejects.toThrow(/too many redirects/);
	});
});
