import { describe, expect, it } from "vitest";

import { FUNCTIONS } from "./fns/index";
import { FAIL_CODES, type FailCode, failWith, FRONT_VERBS, frontToolList, type RtEnv, TOOL_ANNOTATIONS, toolList, type ToolResult, unwrapFnCall } from "./registry";

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

	it("failWith carries a machine code as an errorCode + [code] prefix, human text preserved", () => {
		const r = failWith("blocked", "costco: blocked by Akamai (try render:mac) — no products");
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("blocked");
		expect(r.content[0].text).toBe("[blocked] costco: blocked by Akamai (try render:mac) — no products");
		// The human message survives verbatim after the machine prefix.
		expect(r.content[0].text.endsWith("no products")).toBe(true);
	});

	it("the transport + retail fail sites surface a code from the fixed taxonomy", async () => {
		// Each of these drives a real fail site with {} args: the code is both a
		// structured errorCode and a [code] prefix on the text, so callers + Grafana
		// (which derives its `err` field from the first text part) can group failures.
		const cases: Array<[string, FailCode]> = [
			["proxy", "bad_input"], // url missing
			["scrape", "bad_input"], // url missing
			["geo_fetch", "bad_input"], // url missing
			["render", "bad_input"], // url missing
			["kroger", "not_configured"], // KROGER_CLIENT_ID/SECRET absent
			["costco", "bad_input"], // term missing
			["ace", "bad_input"], // term missing
			["homedepot", "bad_input"], // term missing
			["walmart", "bad_input"], // term missing
		];
		const byName = new Map(FUNCTIONS.map((f) => [f.name, f]));
		for (const [name, code] of cases) {
			const fn = byName.get(name);
			expect(fn, `${name} is registered`).toBeTruthy();
			const r = await fn!.run(fakeEnv, {});
			expect(r.isError, `${name} should fail on {} args`).toBe(true);
			expect(r.errorCode, `${name} errorCode`).toBe(code);
			expect(FAIL_CODES).toContain(r.errorCode);
			expect(r.content[0].text.startsWith(`[${code}] `), `${name} text carries the [code] prefix`).toBe(true);
		}
	});

	it("toolList carries name/description/inputSchema and threads annotations when present", () => {
		const tools = toolList(FUNCTIONS);
		expect(tools.length).toBe(FUNCTIONS.length);
		const byName = new Map(tools.map((t) => [t.name, t]));
		for (const t of tools) {
			expect(typeof t.name).toBe("string");
			expect(typeof t.description).toBe("string");
			expect(t.inputSchema).toBeTypeOf("object");
		}
		// A web-reaching read-only tool advertises both hints…
		expect(byName.get("search")?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
		// …a mutating store advertises destructive+non-idempotent…
		expect(byName.get("store")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
		// …a per-fn override wins over the central map (sux self-declares)…
		expect(byName.get("sux")?.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
		// …and an unclassified/mixed tool omits the key entirely (no empty object).
		expect("annotations" in (byName.get("jmap") as object)).toBe(false);
	});

	it("every annotation hint is a boolean over the four known keys, and destructive⇒not read-only", () => {
		const allowed = new Set(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
		for (const t of toolList(FUNCTIONS)) {
			const a = t.annotations;
			if (!a) continue;
			for (const [k, v] of Object.entries(a)) {
				expect(allowed.has(k), `${t.name}: unknown annotation ${k}`).toBe(true);
				expect(typeof v, `${t.name}.${k}`).toBe("boolean");
			}
			// destructiveHint is only meaningful when the tool is not read-only.
			if (a.destructiveHint) expect(a.readOnlyHint, `${t.name} destructive but read-only`).not.toBe(true);
		}
	});

	it("the central annotation map only references registered fns", () => {
		const names = new Set(FUNCTIONS.map((f) => f.name));
		for (const key of Object.keys(TOOL_ANNOTATIONS)) expect(names, `TOOL_ANNOTATIONS references \`${key}\``).toContain(key);
	});

	it("frontToolList advertises only the front verbs — a small, legible subset of the full surface", () => {
		const front = frontToolList(FUNCTIONS);
		const names = new Set(front.map((t) => t.name));
		// The map + the escape hatch are always on the front door.
		expect(names.has("sux")).toBe(true);
		expect(names.has("fn")).toBe(true);
		// A representative leaf is NOT advertised (reached via `fn` / by name instead).
		expect(names.has("hash")).toBe(false);
		expect(names.has("arxiv")).toBe(false);
		// Far smaller than the full registry, and every advertised tool is a real fn.
		expect(front.length).toBeLessThan(FUNCTIONS.length);
		expect(front.length).toBe(FRONT_VERBS.size);
		for (const t of front) expect(FUNCTIONS.some((f) => f.name === t.name)).toBe(true);
	});

	it("every FRONT_VERBS name is a registered fn (no dangling front verb)", () => {
		const names = new Set(FUNCTIONS.map((f) => f.name));
		for (const v of FRONT_VERBS) expect(names, `FRONT_VERBS references \`${v}\``).toContain(v);
	});

	it("unwrapFnCall resolves fn({name,args}) to the real leaf, and only for a valid inner name", () => {
		// Valid inner leaf → unwrapped, args passed through.
		expect(unwrapFnCall({ name: "fn", arguments: { name: "hash", args: { text: "x" } } }, FUNCTIONS)).toEqual({ name: "hash", args: { text: "x" } });
		// Missing inner args object → empty args.
		expect(unwrapFnCall({ name: "fn", arguments: { name: "hash" } }, FUNCTIONS)).toEqual({ name: "hash", args: {} });
		// Not an fn call at all → null (a direct call is untouched).
		expect(unwrapFnCall({ name: "hash", arguments: { text: "x" } }, FUNCTIONS)).toBeNull();
		// Unknown / self / blank inner name → null (falls through to fn's own run).
		expect(unwrapFnCall({ name: "fn", arguments: { name: "does_not_exist" } }, FUNCTIONS)).toBeNull();
		expect(unwrapFnCall({ name: "fn", arguments: { name: "fn" } }, FUNCTIONS)).toBeNull();
		expect(unwrapFnCall({ name: "fn", arguments: {} }, FUNCTIONS)).toBeNull();
		// Non-object arguments → null.
		expect(unwrapFnCall({ name: "fn", arguments: "nope" }, FUNCTIONS)).toBeNull();
		// A Unicode-obfuscated inner name resolves to the real leaf (same normalization
		// the dispatcher applies) — so it can't split resolution from the cost/cache path.
		expect(unwrapFnCall({ name: "fn", arguments: { name: "ｈａｓｈ", args: { text: "x" } } }, FUNCTIONS)).toEqual({ name: "hash", args: { text: "x" } });
		expect(unwrapFnCall({ name: "fn", arguments: { name: "ha​sh" } }, FUNCTIONS)).toEqual({ name: "hash", args: {} });
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
