import { afterEach, describe, expect, it, vi } from "vitest";

const smartFetch = vi.fn();
vi.mock("../proxy", () => ({ smartFetch: (...a: any[]) => smartFetch(...(a as [])) }));

import { youtube } from "./youtube";

const PAGE_WITH_CAPTIONS =
	`<html><head><meta property="og:title" content="Cool &amp; Video"></head><body>` +
	`var x = {"captionTracks":[{"baseUrl":"https://youtube.com/api/timedtext?v=abc\\u0026lang=en","name":{}}]};` +
	`</body></html>`;

const CAPTION_JSON3 = JSON.stringify({
	events: [{ segs: [{ utf8: "Hello" }, { utf8: " world" }] }, { segs: [{ utf8: " again" }] }],
});

afterEach(() => smartFetch.mockReset());

describe("youtube", () => {
	it("extracts title and transcript from a watch url", async () => {
		smartFetch
			.mockResolvedValueOnce(new Response(PAGE_WITH_CAPTIONS, { status: 200 }))
			.mockResolvedValueOnce(new Response(CAPTION_JSON3, { status: 200 }));
		const r = await youtube.run({} as any, { video: "https://www.youtube.com/watch?v=abcdefghijk" });
		const out = JSON.parse(r.content[0].text);
		expect(out.id).toBe("abcdefghijk");
		expect(out.title).toBe("Cool & Video");
		expect(out.transcript).toBe("Hello world again");
	});

	it("accepts a bare id and reports missing captions", async () => {
		smartFetch.mockResolvedValueOnce(
			new Response(`<meta property="og:title" content="No Caps">no tracks here`, { status: 200 }),
		);
		const r = await youtube.run({} as any, { video: "abcdefghijk" });
		const out = JSON.parse(r.content[0].text);
		expect(out.id).toBe("abcdefghijk");
		expect(out.transcript).toMatch(/Captions unavailable/);
	});

	it("rejects an unparseable video argument", async () => {
		const r = await youtube.run({} as any, { video: "not a video" });
		expect(r.isError).toBe(true);
	});

	it("fails (uncached) when the watch page is rate-limited", async () => {
		smartFetch.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
		const r = await youtube.run({} as any, { video: "abcdefghijk" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});

	it("marks a transient caption-endpoint failure noCache", async () => {
		smartFetch
			.mockResolvedValueOnce(new Response(PAGE_WITH_CAPTIONS, { status: 200 }))
			.mockResolvedValueOnce(new Response("boom", { status: 503 }));
		const r = await youtube.run({} as any, { video: "abcdefghijk" });
		expect(r.isError).toBeFalsy();
		expect(r.noCache).toBe(true);
		expect(JSON.parse(r.content[0].text).transcript).toMatch(/HTTP 503/);
	});
});
