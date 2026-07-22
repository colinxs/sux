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

	it("does not feed the infer signal log when INFER_ARM_VAULT is unset (dormant by default)", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const store = new Map<string, string>();
		const OAUTH_KV = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
		const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
		const env = { ...ENV, OAUTH_KV, AI: { run: aiRun } };
		await ingest.run(env, { text: "Some captured note body." });
		expect(aiRun).not.toHaveBeenCalled();
		expect(await readInferSignals(env, "vault")).toEqual([]);
	});

	it("feeds a redacted, embedded signal into the infer log when INFER_ARM_VAULT is armed", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const store = new Map<string, string>();
		const OAUTH_KV = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
		const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] }));
		const env = { ...ENV, OAUTH_KV, AI: { run: aiRun }, INFER_ARM_VAULT: "1" };
		const r = await ingest.run(env, { text: "Reach me at colin@example.com about this.", title: "Contact note" });
		const out = JSON.parse(r.content[0].text);
		expect(aiRun).toHaveBeenCalledTimes(1);
		const signals = await readInferSignals(env, "vault");
		expect(signals).toHaveLength(1);
		expect(signals[0].vec).toEqual([0.1, 0.2, 0.3]);
		expect(signals[0].source_tag).toBe(`vault:${out.note}`);
		expect(signals[0].redacted_snippet).not.toContain("colin@example.com");
		expect(signals[0].redacted_snippet).toMatch(/\[REDACTED:email\]/);
	});

	it("content-fingerprint dedup: a repeat capture of identical text returns the existing note instead of a -1 twin (#1175)", async () => {
		const gh = ghMock();
		let putCount = 0;
		routes.handler = (url: string, init?: any) => {
			if (init?.method === "PUT") putCount++;
			return gh.handler(url, init);
		};
		const store = new Map<string, string>();
		const OAUTH_KV = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
		const env = { ...ENV, OAUTH_KV };
		const r1 = await ingest.run(env, { text: "Duplicate-prone content." });
		const out1 = JSON.parse(r1.content[0].text);
		expect(out1.duplicate).toBeUndefined();
		expect(putCount).toBe(1);

		const r2 = await ingest.run(env, { text: "Duplicate-prone content." });
		const out2 = JSON.parse(r2.content[0].text);
		expect(out2).toMatchObject({ ok: true, note: out1.note, duplicate: true });
		expect(putCount).toBe(1); // no second write happened

		// Distinct content under the SAME title still lands its own capture (dedup is keyed on
		// resolved content, not the title/source) — a real write happens, not a dedup short-circuit.
		const r3 = await ingest.run(env, { text: "Different content entirely.", title: "Duplicate-prone content." });
		const out3 = JSON.parse(r3.content[0].text);
		expect(out3.duplicate).toBeUndefined();
		expect(putCount).toBe(2);

		// force:true bypasses the dedup even for identical content.
		const r4 = await ingest.run(env, { text: "Duplicate-prone content.", force: true });
		const out4 = JSON.parse(r4.content[0].text);
		expect(out4.duplicate).toBeUndefined();
		expect(putCount).toBe(3);
	});

	it("auto-detects a pasted NSLDS MyStudentData.txt and writes a structured student-loan note (#1323)", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const fixture = [
			"NSLDS Aggregate Data",
			"Recipient Name: Jane Doe",
			"Guaranty Agency: US Dept of Ed",
			"Loan Type: Direct Subsidized",
			"Loan Status: Repayment",
			"Servicer: MOHELA",
			"Outstanding Principal Balance: $5,000.00",
			"Interest Rate: 4.53%",
			"Loan PSLF Cumulative Matched Months: 24",
			"Loan Type: Direct Unsubsidized",
			"Loan Status: Deferment",
			"Servicer: Aidvantage",
			"Outstanding Principal Balance: $3,000.00",
			"Interest Rate: 5.28%",
			"Loan PSLF Cumulative Matched Months: 10",
		].join("\n");
		const r = await ingest.run(ENV, { text: fixture });
		const out = JSON.parse(r.content[0].text);
		expect(out.ok).toBe(true);
		expect(out.pass).toBe(undefined);
		const note = gh.puts[out.note];
		expect(note).toContain("kind: \"student-loan-aggregate\"");
		expect(note).toContain("loan_count: 2");
		expect(note).toContain("total_outstanding_principal: 8000");
		expect(note).toContain("tags: [capture, student-loan, nslds]");
		expect(note).toContain("### Loan 1: Direct Subsidized");
		expect(note).toContain("**Servicer:** MOHELA");
	});

	it("does not treat NSLDS detection/summarize as mutually exclusive silently — reports skipped instead", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const fixture = [
			"NSLDS Aggregate Data",
			"Recipient Name: Jane Doe",
			"Guaranty Agency: US Dept of Ed",
			"Loan Type: Direct Subsidized",
			"Loan Status: Repayment",
			"Servicer: MOHELA",
			"Outstanding Principal Balance: $5,000.00",
			"Interest Rate: 4.53%",
			"Loan PSLF Cumulative Matched Months: 24",
			"Loan Type: Direct Unsubsidized",
			"Loan Status: Deferment",
			"Servicer: Aidvantage",
			"Outstanding Principal Balance: $3,000.00",
			"Interest Rate: 5.28%",
			"Loan PSLF Cumulative Matched Months: 10",
		].join("\n");
		const r = await ingest.run(ENV, { text: fixture, summarize: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.pass).toBe("skipped (structured student-loan capture)");
	});
});

