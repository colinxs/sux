import { afterEach, describe, expect, it, vi } from "vitest";

// The vault write path (ghJson) and loadBytes both go through smartFetch; the
// Dropbox upload uses global fetch — each side is mocked independently.
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response | Promise<Response>) }));
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { ingest } from "./ingest";
import { readInferSignals } from "./_infer";

const ENV = { OBSIDIAN_VAULT_REPO: "me/vault" } as any;
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** GitHub contents mock capturing PUTs. GETs 404 unless the path is in `existing`
 * (which is how vaultPut's failIfExists collision check sees a taken filename). */
const ghMock = (existing: string[] = []) => {
	const puts: Record<string, string> = {};
	const handler = (url: string, init?: any): Response => {
		const path = decodeURIComponent((url.split("/contents/")[1] ?? "").split("?")[0]);
		if (init?.method === "PUT") {
			puts[path] = Buffer.from(JSON.parse(init.body).content, "base64").toString("utf8");
			return new Response(JSON.stringify({ commit: { sha: "c1" } }), { status: 201 });
		}
		if (existing.includes(path)) return new Response(JSON.stringify({ content: Buffer.from("old").toString("base64"), sha: "s0" }), { status: 200 });
		return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
	};
	return { puts, handler };
};

describe("ingest (capture → vault)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("requires exactly one source", async () => {
		const r = await ingest.run(ENV, { url: "https://x.com", text: "hi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/exactly one source/);
	});

	it("captures text into Inbox with provenance frontmatter", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "# Meeting notes\nAlice said yes.", tags: ["meeting"] });
		const out = JSON.parse(r.content[0].text);
		expect(out).toMatchObject({ ok: true, note: `Inbox/${date} meeting-notes.md`, commit: "c1", source: "text" });
		const note = gh.puts[out.note];
		expect(note).toContain("type: capture");
		expect(note).toContain('source: "text"');
		expect(note).toContain("tags: [capture, meeting]");
		expect(note).toContain("Alice said yes.");
	});

	it("captures a web page as markdown, titled from <title>", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response("<html><head><title>Great Post</title></head><body><h1>Great Post</h1><p>Body <b>bold</b>.</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		};
		const r = await ingest.run(ENV, { url: "https://blog.example/post" });
		const out = JSON.parse(r.content[0].text);
		expect(out.note).toBe(`Inbox/${date} great-post.md`);
		const note = gh.puts[out.note];
		expect(note).toContain('source: "https://blog.example/post"');
		expect(note).toContain("# Great Post");
		expect(note).toMatch(/\*\*bold\*\*|__bold__/);
	});

	it("commits a small binary into the vault and embeds it", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(Buffer.from([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf" } });
		};
		const r = await ingest.run(ENV, { url: "https://files.example/report.pdf" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob).toMatchObject({ placement: "vault", size: 4, content_type: "application/pdf" });
		expect(gh.puts[`Attachments/${date}-report.pdf`]).toBeDefined();
		expect(gh.puts[out.note]).toContain(`![[Attachments/${date}-report.pdf]]`);
	});

	it("disambiguates a same-day attachment name instead of overwriting the first file", async () => {
		const taken = `Attachments/${date}-report.pdf`;
		const gh = ghMock([taken]); // a report.pdf already captured today
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } });
		};
		const r = await ingest.run(ENV, { url: "https://other.example/x/report.pdf" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob.link).toBe(`Attachments/${date}-report-1.pdf`); // the extension is preserved
		expect(gh.puts[taken]).toBeUndefined(); // first file's bytes untouched
		expect(gh.puts[out.note]).toContain(`![[Attachments/${date}-report-1.pdf]]`);
	});

	it("routes a large binary to Dropbox and links the shared URL", async () => {
		const gh = ghMock();
		const big = new Uint8Array(1_100_000);
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(big, { status: 200, headers: { "content-type": "application/zip" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const s = String(u);
			if (s.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/big.zip", size: big.length }), { status: 200 });
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/big.zip" }), { status: 200 });
		}));
		const r = await ingest.run({ ...ENV, DROPBOX_TOKEN: "dbx" }, { url: "https://files.example/big.zip" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob).toMatchObject({ placement: "dropbox", link: "https://www.dropbox.com/s/x/big.zip" });
		expect(gh.puts[out.note]).toContain("[big.zip](https://www.dropbox.com/s/x/big.zip)");
		expect(gh.puts[`Attachments/${date}-big.zip`]).toBeUndefined();
	});

	it("blobs:'dropbox' forces even a small binary to Dropbox", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(Buffer.from([1, 2]), { status: 200, headers: { "content-type": "image/png" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const s = String(u);
			if (s.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/i.png", size: 2 }), { status: 200 });
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/i.png" }), { status: 200 });
		}));
		const r = await ingest.run({ ...ENV, DROPBOX_TOKEN: "dbx" }, { url: "https://files.example/i.png", blobs: "dropbox" });
		expect(JSON.parse(r.content[0].text).blob.placement).toBe("dropbox");
	});

	it("routes blobs to Dropbox under the DURABLE refresh config (no static DROPBOX_TOKEN)", async () => {
		// The production config: refresh token + app key, NO static DROPBOX_TOKEN.
		// Regression for the final-analysis HIGH — this used to fall back to R2.
		const gh = ghMock();
		const big = new Uint8Array(1_100_000);
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(big, { status: 200, headers: { "content-type": "application/zip" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const s = String(u);
			if (s === "https://api.dropbox.com/oauth2/token") return new Response(JSON.stringify({ access_token: "sl.fresh", expires_in: 14400 }), { status: 200 });
			if (s.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/big.zip", size: big.length }), { status: 200 });
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/big.zip" }), { status: 200 });
		}));
		const env = { ...ENV, DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak", OAUTH_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as any;
		const r = await ingest.run(env, { url: "https://files.example/big.zip" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob.placement).toBe("dropbox"); // NOT r2
		expect(out.blob.link).toBe("https://www.dropbox.com/s/x/big.zip");
	});

	it("falls through to R2 when the Dropbox upload FAILS (token lapse/5xx), never losing the capture", async () => {
		// Dropbox is configured (so today's code would have returned fail) but the
		// upload 500s — the capture must still land, in R2, stamped as such.
		const gh = ghMock();
		const big = new Uint8Array(1_100_000);
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(big, { status: 200, headers: { "content-type": "application/zip" } });
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL) => {
				if (String(u).endsWith("/files/upload")) return new Response(JSON.stringify({ error_summary: "internal_error/" }), { status: 500 });
				return new Response("{}", { status: 200 });
			}),
		);
		const r2puts: Array<[string, Uint8Array]> = [];
		const env = {
			...ENV,
			DROPBOX_TOKEN: "dbx",
			R2: { put: async (k: string, b: Uint8Array) => void r2puts.push([k, b]) },
			OAUTH_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
		} as any;
		const r = await ingest.run(env, { url: "https://files.example/big.zip" });
		const out = JSON.parse(r.content[0].text);
		expect(r.isError).toBeUndefined();
		expect(out.blob.placement).toBe("r2 (dropbox upload failed)"); // NOT a fail(), NOT "not configured"
		expect(out.blob.link).toMatch(/^https:\/\/.*\/s\//); // resolvable R2 handle
		expect(r2puts).toHaveLength(1); // bytes actually stored
		expect(gh.puts[out.note]).toContain(`(${out.blob.link})`); // note links the R2 blob
	});

	it("explicit path overrides the Inbox default", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "quick thought", path: "Inbox/thought.md" });
		expect(JSON.parse(r.content[0].text).note).toBe("Inbox/thought.md");
		expect(gh.puts["Inbox/thought.md"]).toContain("quick thought");
	});

	it("compress:true stores only the distilled summary", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const env = { ...ENV, AI: { run: async () => ({ response: "• distilled point" }) } };
		const r = await ingest.run(env, { text: "A very long meeting transcript\nline\nline\nline", compress: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.pass).toBe("compressed");
		const note = gh.puts[out.note];
		expect(note).toContain("• distilled point");
		expect(note).toContain("the original was not retained");
		expect(note).not.toContain("line\nline\nline");
	});

	it("summarize:true prepends a summary section above the verbatim body", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const env = { ...ENV, AI: { run: async () => ({ response: "One-paragraph gist." }) } };
		const r = await ingest.run(env, { text: "Original body stays.", summarize: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.pass).toBe("summarized");
		const note = gh.puts[out.note];
		expect(note).toContain("## Summary");
		expect(note).toContain("One-paragraph gist.");
		expect(note).toContain("Original body stays.");
	});

	it("passes degrade to verbatim capture when AI is unavailable", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "keep me verbatim", summarize: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.ok).toBe(true);
		expect(out.pass).toMatch(/unavailable/);
		expect(gh.puts[out.note]).toContain("keep me verbatim");
	});

	it("a same-day slug collision disambiguates instead of overwriting", async () => {
		const taken = `Inbox/${date} untitled.md`;
		const gh = ghMock([taken]);
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "second capture", title: "Untitled" });
		const out = JSON.parse(r.content[0].text);
		expect(out.note).toBe(`Inbox/${date} untitled-1.md`);
		expect(gh.puts[taken]).toBeUndefined(); // the first capture survives
		expect(gh.puts[out.note]).toContain("second capture");
	});

	it("disambiguates again when both the base and -1 are taken (no same-second loss)", async () => {
		const base = `Inbox/${date} note.md`;
		const gh = ghMock([base, `Inbox/${date} note-1.md`]);
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "third", title: "Note" });
		expect(JSON.parse(r.content[0].text).note).toBe(`Inbox/${date} note-2.md`);
	});

	it("an explicit path still overwrites deliberately", async () => {
		const gh = ghMock(["Inbox/thought.md"]);
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "replacement", path: "Inbox/thought.md" });
		const out = JSON.parse(r.content[0].text);
		expect(out.note).toBe("Inbox/thought.md");
		expect(out.created).toBe(false);
		expect(gh.puts["Inbox/thought.md"]).toContain("replacement");
	});

	it("refuses a path that escapes the note tree", async () => {
		routes.handler = ghMock().handler;
		const r = await ingest.run(ENV, { text: "x", path: ".github/workflows/pwn.yml" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Refusing vault path/);
	});

	it("escapes YAML-hostile source/title and sanitizes tags so frontmatter can't be injected", async () => {
		const gh = ghMock();
		const hostileUrl = 'https://x.example/a?q="';
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response('<html><title>Ti"tle\ninjected: pwned</title><body>b</body></html>', { status: 200, headers: { "content-type": "text/html" } });
		};
		const r = await ingest.run(ENV, { url: hostileUrl, tags: ["c++]x", "ok-tag"] });
		const note = gh.puts[JSON.parse(r.content[0].text).note];
		const fm = note.slice(0, note.indexOf("\n---", 4));
		expect(fm).not.toMatch(/^injected:/m); // no injected top-level key
		expect(fm).toContain(`source: ${JSON.stringify(hostileUrl)}`); // quote escaped in the scalar
		expect(fm).toContain("tags: [capture, c-x, ok-tag]"); // ']' can't break the flow list
		expect(note).not.toMatch(/# .*\n.*injected/); // heading is single-line
	});

	it("compress on text is honest that the original is gone; on url that it is re-fetchable", async () => {
		const ai = { run: async () => ({ response: "gist" }) };
		const gh1 = ghMock();
		routes.handler = gh1.handler;
		const r1 = await ingest.run({ ...ENV, AI: ai }, { text: "long thing", compress: true });
		expect(gh1.puts[JSON.parse(r1.content[0].text).note]).toContain("the original was not retained");

		const gh2 = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh2.handler(url, init);
			return new Response("<html><title>P</title><body>text</body></html>", { status: 200, headers: { "content-type": "text/html" } });
		};
		const r2 = await ingest.run({ ...ENV, AI: ai }, { url: "https://x.example/p", compress: true });
		expect(gh2.puts[JSON.parse(r2.content[0].text).note]).toContain("re-fetchable from");
	});

	it("marks summarize as skipped for binary captures", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(Buffer.from([1, 2]), { status: 200, headers: { "content-type": "application/pdf" } });
		};
		const r = await ingest.run({ ...ENV, AI: { run: async () => ({ response: "x" }) } }, { url: "https://f.example/a.pdf", summarize: true });
		expect(JSON.parse(r.content[0].text).pass).toMatch(/skipped \(binary/);
	});

	it("labels a minted Dropbox link as a public shared link in the note", async () => {
		const gh = ghMock();
		const big = new Uint8Array(1_100_000);
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(big, { status: 200, headers: { "content-type": "application/zip" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/big.zip", size: big.length }), { status: 200 });
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/big.zip" }), { status: 200 });
		}));
		const r = await ingest.run({ ...ENV, DROPBOX_TOKEN: "d" }, { url: "https://f.example/big.zip" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob.link).toBe("https://www.dropbox.com/s/x/big.zip");
		expect(gh.puts[out.note]).toContain("(public shared link)");
		expect(gh.puts[out.note]).toContain("[big.zip](https://www.dropbox.com/s/x/big.zip)");
	});

	it("does not feed the infer signal log when INFER_ARM_FILES is unset (dormant by default)", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const store = new Map<string, string>();
		const OAUTH_KV = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
		const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
		const env = { ...ENV, OAUTH_KV, AI: { run: aiRun } };
		await ingest.run(env, { text: "Some captured note body." });
		expect(aiRun).not.toHaveBeenCalled();
		expect(await readInferSignals(env, "files")).toEqual([]);
	});

	it("feeds a redacted, embedded signal into the infer log when INFER_ARM_FILES is armed", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const store = new Map<string, string>();
		const OAUTH_KV = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
		const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] }));
		const env = { ...ENV, OAUTH_KV, AI: { run: aiRun }, INFER_ARM_FILES: "1" };
		const r = await ingest.run(env, { text: "Reach me at colin@example.com about this.", title: "Contact note" });
		const out = JSON.parse(r.content[0].text);
		expect(aiRun).toHaveBeenCalledTimes(1);
		const signals = await readInferSignals(env, "files");
		expect(signals).toHaveLength(1);
		expect(signals[0].vec).toEqual([0.1, 0.2, 0.3]);
		expect(signals[0].source_tag).toBe(`files:${out.note}`);
		expect(signals[0].redacted_snippet).not.toContain("colin@example.com");
		expect(signals[0].redacted_snippet).toMatch(/\[REDACTED:email\]/);
	});

	it("flags the Dropbox link as public and degrades honestly when none is minted", async () => {
		const gh = ghMock();
		const big = new Uint8Array(1_100_000);
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(big, { status: 200, headers: { "content-type": "application/zip" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/big.zip", size: big.length }), { status: 200 });
			return new Response(JSON.stringify({ error_summary: "missing_scope/" }), { status: 403 });
		}));
		const r = await ingest.run({ ...ENV, DROPBOX_TOKEN: "d" }, { url: "https://f.example/big.zip" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob.link).toBe("/attachments/big.zip"); // no dead dropbox: pseudo-url
		expect(gh.puts[out.note]).toContain("no shared link minted");
	});
});
