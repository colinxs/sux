import { afterEach, describe, expect, it, vi } from "vitest";
import { stackexchange } from "./stackexchange";

const BODY = {
	items: [
		{
			title: "How do I &quot;git&quot; &amp; rebase?",
			link: "https://stackoverflow.com/q/1",
			score: 12,
			is_answered: true,
			answer_count: 3,
			tags: ["git", "rebase"],
			creation_date: 1600000000,
		},
	],
};

afterEach(() => vi.restoreAllMocks());

describe("stackexchange", () => {
	it("normalizes items into { title, url, score, answered, answers, tags, created }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await stackexchange.run({} as any, { term: "git rebase", pagesize: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.site).toBe("stackoverflow");
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.title).toBe('How do I "git" & rebase?');
		expect(e.url).toBe("https://stackoverflow.com/q/1");
		expect(e.score).toBe(12);
		expect(e.answered).toBe(true);
		expect(e.answers).toBe(3);
		expect(e.tags).toEqual(["git", "rebase"]);
		expect(e.created).toBe(1600000000);
	});

	it("passes term, site, pagesize and default params; no key when unset", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		await stackexchange.run({} as any, { term: "systemd", site: "superuser", pagesize: 8 });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("q=systemd");
		expect(url).toContain("site=superuser");
		expect(url).toContain("pagesize=8");
		expect(url).toContain("filter=withbody");
		expect(url).toContain("sort=relevance");
		expect(url).not.toContain("key=");
	});

	it("appends the key when STACKEXCHANGE_KEY is set", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		await stackexchange.run({ STACKEXCHANGE_KEY: "quotakey" } as any, { term: "x" });
		expect(String(spy.mock.calls[0][0])).toContain("key=quotakey");
	});

	it("errors without a term", async () => {
		const r = await stackexchange.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
		const r = await stackexchange.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/400/);
	});

	it("hints at the anonymous quota on a keyless 403", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
		const r = await stackexchange.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/403/);
		expect(r.content[0].text).toMatch(/quota/i);
	});

	it("omits the quota hint on a 403 when a key is already set", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
		const r = await stackexchange.run({ STACKEXCHANGE_KEY: "k" } as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).not.toMatch(/quota/i);
	});
});
