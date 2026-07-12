import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string) => {
		if (String(url).includes("blocked")) return new Response("Access denied", { status: 403 });
		if (String(url).includes("boom")) throw new Error("socket hang up");
		if (String(url).includes("huge")) return new Response("x".repeat(50_000), { status: 200 });
		if (String(url).includes("toobig")) return new Response(new Uint8Array(500_000), { status: 200, headers: { "content-type": "application/octet-stream" } });
		if (String(url).includes("binary")) return new Response(new Uint8Array([0, 1, 0xff, 0x80, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
		return new Response("<p>content</p>", { status: 200 });
	}),
}));

import {
	byteBudget,
	clamp,
	clearFetchCache,
	deliverBytes,
	extractStoreId,
	FETCH_CACHE_MAX_ENTRIES,
	FETCH_CACHE_TTL_MS,
	fetchCacheGet,
	fetchCacheSet,
	fetchText,
	fetchTextOk,
	fromB64,
	isHttpUrl,
	loadBytes,
	loadHtml,
	noCacheOn4xx,
	oj,
	pool,
	putBlob,
	setFetchDedup,
	storeBase,
	storeRefUuid,
	stripHtml,
	toB64,
} from "./_util";

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

	it("caps the fetched body — a body over maxBytes is rejected, not buffered whole", async () => {
		// 500KB response with a 1KB cap: the stream must abort past the cap.
		await expect(loadBytes({} as any, { url: "https://example.com/toobig.bin" }, 1_000)).rejects.toThrow(/too large/i);
	});

	it("allows a body within the cap", async () => {
		const { bytes } = await loadBytes({} as any, { url: "https://example.com/toobig.bin" }, 1_000_000);
		expect(bytes.byteLength).toBe(500_000);
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

	it("oj serializes compactly (no pretty whitespace) and round-trips", () => {
		const x = { a: 1, b: [2, 3], c: { d: "e" } };
		const s = oj(x);
		expect(s).toBe('{"a":1,"b":[2,3],"c":{"d":"e"}}');
		expect(s).not.toMatch(/\n/);
		expect(JSON.parse(s)).toEqual(x);
	});
});

describe("in-isolate fetch dedup cache", () => {
	it("returns a fresh entry and evicts it once past the TTL", () => {
		clearFetchCache();
		const entry = { at: 1000, status: 200, text: "<p>x</p>", headers: { "content-type": "text/html" }, url: "https://a.com" };
		fetchCacheSet("k", entry);
		expect(fetchCacheGet("k", 1000)).toEqual(entry); // same instant
		expect(fetchCacheGet("k", 1000 + FETCH_CACHE_TTL_MS)).toEqual(entry); // exactly at TTL still fresh
		expect(fetchCacheGet("k", 1000 + FETCH_CACHE_TTL_MS + 1)).toBeNull(); // expired → evicted
		expect(fetchCacheGet("k", 1000)).toBeNull(); // and gone
	});

	it("evicts the oldest entry when the cap is exceeded", () => {
		clearFetchCache();
		for (let i = 0; i < FETCH_CACHE_MAX_ENTRIES; i++) {
			fetchCacheSet(`k${i}`, { at: 0, status: 200, text: "x", headers: {}, url: `https://x/${i}` });
		}
		expect(fetchCacheGet("k0", 0)).not.toBeNull(); // oldest still present at cap
		fetchCacheSet("overflow", { at: 0, status: 200, text: "x", headers: {}, url: "https://x/of" });
		expect(fetchCacheGet("k0", 0)).toBeNull(); // oldest evicted
		expect(fetchCacheGet("overflow", 0)).not.toBeNull(); // newest kept
	});

	it("re-setting an existing key does not evict under the cap", () => {
		clearFetchCache();
		for (let i = 0; i < FETCH_CACHE_MAX_ENTRIES; i++) fetchCacheSet(`k${i}`, { at: 0, status: 200, text: "x", headers: {}, url: `u${i}` });
		fetchCacheSet("k0", { at: 5, status: 200, text: "updated", headers: {}, url: "u0" }); // update in place
		expect(fetchCacheGet("k0", 5)?.text).toBe("updated");
		expect(fetchCacheGet("k63", 0)).not.toBeNull(); // nothing evicted
	});

	it("clearFetchCache empties everything", () => {
		fetchCacheSet("k", { at: 0, status: 200, text: "x", headers: {}, url: "u" });
		clearFetchCache();
		expect(fetchCacheGet("k", 0)).toBeNull();
	});

	it("fetchText serves a repeated same-URL GET from the isolate cache (one proxy hit)", async () => {
		clearFetchCache();
		setFetchDedup(true); // integration is gated off under vitest by default
		try {
			const { smartFetch } = await import("../proxy");
			vi.mocked(smartFetch as any).mockClear();
			const a = await fetchText({} as any, "https://dedupe-once.example/page");
			const b = await fetchText({} as any, "https://dedupe-once.example/page");
			expect(a.text).toBe(b.text);
			expect(smartFetch).toHaveBeenCalledTimes(1); // second call skipped the round-trip
		} finally {
			setFetchDedup(null);
			clearFetchCache();
		}
	});

	it("does not cache a POST or a body-bearing fetch", async () => {
		clearFetchCache();
		setFetchDedup(true);
		try {
			const { smartFetch } = await import("../proxy");
			vi.mocked(smartFetch as any).mockClear();
			await fetchText({} as any, "https://post-nocache.example", { method: "POST", body: "x" });
			await fetchText({} as any, "https://post-nocache.example", { method: "POST", body: "x" });
			expect(smartFetch).toHaveBeenCalledTimes(2); // never dedup non-GET
		} finally {
			setFetchDedup(null);
			clearFetchCache();
		}
	});

	it("keys the dedup on request headers so a differing header (e.g. geo) is not collapsed", async () => {
		clearFetchCache();
		setFetchDedup(true);
		try {
			const { smartFetch } = await import("../proxy");
			vi.mocked(smartFetch as any).mockClear();
			await fetchText({} as any, "https://geo.example/page", { headers: { "x-exit-geo": "us-ca" } });
			await fetchText({} as any, "https://geo.example/page", { headers: { "x-exit-geo": "de" } });
			expect(smartFetch).toHaveBeenCalledTimes(2); // different header ⇒ distinct fetch
			// Identical headers still hit the cache (one round-trip).
			await fetchText({} as any, "https://geo.example/page", { headers: { "x-exit-geo": "de" } });
			expect(smartFetch).toHaveBeenCalledTimes(2);
		} finally {
			setFetchDedup(null);
			clearFetchCache();
		}
	});
});

