import { describe, expect, it, vi } from "vitest";
import { appendInferSignal, hasInferArm, type InferSignal, isInferKilled, readInferSignals } from "./_infer";

function fakeKv() {
	const store = new Map<string, string>();
	const get = vi.fn(async (k: string) => store.get(k) ?? null);
	const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
	return { store, kv: { get, put } };
}

const baseEnv = (over: Record<string, string> = {}) => {
	const { store, kv } = fakeKv();
	return { env: { OAUTH_KV: kv, ...over } as any, store };
};

const SIGNAL: InferSignal = { ts: 1, vec: [0.1, 0.2], redacted_snippet: "[redacted]", source_tag: "mail:abc" };

describe("infer gate predicates", () => {
	it("defaults are all off — every domain unarmed", () => {
		const env = {} as any;
		expect(hasInferArm(env, "mail")).toBe(false);
		expect(hasInferArm(env, "purchases")).toBe(false);
		expect(hasInferArm(env, "calendar")).toBe(false);
		expect(hasInferArm(env, "files")).toBe(false);
		expect(hasInferArm(env, "health")).toBe(false);
	});

	it("falsey toggle strings never arm a domain (the bare-truthiness bug)", () => {
		for (const v of ["false", "0", "off", "no", "", " "]) {
			expect(hasInferArm({ INFER_ARM_MAIL: v } as any, "mail")).toBe(false);
		}
	});

	it("arming one domain does not arm another", () => {
		const env = { INFER_ARM_MAIL: "1" } as any;
		expect(hasInferArm(env, "mail")).toBe(true);
		expect(hasInferArm(env, "purchases")).toBe(false);
		expect(hasInferArm(env, "health")).toBe(false);
	});

	it("a truthy kill halts every domain even if individually armed", () => {
		const env = {
			INFER_KILL: "1",
			INFER_ARM_MAIL: "1",
			INFER_ARM_PURCHASES: "1",
			INFER_ARM_CALENDAR: "1",
			INFER_ARM_FILES: "1",
			INFER_ARM_HEALTH: "1",
		} as any;
		expect(isInferKilled(env)).toBe(true);
		for (const d of ["mail", "purchases", "calendar", "files", "health"] as const) {
			expect(hasInferArm(env, d)).toBe(false);
		}
	});

	it("a falsey kill does not spuriously halt an armed domain", () => {
		expect(hasInferArm({ INFER_ARM_MAIL: "1", INFER_KILL: "false" } as any, "mail")).toBe(true);
	});
});

describe("appendInferSignal — fail-closed by construction", () => {
	it("unset flag ⇒ append is a no-op, nothing written to KV", async () => {
		const { env, store } = baseEnv();
		const result = await appendInferSignal(env, "mail", SIGNAL);
		expect(result).toEqual({ appended: false, reason: "dormant" });
		expect(store.size).toBe(0);
		expect(await readInferSignals(env, "mail")).toEqual([]);
	});

	it("killed ⇒ append is a no-op even when the domain is armed", async () => {
		const { env, store } = baseEnv({ INFER_ARM_MAIL: "1", INFER_KILL: "1" });
		const result = await appendInferSignal(env, "mail", SIGNAL);
		expect(result).toEqual({ appended: false, reason: "killed" });
		expect(store.size).toBe(0);
	});

	it("armed domain appends and reads back the signal", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const result = await appendInferSignal(env, "mail", SIGNAL);
		expect(result).toEqual({ appended: true, reason: "ok" });
		expect(await readInferSignals(env, "mail")).toEqual([SIGNAL]);
	});

	it("arming one domain does not make another domain's append succeed", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const result = await appendInferSignal(env, "purchases", SIGNAL);
		expect(result).toEqual({ appended: false, reason: "dormant" });
		expect(await readInferSignals(env, "purchases")).toEqual([]);
	});
});
