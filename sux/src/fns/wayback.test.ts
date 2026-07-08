import { afterEach, describe, expect, it, vi } from "vitest";
import { wayback } from "./wayback";

afterEach(() => vi.unstubAllGlobals());

const okResp = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("wayback", () => {
	it("returns the closest snapshot", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				okResp({
					archived_snapshots: {
						closest: { available: true, url: "https://web.archive.org/web/20200101000000/https://example.com", timestamp: "20200101000000", status: "200" },
					},
				}),
			),
		);
		const r = await wayback.run({} as any, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.available).toBe(true);
		expect(j.timestamp).toBe("20200101000000");
		expect(j.raw_url).toContain("id_/");
	});

	it("reports when no snapshot is available", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => okResp({ archived_snapshots: {} })));
		const r = await wayback.run({} as any, { url: "https://nope.example" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.available).toBe(false);
	});

	it("rejects a non-absolute url", async () => {
		const r = await wayback.run({} as any, { url: "example.com" });
		expect(r.isError).toBe(true);
	});

	it("lists captures in history mode", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				okResp([
					["timestamp", "original", "statuscode", "digest"],
					["20190101000000", "https://example.com", "200", "AAA"],
					["20200101000000", "https://example.com", "200", "BBB"],
				]),
			),
		);
		const r = await wayback.run({} as any, { url: "https://example.com", mode: "history" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(j.captures[0].url).toContain("/web/20190101000000/");
	});

	it("clamps an oversized history-mode limit to 500", async () => {
		const fetchMock = vi.fn(async () => okResp([["timestamp", "original", "statuscode", "digest"]]));
		vi.stubGlobal("fetch", fetchMock);
		await wayback.run({} as any, { url: "https://example.com", mode: "history", limit: 5000000 });
		const cdx = String((fetchMock.mock.calls[0] as unknown[])[0]);
		expect(cdx).toContain("&limit=500&");
		expect(cdx).not.toContain("5000000");
	});
});
