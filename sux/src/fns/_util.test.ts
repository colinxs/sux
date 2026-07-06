import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string) =>
		String(url).includes("blocked") ? new Response("Access denied", { status: 403 }) : new Response("<p>content</p>", { status: 200 }),
	),
}));

import { clamp, deliverBytes, fromB64, isHttpUrl, loadHtml, putBlob, stripHtml, toB64 } from "./_util";

function blobEnv() {
	const r2 = new Map<string, Uint8Array>();
	const kv = new Map<string, string>();
	return {
		_r2: r2,
		_kv: kv,
		R2: { put: async (k: string, v: any) => void r2.set(k, new Uint8Array(v)) },
		OAUTH_KV: { put: async (k: string, v: string) => void kv.set(k, v) },
	} as any;
}

describe("putBlob / deliverBytes (shared CAS store)", () => {
	it("content-addresses bytes and mints a /s/<uuid> handle", async () => {
		const env = blobEnv();
		const ref = await putBlob(env, new TextEncoder().encode("hello"), "text/plain");
		expect(ref.key).toBe(`cas/${ref.sha256}`);
		expect(ref.url).toBe(`https://sux.colinxs.workers.dev/s/${ref.uuid}`);
		expect(env._r2.has(ref.key)).toBe(true);
		expect(env._kv.has(`store:${ref.uuid}`)).toBe(true);
	});

	it("dedupes identical bytes to one blob (distinct handles)", async () => {
		const env = blobEnv();
		const a = await putBlob(env, new TextEncoder().encode("same"), "text/plain");
		const b = await putBlob(env, new TextEncoder().encode("same"), "text/plain");
		expect(a.key).toBe(b.key);
		expect(env._r2.size).toBe(1);
	});

	it("deliverBytes as:url returns a compact ref; default stays inline", async () => {
		const env = blobEnv();
		const bytes = new Uint8Array([1, 2, 3]);
		const inline = () => ({ content: [{ type: "text" as const, text: "INLINE" }] });
		const urlMode = await deliverBytes(env, bytes, "image/png", "url", inline);
		const parsed = JSON.parse(urlMode.content[0].text);
		expect(parsed.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(parsed.content_type).toBe("image/png");
		expect((await deliverBytes(env, bytes, "image/png", undefined, inline)).content[0].text).toBe("INLINE");
	});

	it("deliverBytes as:url degrades clearly without R2", async () => {
		const r = await deliverBytes({ OAUTH_KV: { put: async () => {} } } as any, new Uint8Array([1]), "image/png", "url", () => ({ content: [{ type: "text" as const, text: "x" }] }));
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/R2/);
	});
});

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