describe("pool (bounded concurrency)", () => {
	it("preserves input order and runs every item", async () => {
		const out = await pool([1, 2, 3, 4, 5], 2, async (n) => n * 10);
		expect(out).toEqual([10, 20, 30, 40, 50]);
	});
	it("never exceeds the concurrency cap", async () => {
		let active = 0, peak = 0;
		await pool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
			active++; peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return 0;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});
	it("handles an empty list and rejects if fn throws", async () => {
		expect(await pool([], 4, async () => 1)).toEqual([]);
		await expect(pool([1], 1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
	});
	it("stops claiming work past the deadline, leaving un-run slots undefined (dense)", async () => {
		let ran = 0;
		const out = await pool([1, 2, 3, 4, 5], 2, async (n) => { ran++; return n * 10; }, Date.now() - 1);
		expect(ran).toBe(0); // deadline already elapsed → nothing dispatched
		expect(out).toHaveLength(5);
		// Dense array (not sparse): every index is present and undefined, so a caller's
		// .map/.filter sees them (a hole would be silently skipped).
		expect(out.every((v) => v === undefined)).toBe(true);
		expect(Object.keys(out)).toHaveLength(5);
	});
	it("runs everything when the deadline is in the future", async () => {
		const out = await pool([1, 2, 3], 2, async (n) => n * 10, Date.now() + 60_000);
		expect(out).toEqual([10, 20, 30]);
	});
});

describe("byteBudget (aggregate fan-out memory gate)", () => {
	it("never lets concurrent reservations exceed the cap", async () => {
		// 10 items each reserving 25MB against a 96MB budget, run 8-wide. Without the
		// gate, 8 × 25MB = 200MB would be live at once; with it, live bytes stay ≤ 96MB.
		const CAP = 96 * 1024 * 1024;
		const ITEM = 25 * 1024 * 1024;
		const budget = byteBudget(CAP);
		let live = 0;
		let peak = 0;
		await pool(Array.from({ length: 10 }, (_, i) => i), 8, async () => {
			await budget.acquire(ITEM);
			try {
				live += ITEM;
				peak = Math.max(peak, live);
				await new Promise((r) => setTimeout(r, 5));
			} finally {
				live -= ITEM;
				budget.release(ITEM);
			}
			return 0;
		});
		expect(peak).toBeLessThanOrEqual(CAP);
		expect(peak).toBeGreaterThan(0);
	});

	it("clamps an over-cap reservation so a single large item runs alone, not deadlocks", async () => {
		const budget = byteBudget(10);
		// A request larger than the whole budget is clamped to the cap and still resolves.
		await budget.acquire(1000);
		budget.release(1000);
		// And the budget is fully restored (a follow-up small acquire resolves at once).
		let resolved = false;
		await budget.acquire(5).then(() => {
			resolved = true;
		});
		expect(resolved).toBe(true);
	});

	it("serves waiters FIFO — a queued large reservation isn't starved by later small ones", async () => {
		const budget = byteBudget(100);
		await budget.acquire(80); // 20 left
		const order: string[] = [];
		const big = budget.acquire(60).then(() => order.push("big")); // queues (needs 60 > 20)
		const small = budget.acquire(10).then(() => order.push("small")); // queues behind big (FIFO)
		budget.release(80); // 100 free → big (head) takes 60, then small takes 10
		await Promise.all([big, small]);
		expect(order).toEqual(["big", "small"]);
	});
});
