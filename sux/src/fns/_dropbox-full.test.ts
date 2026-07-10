import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteFull, hasDropboxFull, listFull, moveFull, normFull, operateFull, readFull, searchFull, writeFull } from "./_dropbox-full";

// Read-only full-Dropbox (Mode B) client. These tests hit the real fetch paths via a
// stub, asserting: the credential is isolated to DROPBOX_FULL_* (its own KV key), reads
// never exceed the inline cap (oversize → a TEMPORARY, non-public link), and search/list
// return REFERENCES only. Mirrors dropbox.test.ts's mint/self-heal patterns.

const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const FULL_KEY = "sux:dropbox:full:token";
const tokenEnv = () => ({ DROPBOX_FULL_TOKEN: "ft" }) as any;

afterEach(() => vi.unstubAllGlobals());

describe("hasDropboxFull / normFull", () => {
	it("is configured only when the full credential (not Mode A's) is present", () => {
		expect(hasDropboxFull({} as any)).toBe(false);
		expect(hasDropboxFull({ DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak" } as any)).toBe(false); // Mode A is NOT Mode B
		expect(hasDropboxFull({ DROPBOX_FULL_TOKEN: "ft" } as any)).toBe(true);
		expect(hasDropboxFull({ DROPBOX_FULL_REFRESH_TOKEN: "rt", DROPBOX_FULL_APP_KEY: "ak" } as any)).toBe(true);
		expect(hasDropboxFull({ DROPBOX_FULL_REFRESH_TOKEN: "rt" } as any)).toBe(false); // refresh needs the app key
	});

	it("normalizes to absolute paths with '' as the account root", () => {
		expect(normFull("")).toBe("");
		expect(normFull("/")).toBe("");
		expect(normFull("Documents")).toBe("/Documents");
		expect(normFull("/Documents/")).toBe("/Documents");
		expect(normFull("/a/b/")).toBe("/a/b");
	});
});

describe("auth — isolated to the full credential", () => {
	it("PKCE public client: client_id in body, no Basic auth, caches under the full-only key", async () => {
		const kv = fakeKV();
		const env = { DROPBOX_FULL_REFRESH_TOKEN: "frt", DROPBOX_FULL_APP_KEY: "fak", OAUTH_KV: kv } as any;
		let mints = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === TOKEN_URL) {
				mints++;
				expect(init.headers.Authorization).toBeUndefined();
				expect(init.body).toContain("client_id=fak");
				expect(init.body).toContain("refresh_token=frt");
				return new Response(JSON.stringify({ access_token: "sl.full", expires_in: 14400 }), { status: 200 });
			}
			expect(init.headers.Authorization).toBe("Bearer sl.full");
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(env, "");
		expect(mints).toBe(1);
		expect(kv.store.get(FULL_KEY)).toBe("sl.full");
		expect(kv.store.has("sux:dropbox:token")).toBe(false); // never writes Mode A's key
		await listFull(env, ""); // cache hit
		expect(mints).toBe(1);
	});

	it("confidential client: sends Basic auth when a full secret is set", async () => {
		const env = { DROPBOX_FULL_REFRESH_TOKEN: "frt", DROPBOX_FULL_APP_KEY: "fak", DROPBOX_FULL_APP_SECRET: "fas", OAUTH_KV: fakeKV() } as any;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === TOKEN_URL) {
				expect(init.headers.Authorization).toBe(`Basic ${btoa("fak:fas")}`);
				return new Response(JSON.stringify({ access_token: "sl.c", expires_in: 14400 }), { status: 200 });
			}
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(env, "");
	});

	it("on a 401 it drops the FULL cache and re-mints once", async () => {
		const kv = fakeKV({ [FULL_KEY]: "sl.stale" });
		const env = { DROPBOX_FULL_REFRESH_TOKEN: "frt", DROPBOX_FULL_APP_KEY: "fak", OAUTH_KV: kv } as any;
		let mints = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === TOKEN_URL) {
				mints++;
				return new Response(JSON.stringify({ access_token: "sl.fresh", expires_in: 14400 }), { status: 200 });
			}
			if (init.headers.Authorization === "Bearer sl.stale") return new Response(JSON.stringify({ error_summary: "invalid_access_token/" }), { status: 401 });
			expect(init.headers.Authorization).toBe("Bearer sl.fresh");
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(env, "");
		expect(mints).toBe(1);
		expect(kv.store.get(FULL_KEY)).toBe("sl.fresh");
	});
});

