import { describe, expect, it } from "vitest";
import { gzipSync, zipSync } from "fflate";
import { archive } from "./archive";

describe("archive", () => {
	it("round-trips a zip with text and binary entries", async () => {
		const bin = btoa("\x00\x01\x02binary\xff"); // has NUL/high byte -> not utf-8
		const packed = await archive.run({} as any, {
			op: "pack",
			format: "zip",
			files: [
				{ name: "hello.txt", content: "hello world" },
				{ name: "raw.bin", base64: bin },
			],
		});
		const meta = JSON.parse(packed.content[0].text);
		expect(meta.format).toBe("zip");
		expect(meta.bytes).toBeGreaterThan(0);

		const un = await archive.run({} as any, { op: "unpack", format: "zip", base64: meta.base64 });
		const out = JSON.parse(un.content[0].text);
		const names = out.entries.map((e: any) => e.name).sort();
		expect(names).toEqual(["hello.txt", "raw.bin"]);
		const txt = out.entries.find((e: any) => e.name === "hello.txt");
		expect(txt.text).toBe("hello world");
		const raw = out.entries.find((e: any) => e.name === "raw.bin");
		expect(raw.text).toBeUndefined(); // binary not decoded to text
	});

	it("gzips and gunzips a single file", async () => {
		const packed = await archive.run({} as any, { op: "pack", format: "gzip", files: [{ name: "x", content: "gzip me ".repeat(50) }] });
		const meta = JSON.parse(packed.content[0].text);
		expect(meta.format).toBe("gzip");
		const un = await archive.run({} as any, { op: "unpack", format: "gzip", base64: meta.base64 });
		const out = JSON.parse(un.content[0].text);
		expect(out.entries).toHaveLength(1);
		expect(out.entries[0].text).toBe("gzip me ".repeat(50));
	});

	it("rejects gzip pack with multiple files", async () => {
		const r = await archive.run({} as any, { op: "pack", format: "gzip", files: [{ name: "a", content: "1" }, { name: "b", content: "2" }] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/exactly one file/);
	});

	it("fails on bad base64 / corrupt archive", async () => {
		const r = await archive.run({} as any, { op: "unpack", format: "zip", base64: "bm90YXppcA==" });
		expect(r.isError).toBe(true);
	});

	it('pack as:"url" stores the archive in the CAS store and returns a compact ref', async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		const r = await archive.run(env, { op: "pack", format: "zip", as: "url", files: [{ name: "a.txt", content: "hello" }] });
		expect(r.isError).toBeFalsy();
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("application/zip");
		expect(ref.size).toBeGreaterThan(0);
	});

	it("fails a gzip bomb instead of OOM-ing (decompressed-size cap)", async () => {
		// ~21MB of zeros compresses to a few KB but blows past the 20MB unpack budget.
		const bomb = gzipSync(new Uint8Array(21_000_000), { level: 9 });
		const b64 = Buffer.from(bomb).toString("base64");
		const r = await archive.run({} as any, { op: "unpack", format: "gzip", base64: b64 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/bomb guard/);
	});

	it("fails a zip bomb whose declared entry size exceeds the cap", async () => {
		const packed = zipSync({ "big.bin": new Uint8Array(21_000_000) }, { level: 9 });
		const b64 = Buffer.from(packed).toString("base64");
		const r = await archive.run({} as any, { op: "unpack", format: "zip", base64: b64 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/bomb guard/);
	});

	it('unpack as:"url" returns a consumable CAS ref per entry, including binary ones', async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		const bin = btoa("\x00\x01\x02binary\xff");
		const packed = await archive.run({} as any, { op: "pack", format: "zip", files: [{ name: "t.txt", content: "text" }, { name: "b.bin", base64: bin }] });
		const meta = JSON.parse(packed.content[0].text);
		const un = await archive.run(env, { op: "unpack", format: "zip", base64: meta.base64, as: "url" });
		expect(un.isError).toBeFalsy();
		const out = JSON.parse(un.content[0].text);
		for (const e of out.entries) {
			expect(e.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
			expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		const raw = out.entries.find((e: any) => e.name === "b.bin");
		expect(raw.text).toBeUndefined(); // binary still not inlined as text
		expect(raw.bytes).toBeGreaterThan(0);
	});
});
