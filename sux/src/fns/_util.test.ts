import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string) =>
		String(url).includes("blocked") ? new Response("Access denied", { status: 403 }) : new Response("<p>content</p>", { status: 200 }),
	),
}));

import { clamp, fromB64, isHttpUrl, loadHtml, stripHtml, toB64 } from "./_util";

describe("loadHtml", () => {
	it("returns html for a 2xx fetch", async () => {
		const r = await loadHtml({} as any, { url: "https://ok.example" });
		expect("html" in r && r.html).toBe("<p>content</p>");
	});

	it("returns an error (not the body) for a 4xx/5xx page", async () => {
		const r = await loadHtml({} as any, { url: "https://blocked.example" });
		expect("error" in r && r.error).toMatch(/HTTP 403/);
	});

	it("prefers inline html and validates the url", async () => {
		expect(await loadHtml({} as any, { html: "<i>x</i>" })).toEqual({ html: "<i>x</i>" });
		expect("error" in (await loadHtml({} as any, { url: "ftp://x" }))).toBe(true);
		expect("error" in (await loadHtml({} as any, {}))).toBe(true);
	});
});

describe("_util", () => {
	it("isHttpUrl", () => {
		expect(isHttpUrl("https://x.com")).toBe(true);
		expect(isHttpUrl("ftp://x")).toBe(false);
		expect(isHttpUrl(42)).toBe(false);
	});

	it("clamp marks truncation", () => {
		expect(clamp("abc", 10)).toBe("abc");
		expect(clamp("abcdef", 3)).toMatch(/^abc\n… \[truncated/);
	});

	it("base64 round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
		expect([...fromB64(toB64(bytes))]).toEqual([...bytes]);
	});

	it("stripHtml removes tags and decodes entities", () => {
		expect(stripHtml("<p>a &amp; <b>b</b></p><script>x()</script>")).toBe("a & b");
	});
});