describe("searchFull — whole-account, references only", () => {
	it("posts search_v2 with path_prefix + ext filters and returns file references", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/search_v2");
			const body = JSON.parse(init.body);
			expect(body.query).toBe("invoice");
			expect(body.options.path).toBe("/Documents");
			expect(body.options.file_extensions).toEqual(["pdf", "docx"]); // leading dots stripped
			return new Response(JSON.stringify({ matches: [{ metadata: { metadata: { ".tag": "file", name: "invoice.pdf", path_display: "/Documents/invoice.pdf", size: 12, rev: "0a" } } }], has_more: false }), { status: 200 });
		}));
		const r = await searchFull(env, { query: "invoice", path_prefix: "/Documents", ext: [".pdf", "docx"] });
		expect(r.matches).toEqual([{ kind: "file", name: "invoice.pdf", path: "/Documents/invoice.pdf", size: 12, rev: "0a", modified: undefined }]);
		expect(r.has_more).toBe(false);
	});

	it("omits the path when no prefix is given (whole account) and paginates via continue_v2", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/search_v2")) {
				expect(JSON.parse(init.body).options.path).toBeUndefined(); // whole account
				return new Response(JSON.stringify({ matches: [], has_more: true, cursor: "CUR" }), { status: 200 });
			}
			expect(url).toContain("/files/search/continue_v2");
			expect(JSON.parse(init.body).cursor).toBe("CUR");
			return new Response(JSON.stringify({ matches: [], has_more: false }), { status: 200 });
		}));
		const page1 = await searchFull(env, { query: "x" });
		expect(page1).toMatchObject({ has_more: true, cursor: "CUR" });
		const page2 = await searchFull(env, { query: "x", cursor: page1.cursor });
		expect(page2.has_more).toBe(false);
	});

	it("surfaces the Dropbox error summary", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "invalid_cursor/" }), { status: 409 })));
		await expect(searchFull(tokenEnv(), { query: "x", cursor: "bad" })).rejects.toThrow(/invalid_cursor/);
	});
});

describe("listFull — absolute folders", () => {
	it("lists an absolute folder and paginates through the cursor", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/list_folder")) {
				expect(JSON.parse(init.body).path).toBe("/Photos");
				return new Response(JSON.stringify({ entries: [{ ".tag": "folder", name: "2024", path_display: "/Photos/2024" }], has_more: true, cursor: "C1" }), { status: 200 });
			}
			expect(url).toContain("/files/list_folder/continue");
			expect(JSON.parse(init.body).cursor).toBe("C1");
			return new Response(JSON.stringify({ entries: [{ ".tag": "file", name: "a.jpg", path_display: "/Photos/a.jpg", size: 5 }], has_more: false }), { status: 200 });
		}));
		const p1 = await listFull(env, "Photos");
		expect(p1).toMatchObject({ has_more: true, cursor: "C1", entries: [{ kind: "folder", name: "2024" }] });
		const p2 = await listFull(env, "Photos", p1.cursor);
		expect(p2).toMatchObject({ has_more: false, entries: [{ kind: "file", name: "a.jpg", size: 5 }] });
	});

	it("lists the account root for the empty path", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(JSON.parse(init.body).path).toBe(""); // account root
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(tokenEnv(), "");
	});
});

