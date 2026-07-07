import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBody, hostAllowed, isPrivateIp, verifySignature } from "./server.mjs";

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
	it("fails closed on malformed input (wrong shape / NaN octets)", () => {
		for (const ip of ["not-an-ip", "1.2.3", "1.2.3.4.5", ""]) expect(isPrivateIp(ip)).toBe(true);
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
