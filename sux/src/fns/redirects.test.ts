import { afterEach, describe, expect, it, vi } from "vitest";

import { redirects } from "./redirects";

afterEach(() => vi.unstubAllGlobals());

describe("redirects", () => {
	it("rejects non-http urls", async () => {
		const r = await redirects.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("follows the redirect chain to the final destination", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "http://a.com/") return new Response(null, { status: 301, headers: { location: "https://b.com/final" } });
				return new Response(null, { status: 200 });
			}),
		);
		const r = await redirects.run({} as any, { url: "http://a.com/" });
		const j = JSON.parse(r.content[0].text);
		expect(j.hops).toBe(2);
		expect(j.chain[0].status).toBe(301);
		expect(j.chain[0].location).toBe("https://b.com/final");
		expect(j.final).toBe("https://b.com/final");
	});

	it("reports a fetch failure with the offending url", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("boom");
			}),
		);
		const r = await redirects.run({} as any, { url: "https://x.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Fetch failed/);
	});

	it("returns the chain gathered so far when a hop emits a malformed Location", async () => {
		// A malformed Location header (301 -> `https://[invalid`) makes `new URL` throw.
		// That resolution is now inside a try/catch, so the trace stops at the bad hop and
		// returns the chain already collected instead of failing the whole tool.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "http://a.com/") return new Response(null, { status: 301, headers: { location: "https://[invalid" } });
				return new Response(null, { status: 200 });
			}),
		);
		const r = await redirects.run({} as any, { url: "http://a.com/" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.hops).toBe(1);
		expect(j.chain[0].status).toBe(301);
		expect(j.chain[0].location).toBe("https://[invalid");
		expect(j.final).toBe("http://a.com/");
	});

	it("refuses to follow a redirect into a private/metadata address (SSRF guard runs on every hop)", async () => {
		// The fn follows a redirect chain hop by hop on the Worker; each hop re-enters
		// the REAL smartFetch, whose isBlockedTarget guard is the SSRF defense. A public
		// page that 302s to the cloud-metadata IP must be refused BEFORE that internal
		// address is ever contacted — the guard throws ahead of any network call, so the
		// metadata endpoint is never fetched. Only global `fetch` is stubbed here (env={}
		// keeps the proxy off), so smartFetch's guard runs unmocked exactly as in prod.
		const fetchMock = vi.fn(async (url: string | URL) => {
			if (String(url) === "https://pub.example/") {
				return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
			}
			return new Response("SHOULD-NEVER-BE-FETCHED", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const r = await redirects.run({} as any, { url: "https://pub.example/" });

		expect(r.isError).toBe(true);
		// Refused at the metadata hop, surfacing the guard's reason and the blocked url.
		expect(r.content[0].text).toMatch(/Fetch failed at http:\/\/169\.254\.169\.254\//);
		expect(r.content[0].text).toMatch(/blocked target/i);
		// The internal address was never actually contacted — only the public first hop.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://pub.example/");
	});
});