describe("readFull — bytes with a hard inline cap", () => {
	it("returns text for textual extensions after checking metadata", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 7, path_display: "/n/x.md", rev: "9" }), { status: 200 });
			expect(url).toContain("/files/download");
			expect(JSON.parse(init.headers["Dropbox-API-Arg"]).path).toBe("/n/x.md");
			return new Response("# hello", { status: 200 });
		}));
		const r = await readFull(env, "/n/x.md");
		expect(r).toMatchObject({ path: "/n/x.md", rev: "9", text: "# hello" });
	});

	it("returns base64 for binary extensions", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 3, path_display: "/img.png" }), { status: 200 });
			return new Response(Buffer.from([1, 2, 3]), { status: 200 });
		}));
		const r = await readFull(tokenEnv(), "/img.png");
		expect(Buffer.from(String(r.base64), "base64")).toEqual(Buffer.from([1, 2, 3]));
	});

	it("oversize → a TEMPORARY (expiring, NON-public) link and never downloads", async () => {
		let downloaded = false;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 500_000_000, path_display: "/big.mov", rev: "z" }), { status: 200 });
			if (url.endsWith("/files/get_temporary_link")) return new Response(JSON.stringify({ link: "https://dl.dropboxusercontent.com/temp/big.mov" }), { status: 200 });
			if (url.includes("/sharing/")) throw new Error("must not mint a permanent public share for a full-scope path");
			downloaded = url.includes("/files/download");
			throw new Error("download must not be attempted for oversize");
		}));
		const r = await readFull(tokenEnv(), "/big.mov");
		expect(r).toMatchObject({ too_large_to_inline: true, size: 500_000_000, temporary_link: "https://dl.dropboxusercontent.com/temp/big.mov" });
		expect(String(r.temporary_link)).not.toContain("dropbox.com/s/"); // not a permanent /s/ share
		expect(downloaded).toBe(false);
	});

	it("oversize with a FAILED temporary-link throws — never a silent success with a missing link", async () => {
		// Regression (adversarial review): a 409/429/401 from get_temporary_link must surface as an
		// error, not a { too_large_to_inline: true, temporary_link: undefined } success.
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 500_000_000, path_display: "/big.mov" }), { status: 200 });
			if (url.endsWith("/files/get_temporary_link")) return new Response(JSON.stringify({ error_summary: "unsupported_file/" }), { status: 409 });
			throw new Error("download must not be attempted for oversize");
		}));
		await expect(readFull(tokenEnv(), "/big.mov")).rejects.toThrow(/temporary-link error|unsupported_file/);
	});

	it("refuses a folder and an unbounded (no-size) body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ".tag": "folder" }), { status: 200 })));
		await expect(readFull(tokenEnv(), "/a")).rejects.toThrow(/is a folder/);
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ".tag": "file" }), { status: 200 })));
		await expect(readFull(tokenEnv(), "/weird.bin")).rejects.toThrow(/no size|unbounded/);
	});

	it("requires a real path (root is not a file)", async () => {
		await expect(readFull(tokenEnv(), "")).rejects.toThrow(/requires a file path/);
	});
});