// The WRITE half of the toss-path core loop (#1287): a tossed note is handed to the
// assimilation spine and lands a retrievable index entry — asserted at the index boundary
// (the assim:doc chunk store), NOT via `oracle ask` retrieval (that read half is #1298).
describe("ingest → assimilation spine (#1287)", () => {
	// A Map-backed OAUTH_KV with the get/put/list surface putChunk/listChunks need.
	function makeKv() {
		const store = new Map<string, string>();
		return {
			store,
			get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
			put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
			delete: vi.fn(async (k: string) => void store.delete(k)),
			list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
				keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
				list_complete: true as const,
			})),
		};
	}

	// Mock Workers-AI: an embed call (text[]) → unit vectors; a messages call → a distilled note,
	// or a profile summary for the authoritative-profile system prompt (the _source.ts profile leg).
	const okAiRun = () =>
		vi.fn(async (_model: string, inputs: any) => {
			if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => [1, 0, 0]) };
			const system = inputs.messages.find((m: any) => m.role === "system").content;
			if (/^You are distilling an AUTHORITATIVE/.test(system)) return { response: "PROFILE-SUMMARY" };
			return { response: "DISTILLED note about renewing the passport." };
		});

	const assimEnv = (opts: { enabled?: string; aiRun?: any } = {}) => {
		const deferred: Promise<unknown>[] = [];
		const kv = makeKv();
		const env: any = {
			...ENV,
			OAUTH_KV: kv,
			AI: { run: opts.aiRun ?? okAiRun() },
			_egress: { ctx: { waitUntil: (p: Promise<unknown>) => void deferred.push(p) }, reqId: "r" },
		};
		if (opts.enabled !== undefined) env.ASSIMILATE_ENABLED = opts.enabled;
		return { env, kv, deferred };
	};

	const assimChunkKeys = (kv: ReturnType<typeof makeKv>) => [...kv.store.keys()].filter((k) => k.startsWith("sux:source:chunk:assim:"));

	it("hands tossed text to the spine and writes an index entry under assim:doc, cited to the note", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const { env, kv, deferred } = assimEnv({ enabled: "1" });
		const r = await ingest.run(env, { text: "Renew the passport before the September trip." });
		const out = JSON.parse(r.content[0].text);
		expect(out.ok).toBe(true);
		// The capture response never waits on the spine — it was deferred to ctx.waitUntil, and
		// nothing is indexed yet on the response path.
		expect(deferred).toHaveLength(1);
		expect(assimChunkKeys(kv)).toHaveLength(0);

		await Promise.all(deferred); // run the backgrounded spine

		const keys = assimChunkKeys(kv);
		expect(keys.length).toBeGreaterThan(0);
		const chunk = JSON.parse(kv.store.get(keys[0])!);
		expect(chunk.domain).toBe("assim:doc");
		// Provenance: every indexed passage is stamped with the note's own vault path, so the
		// eventual `oracle ask` citation of this passage points back at the ingested note.
		expect(chunk.title).toBe(out.note);
		expect(Array.isArray(chunk.embedding)).toBe(true);
	});

	it("leaves the capture untouched when the spine is dark (ASSIMILATE_ENABLED unset)", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const { env, kv, deferred } = assimEnv(); // no ASSIMILATE_ENABLED
		const r = await ingest.run(env, { text: "A note captured while the spine is off." });
		const out = JSON.parse(r.content[0].text);
		expect(out.ok).toBe(true);
		expect(gh.puts[out.note]).toContain("A note captured while the spine is off.");
		// Dark spine: nothing was even scheduled, and no index entry was written.
		expect(deferred).toHaveLength(0);
		expect(assimChunkKeys(kv)).toHaveLength(0);
	});

	it("a spine failure never fails the capture (best-effort, log-and-continue)", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const aiRun = vi.fn(async () => {
			throw new Error("AI down");
		});
		const { env, kv, deferred } = assimEnv({ enabled: "1", aiRun });
		const r = await ingest.run(env, { text: "The capture must survive an assimilation failure." });
		const out = JSON.parse(r.content[0].text);
		expect(out.ok).toBe(true); // the note landed regardless
		expect(gh.puts[out.note]).toContain("The capture must survive an assimilation failure.");
		// The backgrounded spine rejects internally, but backgroundAssimilate's .catch swallows it —
		// awaiting the deferred task does not throw, and nothing was indexed.
		await expect(Promise.all(deferred)).resolves.toBeDefined();
		expect(assimChunkKeys(kv)).toHaveLength(0);
	});
});
