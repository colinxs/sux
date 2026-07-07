import { describe, expect, it, vi } from "vitest";

const ROBOTS = ["User-agent: *", "Disallow: /admin", "Allow: /admin/public", "Crawl-delay: 5", "", "Sitemap: https://x.com/sitemap.xml"].join("\n");

// Mock the residential proxy so the test is offline & deterministic.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response(ROBOTS, { status: 200, statusText: "OK", headers: { "content-type": "text/plain" } })),
}));

import { robots } from "./robots";

describe("robots", () => {
	it("rejects non-http urls", async () => {
		const r = await robots.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("parses agent groups, crawl-delay and sitemaps from the origin", async () => {
		const r = await robots.run({} as any, { url: "https://x.com/some/page" });
		const j = JSON.parse(r.content[0].text);
		expect(j.origin).toBe("https://x.com");
		expect(j.groups[0].agents).toContain("*");
		expect(j.groups[0].disallow).toContain("/admin");
		expect(j.groups[0].crawl_delay).toBe(5);
		expect(j.sitemaps).toContain("https://x.com/sitemap.xml");
	});

	it("tests a path via longest-match (Allow overrides a shorter Disallow)", async () => {
		const denied = await robots.run({} as any, { url: "https://x.com", path: "/admin/secret" });
		expect(JSON.parse(denied.content[0].text).allowed).toBe(false);

		const allowed = await robots.run({} as any, { url: "https://x.com", path: "/admin/public/x" });
		expect(JSON.parse(allowed.content[0].text).allowed).toBe(true);
	});
});
