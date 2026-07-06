import { describe, expect, it, vi } from "vitest";

// Mock the residential proxy so the test is offline & deterministic.
vi.mock("../proxy", () => ({
	smartFetch: async () =>
		new Response('{"ok":true,"n":42}', {
			status: 200,
			statusText: "OK",
			headers: { "content-type": "application/json", "x-test": "1" },
		}),
}));

import { protocol } from "./protocol";

describe("protocol", () => {
	it("rejects non-http urls", async () => {
		const r = await protocol.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("as=headers returns status + headers", async () => {
		const r = await protocol.run({} as any, { url: "https://x.com", as: "headers" });
		expect(r.content[0].text).toContain('"status": 200');
		expect(r.content[0].text).toContain("x-test");
	});

	it("as=json parses the body", async () => {
		const r = await protocol.run({} as any, { url: "https://x.com", as: "json" });
		expect(r.content[0].text).toContain('"n": 42');
	});

	it("as=text truncates at max_bytes", async () => {
		const r = await protocol.run({} as any, { url: "https://x.com", as: "text", max_bytes: 5 });
		expect(r.content[0].text).toMatch(/truncated at 5 bytes/);
	});
});