describe("Mode B write firewall — dry-run default, fence, backup, rev-conditioning", () => {
	it("writeFull dry-run returns a plan and never uploads", async () => {
		const fetchMock = vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
			throw new Error("no mutation allowed in dry-run");
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await writeFull(tokenEnv(), { path: "/Docs/new.txt", bytes: new TextEncoder().encode("hi"), dryRun: true });
		expect(r).toMatchObject({ action: "write", exists: false, will_overwrite: false, bytes: 2 });
		expect(String(r.note)).toMatch(/DRY RUN/);
		expect(fetchMock.mock.calls.every(([u]) => !String(u).endsWith("/files/upload"))).toBe(true);
	});

	it("writeFull apply (new file) uploads mode:add with no backup", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u); seen.push(url);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
			if (url.endsWith("/files/upload")) {
				expect(JSON.parse(init.headers["Dropbox-API-Arg"]).mode).toBe("add");
				return new Response(JSON.stringify({ path_display: "/Docs/new.txt", size: 2, rev: "01a" }), { status: 200 });
			}
			throw new Error(`unexpected ${url}`);
		}));
		const r = await writeFull(tokenEnv(), { path: "/Docs/new.txt", bytes: new TextEncoder().encode("hi"), dryRun: false });
		expect(r).toMatchObject({ ok: true, path: "/Docs/new.txt", rev: "01a" });
		expect(seen.some((u) => u.endsWith("/files/copy_v2"))).toBe(false);
	});

	it("writeFull refuses to overwrite an existing file without overwrite:true or a rev", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", rev: "99", size: 5 }), { status: 200 });
			throw new Error("no write");
		}));
		await expect(writeFull(tokenEnv(), { path: "/x.txt", bytes: new Uint8Array([1]), dryRun: false })).rejects.toThrow(/already exists/);
	});

	it("writeFull overwrite backs up to /.sux-trash then uploads mode:overwrite", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u); seen.push(url);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", rev: "99", size: 5 }), { status: 200 });
			if (url.endsWith("/files/copy_v2")) {
				expect(JSON.parse(init.body).from_path).toBe("/x.txt");
				expect(JSON.parse(init.body).to_path).toMatch(/^\/\.sux-trash\//);
				return new Response(JSON.stringify({ metadata: { path_display: "/.sux-trash/T/x.txt" } }), { status: 200 });
			}
			if (url.endsWith("/files/upload")) {
				expect(JSON.parse(init.headers["Dropbox-API-Arg"]).mode).toBe("overwrite");
				return new Response(JSON.stringify({ path_display: "/x.txt", size: 1, rev: "9a" }), { status: 200 });
			}
			throw new Error(url);
		}));
		const r = await writeFull(tokenEnv(), { path: "/x.txt", bytes: new Uint8Array([1]), overwrite: true, dryRun: false });
		expect(r).toMatchObject({ ok: true, backup: "/.sux-trash/T/x.txt", rev: "9a" });
		expect(seen.filter((u) => u.endsWith("/files/copy_v2")).length).toBe(1);
	});

	it("writeFull is rev-conditioned: stale rev rejects, matching rev uploads mode:update", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", rev: "99", size: 5 }), { status: 200 });
			if (url.endsWith("/files/upload")) {
				expect(JSON.parse(init.headers["Dropbox-API-Arg"]).mode).toMatchObject({ ".tag": "update", update: "99" });
				return new Response(JSON.stringify({ path_display: "/x.txt", rev: "aa", size: 1 }), { status: 200 });
			}
			throw new Error(url);
		}));
		await expect(writeFull(tokenEnv(), { path: "/x.txt", bytes: new Uint8Array([1]), rev: "88", dryRun: false })).rejects.toThrow(/rev mismatch/);
		const r = await writeFull(tokenEnv(), { path: "/x.txt", bytes: new Uint8Array([1]), rev: "99", backup: false, dryRun: false });
		expect(r).toMatchObject({ ok: true, rev: "aa" });
	});

	it("writeFull refuses to overwrite a folder with a file", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "folder" }), { status: 200 });
			throw new Error("no write");
		}));
		await expect(writeFull(tokenEnv(), { path: "/Docs", bytes: new Uint8Array([1]), overwrite: true, dryRun: false })).rejects.toThrow(/is a folder/);
	});

	it("the fence refuses the account root and any protected prefix (case-insensitive), before any network call", async () => {
		const env = { DROPBOX_FULL_TOKEN: "ft", DROPBOX_FULL_PROTECT_PREFIXES: "/Obsidian, /Private" } as any;
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(writeFull(env, { path: "", bytes: new Uint8Array(), dryRun: true })).rejects.toThrow(/account root/);
		await expect(writeFull(env, { path: "/Obsidian/vault/n.md", bytes: new Uint8Array(), dryRun: true })).rejects.toThrow(/protected prefix/);
		await expect(deleteFull(env, { path: "/private/secret.txt", dryRun: true })).rejects.toThrow(/protected prefix/);
		await expect(moveFull(env, { from: "/ok.txt", to: "/Obsidian/x", dryRun: true })).rejects.toThrow(/protected prefix/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("deleteFull dry-run previews; apply calls delete_v2; a missing path throws", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file" }), { status: 200 });
			throw new Error("no delete in dry-run");
		}));
		expect(await deleteFull(tokenEnv(), { path: "/x.txt", dryRun: true })).toMatchObject({ action: "delete", path: "/x.txt" });
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file" }), { status: 200 });
			if (url.endsWith("/files/delete_v2")) return new Response(JSON.stringify({ metadata: { path_display: "/x.txt" } }), { status: 200 });
			throw new Error(url);
		}));
		expect(await deleteFull(tokenEnv(), { path: "/x.txt", dryRun: false })).toMatchObject({ ok: true, deleted: "/x.txt" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "path_lookup/not_found/" }), { status: 409 })));
		await expect(deleteFull(tokenEnv(), { path: "/gone.txt", dryRun: false })).rejects.toThrow(/nothing deleted|not_found/);
	});

	it("moveFull dry-run previews; apply calls move_v2; a no-op is refused", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u).endsWith("/files/move_v2")) {
				expect(JSON.parse(init.body)).toMatchObject({ from_path: "/a", to_path: "/b", autorename: false });
				return new Response(JSON.stringify({ metadata: { path_display: "/b" } }), { status: 200 });
			}
			throw new Error(String(u));
		}));
		expect(await moveFull(tokenEnv(), { from: "/a", to: "/b", dryRun: true })).toMatchObject({ action: "move", from: "/a", to: "/b" });
		expect(await moveFull(tokenEnv(), { from: "/a", to: "/b", dryRun: false })).toMatchObject({ ok: true, from: "/a", to: "/b" });
		await expect(moveFull(tokenEnv(), { from: "/a", to: "/a", dryRun: true })).rejects.toThrow(/nothing to move/);
	});
});

