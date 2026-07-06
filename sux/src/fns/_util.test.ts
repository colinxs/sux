import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string) => {
		if (String(url).includes("blocked")) return new Response("Access denied", { status: 403 });
		if (String(url).includes("boom")) throw new Error("socket hang up");
		if (String(url).includes("huge")) return new Response("x".repeat(50_000), { status: 200 });
		if (String(url).includes("binary")) return new Response(new Uint8Array([0, 1, 0xff, 0x80, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
		return new Response("<p>content</p>", { status: 200 });
	}),
}));

import { clamp, deliverBytes, extractStoreId, fetchText, fetchTextOk, fromB64, isHttpUrl, loadBytes, loadHtml, noCacheOn4xx, putBlob, storeBase, storeRefUuid, stripHtml, toB64 } from "./_util";

function blobEnv() {
	const r2 = new Map<string, Uint8Array>();
	const kv = new Map<string, string>();
	return {
		_r2: r2,
		_kv: kv,
		R2: {
			put: async (k: string, v: any) => void r2.set(k, new Uint8Array(v)),
			get: async (k: string) => {
				const b = r2.get(k);
				return b ? { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => new TextDecoder().decode(b) } : null;
			},
		},
		OAUTH_KV: { put: async (k: string, v: string) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null },
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

describe("loadBytes (shared binary loader)", () => {
	it("decodes inline base64", async () => {
		const { bytes } = await loadBytes({} as any, { base64: toB64(new Uint8Array([1, 2, 250])) });
		expect([...bytes]).toEqual([1, 2, 250]);
	});

	it("fetches a url binary-safely and reports the content type", async () => {
		const { bytes, contentType } = await loadBytes({} as any, { url: "https://example.com/binary.jpg" });
		expect([...bytes]).toEqual([0, 1, 0xff, 0x80, 0xd9]);
		expect(contentType).toBe("image/jpeg");
	});

	it("rejects HTTP >= 400", async () => {
		await expect(loadBytes({} as any, { url: "https://blocked.example/x" })).rejects.toThrow(/HTTP 403/);
	});

	it("rejects when neither base64 nor a valid url is given", async () => {
		await expect(loadBytes({} as any, {})).rejects.toThrow(/base64/);
		await expect(loadBytes({} as any, { url: "ftp://x" })).rejects.toThrow(/http/);
	});

	it("short-circuits the worker's own /s/<uuid> refs to a direct KV→R2 read", async () => {
		const env = blobEnv();
		const payload = new Uint8Array([9, 8, 7, 0xff]);
		const ref = await putBlob(env, payload, "application/pdf");
		const { smartFetch } = await import("../proxy");
		vi.mocked(smartFetch as any).mockClear();
		const { bytes, contentType } = await loadBytes(env, { url: ref.url });
		expect([...bytes]).toEqual([...payload]);
		expect(contentType).toBe("application/pdf");
		expect(smartFetch).not.toHaveBeenCalled();
	});

	it("errors for a /s/ ref whose handle is missing", async () => {
		const env = blobEnv();
		await expect(loadBytes(env, { url: `${storeBase(env)}/s/00000000-0000-0000-0000-000000000000` })).rejects.toThrow(/No stored object/);
	});
});

describe("store base + ref parsing", () => {
	it("storeBase prefers the STORE_BASE env var (trailing slash trimmed)", () => {
		expect(storeBase({} as any)).toBe("https://sux.colinxs.workers.dev");
		expect(storeBase({ STORE_BASE: "https://staging.example/" } as any)).toBe("https://staging.example");
	});

	it("putBlob mints urls on the configured base", async () => {
		const env = blobEnv();
		env.STORE_BASE = "https://staging.example";
		const ref = await putBlob(env, new Uint8Array([1]), "text/plain");
		expect(ref.url).toMatch(/^https:\/\/staging\.example\/s\//);
	});

	it("storeRefUuid recognizes only /s/<uuid> paths", () => {
		const u = "3f0a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b";
		expect(storeRefUuid(`https://sux.colinxs.workers.dev/s/${u}`)).toBe(u);
		expect(storeRefUuid(`https://other.host/s/${u}/`)).toBe(u);
		expect(storeRefUuid("https://example.com/page")).toBeNull();
		expect(storeRefUuid(`https://example.com/x/s/${u}`)).toBeNull();
		expect(storeRefUuid("not a url")).toBeNull();
	});

	it("extractStoreId accepts a bare uuid or a /s/<uuid> url", () => {
		const u = "3f0a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b";
		expect(extractStoreId(u)).toBe(u);
		expect(extractStoreId(`https://x/s/${u}`)).toBe(u);
		expect(extractStoreId(" raw-key ")).toBe("raw-key");
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

	it("resolves the worker's own /s/<uuid> refs so text fns accept blob refs", async () => {
		const env = blobEnv();
		const ref = await putBlob(env, new TextEncoder().encode("<h1>stored</h1>"), "text/html");
		const viaLoadHtml = await loadHtml(env, { url: ref.url });
		expect("html" in viaLoadHtml && viaLoadHtml.html).toBe("<h1>stored</h1>");
		const viaFetchText = await fetchText(env, ref.url);
		expect(viaFetchText.status).toBe(200);
		expect(viaFetchText.text).toBe("<h1>stored</h1>");
		expect(viaFetchText.headers.get("content-type")).toBe("text/html");
	});

	it("returns 404 from fetchText for a missing /s/ handle", async () => {
		const env = blobEnv();
		const r = await fetchText(env, `${storeBase(env)}/s/00000000-0000-0000-0000-000000000000`);
		expect(r.status).toBe(404);
	});

	it("prefers inline html and validates the url", async () => {
		expect(await loadHtml({} as any, { html: "<i>x</i>" })).toEqual({ html: "<i>x</i>" });
		expect("error" in (await loadHtml({} as any, { url: "ftp://x" }))).toBe(true);
		expect("error" in (await loadHtml({} as any, {}))).toBe(true);
	});
});

describe("fetchTextOk (the fetch-validation seam)", () => {
	it("returns text/status/headers for a 2xx fetch", async () => {
		const r = await fetchTextOk({} as any, "https://ok.example");
		expect("text" in r && r.text).toBe("<p>content</p>");
		expect("status" in r && r.status).toBe(200);
	});

	it("rejects non-http(s) urls with a unified error", async () => {
		const r = await fetchTextOk({} as any, "ftp://x");
		expect("error" in r && r.error).toMatch(/http\(s\)/);
	});

	it("surfaces HTTP >= 400 as an error, not content", async () => {
		const r = await fetchTextOk({} as any, "https://blocked.example");
		expect("error" in r && r.error).toMatch(/HTTP 403/);
	});

	it("wraps a thrown fetch in the same error shape", async () => {
		const r = await fetchTextOk({} as any, "https://boom.example");
		expect("error" in r && r.error).toMatch(/Fetch failed: socket hang up/);
	});
});

describe("fetchText streaming byte cap", () => {
	it("caps the body at maxBytes without buffering the rest", async () => {
		const r = await fetchText({} as any, "https://huge.example", { maxBytes: 1000 });
		expect(r.text.length).toBe(1000);
	});

	it("applies the 2MB default cap but returns small bodies whole", async () => {
		const r = await fetchText({} as any, "https://huge.example");
		expect(r.text.length).toBe(50_000);
	});

	it("does not split a multi-byte character at the cap boundary", async () => {
		const { smartFetch } = await import("../proxy");
		// "é" is 2 bytes in UTF-8; cap of 3 bytes lands mid-character.
		vi.mocked(smartFetch as any).mockResolvedValueOnce(new Response("éé", { status: 200 }));
		const r = await fetchText({} as any, "https://utf8.example", { maxBytes: 3 });
		expect(r.text).toBe("é"); // partial trailing bytes are dropped, not U+FFFD'd
	});
});

describe("noCacheOn4xx", () => {
	it("flags 4xx/5xx and leaves 2xx/3xx cacheable", () => {
		expect(noCacheOn4xx({ content: [] } as any, 200).noCache).toBeUndefined();
		expect(noCacheOn4xx({ content: [] } as any, 302).noCache).toBeUndefined();
		expect(noCacheOn4xx({ content: [] } as any, 403).noCache).toBe(true);
		expect(noCacheOn4xx({ content: [] } as any, 500).noCache).toBe(true);
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
