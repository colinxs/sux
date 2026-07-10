import { afterEach, describe, expect, it, vi } from "vitest";
import { dropbox } from "./dropbox";

const ENV = { DROPBOX_TOKEN: "dbx" } as any;
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};

describe("dropbox (app-folder blob store)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reports when neither a token nor the refresh creds are configured", async () => {
		const r = await dropbox.run({} as any, { op: "list" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/DROPBOX_REFRESH_TOKEN|DROPBOX_TOKEN/);
	});

	it("refresh flow: mints a short-lived token, caches it in KV, reuses on the next call", async () => {
		const kv = fakeKV();
		const env = { DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak", DROPBOX_APP_SECRET: "as", OAUTH_KV: kv } as any;
		let mints = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url === "https://api.dropbox.com/oauth2/token") {
				mints++;
				expect(init.headers.Authorization).toBe(`Basic ${btoa("ak:as")}`);
				expect(init.body).toContain("grant_type=refresh_token");
				expect(init.body).toContain("refresh_token=rt");
				return new Response(JSON.stringify({ access_token: "sl.minted", expires_in: 14400 }), { status: 200 });
			}
			expect(init.headers.Authorization).toBe("Bearer sl.minted"); // the minted token is used
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await dropbox.run(env, { op: "list" });
		expect(mints).toBe(1);
		expect(kv.store.get("sux:dropbox:token")).toBe("sl.minted");
		await dropbox.run(env, { op: "list" }); // second op: cache hit, no re-mint
		expect(mints).toBe(1);
	});

	it("refresh flow (public client / PKCE — no app secret): client_id in body, NO Basic auth", async () => {
		const kv = fakeKV();
		const env = { DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak", OAUTH_KV: kv } as any; // no DROPBOX_APP_SECRET
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === "https://api.dropbox.com/oauth2/token") {
				expect(init.headers.Authorization).toBeUndefined(); // a public client sends no Basic auth
				expect(init.body).toContain("client_id=ak"); // client_id rides the body instead
				expect(init.body).toContain("grant_type=refresh_token");
				return new Response(JSON.stringify({ access_token: "sl.pub", expires_in: 14400 }), { status: 200 });
			}
			expect(init.headers.Authorization).toBe("Bearer sl.pub");
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await dropbox.run(env, { op: "list" });
		expect(kv.store.get("sux:dropbox:token")).toBe("sl.pub");
	});

	it("refresh flow surfaces an auth failure clearly", async () => {
		const env = { DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak", OAUTH_KV: fakeKV() } as any;
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }), { status: 400 })));
		const r = await dropbox.run(env, { op: "list" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/refresh token revoked|invalid_grant/);
	});

	it("on a 401 (revoked access token) it drops the cache and re-mints once", async () => {
		// A stale token sits in KV; Dropbox 401s it; the fn must re-mint and succeed.
		const kv = fakeKV({ "sux:dropbox:token": "sl.stale" });
		const env = { DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak", OAUTH_KV: kv } as any;
		let mints = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url === "https://api.dropbox.com/oauth2/token") {
				mints++;
				return new Response(JSON.stringify({ access_token: "sl.fresh", expires_in: 14400 }), { status: 200 });
			}
			const bearer = init.headers.Authorization;
			if (bearer === "Bearer sl.stale") return new Response(JSON.stringify({ error_summary: "invalid_access_token/" }), { status: 401 });
			expect(bearer).toBe("Bearer sl.fresh"); // retried with the freshly minted token
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		const r = await dropbox.run(env, { op: "list" });
		expect(r.isError).toBeFalsy();
		expect(mints).toBe(1); // re-minted exactly once
		expect(kv.store.get("sux:dropbox:token")).toBe("sl.fresh");
	});

	it("put uploads bytes and returns a fresh shared link", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/upload")) {
				expect(init.headers.Authorization).toBe("Bearer dbx");
				expect(JSON.parse(init.headers["Dropbox-API-Arg"])).toMatchObject({ path: "/notes/a.pdf", mode: "overwrite" });
				expect(init.body).toBeInstanceOf(Uint8Array);
				return new Response(JSON.stringify({ path_display: "/notes/a.pdf", size: 3 }), { status: 200 });
			}
			expect(url).toContain("/sharing/create_shared_link_with_settings");
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/a.pdf" }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "put", path: "notes/a.pdf", base64: Buffer.from("abc").toString("base64") });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, path: "/notes/a.pdf", size: 3, url: "https://www.dropbox.com/s/x/a.pdf" });
	});

	it("put reuses the existing shared link on 409", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/a.txt", size: 2 }), { status: 200 });
			if (url.endsWith("/sharing/create_shared_link_with_settings")) {
				return new Response(JSON.stringify({ error_summary: "shared_link_already_exists/metadata/" }), { status: 409 });
			}
			expect(url).toContain("/sharing/list_shared_links");
			return new Response(JSON.stringify({ links: [{ url: "https://www.dropbox.com/s/old/a.txt" }] }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "put", path: "a.txt", data: "hi" });
		expect(JSON.parse(r.content[0].text).url).toBe("https://www.dropbox.com/s/old/a.txt");
	});

	it("get checks metadata first, then returns text for textual extensions", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 7 }), { status: 200 });
			expect(url).toContain("/files/download");
			expect(JSON.parse(init.headers["Dropbox-API-Arg"]).path).toBe("/notes/x.md");
			return new Response("# hello", { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "get", path: "notes/x.md" });
		expect(r.content[0].text).toBe("# hello");
	});

	it("get returns base64 for binary extensions", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 3 }), { status: 200 });
			return new Response(Buffer.from([1, 2, 3]), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "get", path: "img.png" });
		const out = JSON.parse(r.content[0].text);
		expect(Buffer.from(out.base64, "base64")).toEqual(Buffer.from([1, 2, 3]));
	});

	it("get on an oversize file returns metadata + link without downloading", async () => {
		const fetchMock = vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 500_000_000 }), { status: 200 });
			if (url.includes("/sharing/")) return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/big.mov" }), { status: 200 });
			throw new Error("download must not be attempted");
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await dropbox.run(ENV, { op: "get", path: "big.mov" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ too_large_to_inline: true, size: 500_000_000, url: "https://www.dropbox.com/s/x/big.mov" });
	});

	it("get on a folder reports the real error, not 'not found'", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ".tag": "folder", size: undefined }), { status: 200 })));
		const r = await dropbox.run(ENV, { op: "get", path: "attachments" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/is a folder/);
	});

	it("unicode paths ride a header-safe Dropbox-API-Arg", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/upload")) {
				const arg = init.headers["Dropbox-API-Arg"];
				expect(/^[\x00-\x7e]*$/.test(arg)).toBe(true); // pure ASCII on the wire
				expect(JSON.parse(arg).path).toBe("/notes/메모.md"); // decodes to the real path
				return new Response(JSON.stringify({ path_display: "/notes/메모.md", size: 2 }), { status: 200 });
			}
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/m.md" }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "put", path: "notes/메모.md", data: "hi" });
		expect(JSON.parse(r.content[0].text).ok).toBe(true);
	});

	it("lists a folder", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/list_folder");
			expect(JSON.parse(init.body).path).toBe(""); // app-folder root
			return new Response(JSON.stringify({ entries: [{ ".tag": "file", name: "a.pdf", path_display: "/a.pdf", size: 9 }], has_more: false }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "list" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ dir: "/", count: 1, entries: [{ kind: "file", name: "a.pdf", size: 9 }] });
	});

	it("list paginates through a cursor instead of dead-ending on has_more", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const body = JSON.parse(init.body);
			if (String(u).endsWith("/files/list_folder")) {
				return new Response(JSON.stringify({ entries: [{ ".tag": "file", name: "a", path_display: "/a", size: 1 }], has_more: true, cursor: "CUR" }), { status: 200 });
			}
			expect(String(u)).toContain("/files/list_folder/continue");
			expect(body.cursor).toBe("CUR");
			return new Response(JSON.stringify({ entries: [{ ".tag": "file", name: "b", path_display: "/b", size: 1 }], has_more: false }), { status: 200 });
		}));
		const page1 = JSON.parse((await dropbox.run(ENV, { op: "list" })).content[0].text);
		expect(page1).toMatchObject({ has_more: true, cursor: "CUR" });
		const page2 = JSON.parse((await dropbox.run(ENV, { op: "list", cursor: page1.cursor })).content[0].text);
		expect(page2).toMatchObject({ has_more: false, count: 1 });
	});

	it("put warns when the upload lands but no shared link could be minted", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/a.txt", size: 2 }), { status: 200 });
			return new Response(JSON.stringify({ error_summary: "missing_scope/sharing.write" }), { status: 403 });
		}));
		const out = JSON.parse((await dropbox.run(ENV, { op: "put", path: "a.txt", data: "hi" })).content[0].text);
		expect(out.ok).toBe(true);
		expect(out.url).toBeUndefined();
		expect(out.warning).toMatch(/no shared link/);
	});

	it("deletes a path", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/delete_v2");
			expect(JSON.parse(init.body).path).toBe("/a.pdf");
			return new Response(JSON.stringify({ metadata: { path_display: "/a.pdf" } }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "delete", path: "a.pdf" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, deleted: "/a.pdf" });
	});

	it("delete surfaces the real Dropbox error text (not a blanket 'Not found')", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "path_lookup/not_found/" }), { status: 409 })));
		const r = await dropbox.run(ENV, { op: "delete", path: "missing.pdf" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("path_lookup/not_found");
		expect(r.content[0].text).toContain("missing.pdf");
	});

	it("get refuses to download when metadata carries no size (unbounded-body guard)", async () => {
		let downloaded = false;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file" }), { status: 200 });
			downloaded = true;
			return new Response("should not happen", { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "get", path: "weird.bin" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no size|unbounded/);
		expect(downloaded).toBe(false);
	});
});
