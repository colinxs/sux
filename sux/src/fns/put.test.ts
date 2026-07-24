import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A 1x1 PNG (magic bytes so the pdf fn embeds it as an image, not text).
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: unknown, url: string) => {
		if (url.includes("boom")) throw new Error("network down");
		if (url.includes("huge")) return new Response("x", { status: 200, headers: { "content-length": "99999999" } });
		if (url.includes("png")) return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
		if (url.includes("html")) return new Response("<html><body><h1>Hi</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
		return new Response(`body of ${url}`, { status: 200, headers: { "content-type": "text/plain" } });
	}),
}));

vi.mock("./dropbox", () => ({
	hasDropbox: vi.fn(() => true),
	dropboxPut: vi.fn(async (_env: unknown, path: string, bytes: Uint8Array) => ({ path, size: bytes.length, url: `https://dropbox.example${path}` })),
}));

import { put } from "./put";
import { dropboxPut, hasDropbox } from "./dropbox";

// Minimal R2 + KV mocks (mirrors batch_fetch.test.ts / store.test.ts).
function mockKV() {
	const m = new Map<string, string>();
	return { _m: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
function mockR2() {
	const m = new Map<string, { bytes: Uint8Array; ct?: string; meta?: Record<string, string> }>();
	return {
		_m: m,
		put: async (key: string, value: any, opts?: any) => {
			const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
			m.set(key, { bytes, ct: opts?.httpMetadata?.contentType, meta: opts?.customMetadata });
		},
		get: async (key: string) => {
			const o = m.get(key);
			if (!o) return null;
			return { size: o.bytes.length, httpMetadata: { contentType: o.ct }, customMetadata: o.meta, arrayBuffer: async () => o.bytes.buffer };
		},
		head: async (key: string) => {
			const o = m.get(key);
			return o ? { size: o.bytes.length, httpMetadata: { contentType: o.ct }, customMetadata: o.meta } : null;
		},
	};
}
const mkEnv = () => ({ R2: mockR2(), OAUTH_KV: mockKV() }) as any;
const UUID = /\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Resolve a /s/<uuid> ref back to its stored bytes via the mock KV→R2.
function storedBytes(env: any, refUrl: string): Uint8Array {
	const uuid = refUrl.split("/s/")[1];
	const kvRef = JSON.parse(env.OAUTH_KV._m.get(`store:${uuid}`));
	return env.R2._m.get(kvRef.key).bytes;
}

describe("put", () => {
	it("rejects a non-array / empty / oversized urls value", async () => {
		expect((await put.run(mkEnv(), { urls: "http://a.com" })).isError).toBe(true);
		expect((await put.run(mkEnv(), { urls: [] })).content[0].text).toMatch(/must not be empty/);
		const many = Array.from({ length: 101 }, (_, i) => `https://a.com/${i}`);
		const over = await put.run(mkEnv(), { urls: many });
		expect(over.isError).toBe(true);
		expect(over.content[0].text).toMatch(/Too many urls: 101 \(max 100/);
	});

	it("fails clearly without the R2 binding", async () => {
		const r = await put.run({ OAUTH_KV: mockKV() } as any, { urls: ["https://a.com"] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/needs the R2 store/);
	});

	it("a fresh put stages a preview by default — nothing fetched or written until commit_token or force (#486)", async () => {
		const env = mkEnv();
		const staged = JSON.parse((await put.run(env, { urls: ["https://a.com", "https://b.com"] })).content[0].text);
		expect(staged.staged).toBe(true);
		expect(staged.kind).toBe("put_batch");
		expect(typeof staged.commit_token).toBe("string");
		expect(staged.preview.url_count).toBe(2);
		expect(env.R2._m.size).toBe(0); // nothing fetched or written yet
		const committed = JSON.parse((await put.run(env, { urls: ["https://a.com", "https://b.com"], commit_token: staged.commit_token })).content[0].text);
		expect(committed).toHaveLength(2);
		expect(committed[0].ref).toMatch(UUID);
		expect(env.R2._m.size).toBe(2);
	});

	it("a changed payload can't spend a stale commit_token", async () => {
		const env = mkEnv();
		const staged = JSON.parse((await put.run(env, { urls: ["https://a.com"] })).content[0].text);
		const r = await put.run(env, { urls: ["https://b.com"], commit_token: staged.commit_token });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/payload changed/);
		expect(env.R2._m.size).toBe(0);
	});

	it("downloads each URL, stores raw bytes to CAS, and returns a /s/<uuid> ref", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://a.com", "https://b.com"], force: true });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out).toHaveLength(2);
		for (const item of out) {
			expect(item.status).toBe(200);
			expect(item.ref).toMatch(UUID);
			expect(item.applied).toBeUndefined();
		}
		expect(env.R2._m.size).toBe(2);
		expect(new TextDecoder().decode(storedBytes(env, out[0].ref))).toBe("body of https://a.com");
	});

	it("isolates per-url failures and non-http URLs — survivors still store", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["ftp://nope", "https://boom.com", "https://ok.com"], force: true });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].error).toMatch(/not an absolute http/);
		expect(out[1].error).toMatch(/network down/);
		expect(out[2].status).toBe(200);
		expect(out[2].ref).toMatch(UUID);
		expect(env.R2._m.size).toBe(1); // only the survivor stored
	});

	it("reports an oversize download without storing it", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://ex.com/huge", "https://ex.com/ok"], force: true });
		const out = JSON.parse(r.content[0].text);
		const huge = out.find((x: any) => x.url.includes("huge"));
		expect(huge.oversize).toBe(true);
		expect(huge.ref).toBeUndefined();
		expect(out.find((x: any) => x.url.includes("ok")).ref).toMatch(UUID);
		expect(env.R2._m.size).toBe(1);
	});

	it("gzip:true stores the gzipped bytes (round-trips) and tags applied", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://a.com"], gzip: true, force: true });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].applied).toEqual(["gzip"]);
		expect(out[0].content_type).toBe("application/gzip");
		expect(out[0].src_bytes).toBe("body of https://a.com".length);
		const stored = storedBytes(env, out[0].ref);
		expect(new TextDecoder().decode(zlib.gunzipSync(stored))).toBe("body of https://a.com");
		expect(out[0].bytes).toBe(stored.length);
	});

	it("pdf:true converts a downloaded image to a PDF before storing", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://ex.com/png"], pdf: true, force: true });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].applied).toEqual(["pdf"]);
		expect(out[0].content_type).toBe("application/pdf");
		// Stored bytes are a real PDF (%PDF- magic).
		expect(new TextDecoder().decode(storedBytes(env, out[0].ref).slice(0, 5))).toBe("%PDF-");
	});

	it("pdf + gzip chains both transforms in order", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://ex.com/html"], pdf: true, gzip: true, force: true });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].applied).toEqual(["pdf", "gzip"]);
		expect(out[0].content_type).toBe("application/gzip");
		// gunzip → a PDF.
		const pdfBytes = zlib.gunzipSync(storedBytes(env, out[0].ref));
		expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");
	});

	it("defaults to a permanent handle when no ttl_seconds is given (#1381)", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://a.com"], force: true });
		const out = JSON.parse(r.content[0].text);
		const uuid = out[0].ref.split("/s/")[1];
		const handle = JSON.parse(env.OAUTH_KV._m.get(`store:${uuid}`));
		// R2+CAS makes keeping everything nearly free — no expiry unless ttl_seconds is opted into.
		expect(handle.expiry).toBeUndefined();
	});

	it("passes ttl_seconds through to a self-expiring handle and rejects a bad ttl", async () => {
		const env = mkEnv();
		const r = await put.run(env, { urls: ["https://a.com"], ttl_seconds: 3600, force: true });
		const out = JSON.parse(r.content[0].text);
		const uuid = out[0].ref.split("/s/")[1];
		const handle = JSON.parse(env.OAUTH_KV._m.get(`store:${uuid}`));
		expect(typeof handle.expiry).toBe("number");
		const bad = await put.run(env, { urls: ["https://a.com"], ttl_seconds: 0 });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/positive integer/);
	});

	describe("dropbox projection (#1381)", () => {
		beforeEach(() => {
			vi.mocked(hasDropbox).mockReset().mockReturnValue(true);
			vi.mocked(dropboxPut).mockClear();
		});

		it("rejects an empty dropbox path and one when Dropbox isn't configured", async () => {
			const env = mkEnv();
			const empty = await put.run(env, { urls: ["https://a.com"], dropbox: "   " });
			expect(empty.isError).toBe(true);
			expect(empty.content[0].text).toMatch(/non-empty folder path/);

			vi.mocked(hasDropbox).mockReturnValueOnce(false);
			const notConfigured = await put.run(env, { urls: ["https://a.com"], dropbox: "/Downloads" });
			expect(notConfigured.isError).toBe(true);
			expect(notConfigured.content[0].text).toMatch(/requires Dropbox to be configured/);
		});

		it("fires a fire-and-forget R2→Dropbox projection and returns dropbox_path immediately, R2 ref unaffected", async () => {
			const env = mkEnv();
			const r = await put.run(env, { urls: ["https://ex.com/report.pdf"], dropbox: "/Downloads", force: true });
			const out = JSON.parse(r.content[0].text);
			expect(out[0].ref).toMatch(UUID);
			expect(out[0].dropbox_path).toBe("/Downloads/report.pdf");
			expect(dropboxPut).toHaveBeenCalledWith(env, "/Downloads/report.pdf", expect.any(Uint8Array), { overwrite: false });
		});

		it("de-duplicates a basename collision within the same batch", async () => {
			const env = mkEnv();
			const r = await put.run(env, { urls: ["https://a.com/report.pdf", "https://b.com/report.pdf"], dropbox: "/Downloads", force: true });
			const out = JSON.parse(r.content[0].text);
			const paths = out.map((o: any) => o.dropbox_path).sort();
			expect(paths).toEqual(["/Downloads/report-2.pdf", "/Downloads/report.pdf"]);
		});

		it("omits dropbox_path when the dropbox param isn't set — byte-identical to today", async () => {
			const env = mkEnv();
			const r = await put.run(env, { urls: ["https://a.com"], force: true });
			const out = JSON.parse(r.content[0].text);
			expect(out[0].dropbox_path).toBeUndefined();
			expect(dropboxPut).not.toHaveBeenCalled();
		});
	});

	describe("r2_path named projection (#1382)", () => {
		it("writes each stored file under files/<r2_path>/<name> and returns r2_path, ref unaffected", async () => {
			const env = mkEnv();
			const r = await put.run(env, { urls: ["https://ex.com/report.pdf"], r2_path: "library", force: true });
			const out = JSON.parse(r.content[0].text);
			expect(out[0].ref).toMatch(UUID);
			expect(out[0].r2_path).toBe("files/library/report.pdf");
			const proj = env.R2._m.get("files/library/report.pdf");
			expect(proj).toBeTruthy();
			expect(new TextDecoder().decode(proj.bytes)).toBe("body of https://ex.com/report.pdf");
			expect(proj.ct).toBe("text/plain");
		});

		it("suffixes a collision (-2) against an object already at that files/ path", async () => {
			const env = mkEnv();
			env.R2._m.set("files/library/report.pdf", { bytes: new TextEncoder().encode("existing"), ct: "text/plain" });
			const r = await put.run(env, { urls: ["https://ex.com/report.pdf"], r2_path: "library", force: true });
			const out = JSON.parse(r.content[0].text);
			expect(out[0].r2_path).toBe("files/library/report-2.pdf");
			expect(new TextDecoder().decode(env.R2._m.get("files/library/report.pdf")!.bytes)).toBe("existing");
		});

		it("de-duplicates a basename collision within the same batch under the same r2_path folder", async () => {
			const env = mkEnv();
			const r = await put.run(env, { urls: ["https://a.com/report.pdf", "https://b.com/report.pdf"], r2_path: "library", force: true });
			const out = JSON.parse(r.content[0].text);
			const paths = out.map((o: any) => o.r2_path).sort();
			expect(paths).toEqual(["files/library/report-2.pdf", "files/library/report.pdf"]);
		});

		it("omits r2_path when the param isn't set — byte-identical to today", async () => {
			const env = mkEnv();
			const r = await put.run(env, { urls: ["https://a.com"], force: true });
			const out = JSON.parse(r.content[0].text);
			expect(out[0].r2_path).toBeUndefined();
			expect([...env.R2._m.keys()].some((k) => k.startsWith("files/"))).toBe(false);
		});

		it("rejects an empty r2_path", async () => {
			const empty = await put.run(mkEnv(), { urls: ["https://a.com"], r2_path: "   " });
			expect(empty.isError).toBe(true);
			expect(empty.content[0].text).toMatch(/non-empty folder path/);
		});
	});
});
