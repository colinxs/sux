import { describe, expect, it } from "vitest";

import { FUNCTIONS } from "./fns/index";
import type { RtEnv, ToolResult } from "./registry";

// Inert binding stubs: {} args should fail validation inside each fn before any
// binding is touched, so these never need to do real work.
const fakeEnv = {
	OAUTH_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [] }) },
	R2: { get: async () => null, put: async () => undefined, head: async () => null, delete: async () => undefined, list: async () => ({ objects: [] }) },
	AI: { run: async () => ({}) },
	IMAGES: { input: () => ({ transform: () => ({}), output: async () => ({ response: () => new Response() }) }) },
	KAGI_API_KEY: "",
	ALLOWED_GITHUB_LOGIN: "",
} as unknown as RtEnv;

function isWellFormed(r: ToolResult): boolean {
	return (
		!!r &&
		Array.isArray(r.content) &&
		r.content.length > 0 &&
		r.content.every((c) => c.type === "text" && typeof c.text === "string")
	);
}

describe("registry conformance", () => {
	it("has unique, well-formed names", () => {
		const names = FUNCTIONS.map((f) => f.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name).toMatch(/^[a-z0-9_]+$/);
	});

	it("has a non-empty description on every fn", () => {
		for (const f of FUNCTIONS) {
			expect(typeof f.description, f.name).toBe("string");
			expect(f.description.length, f.name).toBeGreaterThan(0);
		}
	});

	it("has an object inputSchema with required ⊆ properties", () => {
		for (const f of FUNCTIONS) {
			const s = f.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
			expect(s?.type, f.name).toBe("object");
			expect(s.properties, f.name).toBeTypeOf("object");
			const keys = Object.keys(s.properties ?? {});
			for (const req of s.required ?? []) expect(keys, `${f.name}: required "${req}"`).toContain(req);
		}
	});

	it("run(env, {}) resolves to a well-formed ToolResult (never throws)", async () => {
		for (const f of FUNCTIONS) {
			expect(typeof f.run, f.name).toBe("function");
			let result: ToolResult;
			try {
				result = await f.run(fakeEnv, {});
			} catch (e) {
				throw new Error(`${f.name}: run threw instead of returning a ToolResult: ${e}`);
			}
			expect(isWellFormed(result), `${f.name}: malformed ToolResult ${JSON.stringify(result)}`).toBe(true);
		}
	});

	it("flags: kv_* are not cacheable; hash/encode/compress are raw", () => {
		const byName = new Map(FUNCTIONS.map((f) => [f.name, f]));
		for (const name of ["kv_get", "kv_put", "kv_list", "kv_delete"]) {
			expect(byName.get(name)?.cacheable, name).toBeFalsy();
		}
		for (const name of ["hash", "encode", "compress"]) {
			expect(byName.get(name)?.raw, name).toBe(true);
		}
	});
});
