import { describe, expect, it } from "vitest";

import { hash } from "./hash";

describe("hash", () => {
	it("rejects an unknown algorithm", async () => {
		const r = await hash.run({} as any, { text: "hello", algo: "md5" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown algo/);
	});

	it("computes a sha256 digest by default", async () => {
		const r = await hash.run({} as any, { text: "hello" });
		expect(r.isError).toBeFalsy();
		// Known SHA-256 of "hello".
		expect(r.content[0].text).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});

	it("honors a non-default algorithm (sha1)", async () => {
		const r = await hash.run({} as any, { text: "hello", algo: "sha1" });
		expect(r.isError).toBeFalsy();
		// Known SHA-1 of "hello".
		expect(r.content[0].text).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
	});

	it("hashes empty text when none is provided", async () => {
		const r = await hash.run({} as any, {});
		expect(r.isError).toBeFalsy();
		// Known SHA-256 of the empty string.
		expect(r.content[0].text).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});