describe("operateFull — find→plan→apply over the gated primitives", () => {
	const searchHit = (path: string) => ({ metadata: { metadata: { ".tag": "file", path_display: path } } });

	it("plan (default apply:false) searches and reports targets, mutating nothing", async () => {
		const fetchMock = vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/search_v2")) return new Response(JSON.stringify({ matches: [searchHit("/Docs/a.pdf"), searchHit("/Docs/b.pdf")], has_more: false }), { status: 200 });
			throw new Error("no mutation allowed in a plan");
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await operateFull(tokenEnv(), { find: { query: "invoice" }, action: "move", dest: "/Archive", apply: false });
		expect(r).toMatchObject({ plan: true, action: "move", matched: 2, dest: "/Archive", targets: ["/Docs/a.pdf", "/Docs/b.pdf"] });
	});

	it("apply move relocates each found file into dest (basename preserved)", async () => {
		const moved: Array<[string, string]> = [];
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/search_v2")) return new Response(JSON.stringify({ matches: [searchHit("/Docs/a.pdf")], has_more: false }), { status: 200 });
			if (url.endsWith("/files/move_v2")) {
				const b = JSON.parse(init.body);
				moved.push([b.from_path, b.to_path]);
				return new Response(JSON.stringify({ metadata: { path_display: b.to_path } }), { status: 200 });
			}
			throw new Error(url);
		}));
		const r = await operateFull(tokenEnv(), { find: { query: "x" }, action: "move", dest: "/Archive", apply: true });
		expect(r).toMatchObject({ applied: 1, of: 1, action: "move" });
		expect(moved).toEqual([["/Docs/a.pdf", "/Archive/a.pdf"]]);
	});

	it("apply delete requires confirm:true, then deletes each", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/search_v2")) return new Response(JSON.stringify({ matches: [searchHit("/tmp/x")], has_more: false }), { status: 200 });
			throw new Error("no delete without confirm");
		}));
		await expect(operateFull(tokenEnv(), { find: { query: "x" }, action: "delete", apply: true })).rejects.toThrow(/confirm:true/);
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/search_v2")) return new Response(JSON.stringify({ matches: [searchHit("/tmp/x")], has_more: false }), { status: 200 });
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file" }), { status: 200 });
			if (url.endsWith("/files/delete_v2")) return new Response(JSON.stringify({ metadata: { path_display: "/tmp/x" } }), { status: 200 });
			throw new Error(url);
		}));
		expect(await operateFull(tokenEnv(), { find: { query: "x" }, action: "delete", apply: true, confirm: true })).toMatchObject({ applied: 1, action: "delete" });
	});

	it("accepts explicit handles and requires a query-or-handles", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("handles path must not search");
		}));
		expect(await operateFull(tokenEnv(), { handles: ["/a", "/b"], action: "move", dest: "/D", apply: false })).toMatchObject({ plan: true, matched: 2, targets: ["/a", "/b"] });
		await expect(operateFull(tokenEnv(), { action: "move", dest: "/D", apply: false })).rejects.toThrow(/find.*query.*handles/);
	});

	it("preserves the basename for a trailing-slash handle (normalized before move)", async () => {
		const moved: Array<[string, string]> = [];
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u).endsWith("/files/move_v2")) {
				const b = JSON.parse(init.body);
				moved.push([b.from_path, b.to_path]);
				return new Response(JSON.stringify({ metadata: { path_display: b.to_path } }), { status: 200 });
			}
			throw new Error(String(u));
		}));
		await operateFull(tokenEnv(), { handles: ["/OldPhotos/"], action: "move", dest: "/Archive", apply: true });
		expect(moved).toEqual([["/OldPhotos", "/Archive/OldPhotos"]]); // nested, not collapsed to /Archive
	});

	it("a per-item fence failure is captured, not fatal", async () => {
		const env = { DROPBOX_FULL_TOKEN: "ft", DROPBOX_FULL_PROTECT_PREFIXES: "/Protected" } as any;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u).endsWith("/files/move_v2")) {
				const b = JSON.parse(init.body);
				return new Response(JSON.stringify({ metadata: { path_display: b.to_path } }), { status: 200 });
			}
			throw new Error(String(u));
		}));
		const r = await operateFull(env, { handles: ["/ok.pdf", "/Protected/secret.pdf"], action: "move", dest: "/Archive", apply: true });
		expect(r.applied).toBe(1); // only the un-fenced file moved
		expect((r.results as any[])[1].error).toMatch(/protected prefix/);
	});
});
