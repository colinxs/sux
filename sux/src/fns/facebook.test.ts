import { afterEach, describe, expect, it, vi } from "vitest";
import { facebook } from "./facebook";

afterEach(() => vi.unstubAllGlobals());

describe("facebook", () => {
	it("reports when FACEBOOK_TOKEN is not configured", async () => {
		const r = await facebook.run({} as any, { path: "me" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/FACEBOOK_TOKEN/);
	});

	it("requires a path and rejects a URL as the path", async () => {
		expect((await facebook.run({ FACEBOOK_TOKEN: "t" } as any, { path: "" })).content[0].text).toMatch(/`path` is required/);
		expect((await facebook.run({ FACEBOOK_TOKEN: "t" } as any, { path: "https://evil" })).content[0].text).toMatch(/bare graph path/);
	});

	it("fetches a graph node with fields + limit and returns the JSON", async () => {
		const fetchMock = vi.fn(async (u: string | URL) => {
			expect(String(u)).toContain("/v25.0/me?");
			expect(String(u)).toContain("fields=id%2Cname");
			expect(String(u)).toContain("access_token=t");
			return new Response(JSON.stringify({ id: "1", name: "Page" }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await facebook.run({ FACEBOOK_TOKEN: "t" } as any, { path: "me", fields: "id,name", limit: 5 });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toEqual({ id: "1", name: "Page" });
	});

	it("surfaces a Graph API error message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth token" } }), { status: 400 })));
		const r = await facebook.run({ FACEBOOK_TOKEN: "t" } as any, { path: "me" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid OAuth token/);
	});
});
