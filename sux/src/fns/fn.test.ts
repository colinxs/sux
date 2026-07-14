import { describe, expect, it } from "vitest";

import type { RtEnv } from "../registry";
// fn.ts ↔ index.ts is circular; import index FIRST so it's the entry module and its
// FUNCTIONS array is built after fn.ts finishes evaluating (else the fn slot is undefined).
import "./index";
import { fnEscape } from "./fn";

// fnEscape.run is the fallback the dispatcher's unwrap normally skips (index.ts
// handleRpc unwraps `fn` before findFn). registry.test.ts covers unwrapFnCall; this
// drives run() directly to exercise its guard/error branches + a real delegate.
const env = {} as RtEnv;

describe("fnEscape.run", () => {
	it("rejects a missing/empty name with bad_input", async () => {
		for (const args of [{}, { name: "" }, { name: "   " }, { name: 42 }]) {
			const r = await fnEscape.run(env, args as never);
			expect(r.isError).toBe(true);
			expect(r.errorCode).toBe("bad_input");
		}
	});

	it("refuses to call itself", async () => {
		const r = await fnEscape.run(env, { name: "fn", args: {} });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(r.content[0].text).toContain("fn cannot call itself");
	});

	it("returns not_found for an unknown leaf", async () => {
		const r = await fnEscape.run(env, { name: "definitely_not_a_real_leaf" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_found");
	});

	it("rejects non-object args with bad_input", async () => {
		for (const args of [{ name: "hash", args: [1, 2] }, { name: "hash", args: "nope" }]) {
			const r = await fnEscape.run(env, args as never);
			expect(r.isError).toBe(true);
			expect(r.errorCode).toBe("bad_input");
			expect(r.content[0].text).toContain("`args` must be an object");
		}
	});

	it("delegates to a real leaf on the happy path", async () => {
		// hash is a pure deterministic leaf; SHA-256 of "" is well known.
		const r = await fnEscape.run(env, { name: "hash", args: { text: "" } });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("defaults omitted args to an empty object (no-arg leaf shape)", async () => {
		const r = await fnEscape.run(env, { name: "hash" });
		// hash with no text hashes the empty string — same digest, proving inner={} was passed.
		expect(r.content[0].text).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});
