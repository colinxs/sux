import { describe, expect, it, vi } from "vitest";

import { smartFetch } from "../proxy";

// Mock the residential proxy so the test is offline & deterministic.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("PAGE BODY", { status: 200 })),
}));

import { geo_fetch } from "./geo_fetch";

describe("geo_fetch", () => {
	it("rejects non-http urls", async () => {
		const r = await geo_fetch.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("passes the geo hint as an x-exit-geo header and returns the body", async () => {
		const mock = vi.mocked(smartFetch);
		mock.mockClear();
		const r = await geo_fetch.run({} as any, { url: "https://x.com", geo: "us-ca" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.geo).toBe("us-ca");
		expect(j.status).toBe(200);
		expect(j.text).toBe("PAGE BODY");
		// Assert the header was forwarded to the proxy.
		const passedInit = mock.mock.calls[0][2] as { headers?: Record<string, string> };
		expect(passedInit.headers?.["x-exit-geo"]).toBe("us-ca");
	});

	it("truncates the body to max_bytes and reports the full byte count", async () => {
		const r = await geo_fetch.run({} as any, { url: "https://x.com", max_bytes: 4 });
		const j = JSON.parse(r.content[0].text);
		expect(j.text).toBe("PAGE");
		expect(j.bytes).toBe("PAGE BODY".length);
		expect(j.geo).toBeNull();
	});

	it("surfaces a fetch failure", async () => {
		vi.mocked(smartFetch).mockRejectedValueOnce(new Error("boom"));
		const r = await geo_fetch.run({} as any, { url: "https://x.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Fetch failed/);
	});

	it("marks upstream error pages noCache (they must not poison the cache)", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("consent wall", { status: 403 }));
		const r = await geo_fetch.run({} as any, { url: "https://x.com/hot" });
		expect(r.isError).toBeFalsy(); // raw transport still returns the body
		expect(r.noCache).toBe(true);
		expect(JSON.parse(r.content[0].text).status).toBe(403);
		// 2xx responses stay cacheable.
		const good = await geo_fetch.run({} as any, { url: "https://x.com" });
		expect(good.noCache).toBeUndefined();
	});
});
