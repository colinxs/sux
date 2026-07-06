import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("<html><body>Too Many Requests</body></html>", { status: 429 })),
}));

import { declutter } from "./declutter";

const run = async (args: any) => (await declutter.run({} as any, args)).content[0].text;

const PAGE = `<html><head><style>.x{}</style><script>track()</script></head>
<body>
<div class="cookie-consent">Accept cookies?</div>
<nav>menu</nav>
<article><h1 onclick="log()">Real Title</h1><p>The actual content worth summarizing.</p></article>
<div id="ad-slot-top"><ins class="adsbygoogle"></ins></div>
<img src="https://google-analytics.com/collect" width="1" height="1">
<div class="newsletter-signup">Subscribe!</div>
</body></html>`;

describe("declutter", () => {
	it("removes scripts, styles, ads, consent/newsletter blocks and tracking pixels", async () => {
		const out = await run({ html: PAGE });
		expect(out).toContain("Real Title");
		expect(out).toContain("actual content");
		expect(out).not.toMatch(/track\(\)/);
		expect(out).not.toMatch(/adsbygoogle/);
		expect(out).not.toMatch(/Accept cookies/);
		expect(out).not.toMatch(/Subscribe!/);
		expect(out).not.toMatch(/google-analytics/);
	});

	it("strips inline event handlers", async () => {
		expect(await run({ html: '<h1 onclick="x()">Hi</h1>' })).not.toMatch(/onclick/);
	});

	it("returns plain text when to=text", async () => {
		const out = await run({ html: PAGE, to: "text" });
		expect(out).toContain("Real Title");
		expect(out).not.toContain("<");
	});

	it("errors without html or url", async () => {
		expect((await declutter.run({} as any, {})).isError).toBe(true);
	});

	it("fails on an upstream error page instead of cleaning it", async () => {
		const r = await declutter.run({} as any, { url: "https://example.com" });
		expect(r.isError).toBe(true); // errors never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
