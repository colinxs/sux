import { describe, expect, it, vi } from "vitest";
import {
	appendInferInference,
	appendInferSignal,
	deleteInferInference,
	deleteInferSignal,
	hasInferArm,
	type InferSignal,
	isInferKilled,
	purgeInferDomain,
	readInferInferences,
	readInferSignals,
} from "./_infer";

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

const SIGNAL: Omit<InferSignal, "id"> = { ts: 1, vec: [0.1, 0.2], redacted_snippet: "[redacted]", source_tag: "mail:abc" };

describe("infer gate predicates", () => {
	it("defaults are all off — every domain unarmed", () => {
		const env = {} as any;
		expect(hasInferArm(env, "mail")).toBe(false);
		expect(hasInferArm(env, "purchases")).toBe(false);
		expect(hasInferArm(env, "calendar")).toBe(false);
		expect(hasInferArm(env, "files")).toBe(false);
		expect(hasInferArm(env, "health")).toBe(false);
		expect(hasInferArm(env, "vault")).toBe(false);
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
		expect(result.appended).toBe(true);
		expect(result.reason).toBe("ok");
		expect(typeof result.id).toBe("string");
		expect(await readInferSignals(env, "mail")).toEqual([{ ...SIGNAL, id: result.id }]);
	});

	it("arming one domain does not make another domain's append succeed", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const result = await appendInferSignal(env, "purchases", SIGNAL);
		expect(result).toEqual({ appended: false, reason: "dormant" });
		expect(await readInferSignals(env, "purchases")).toEqual([]);
	});
});

describe("inference log — same fail-closed gate as signals", () => {
	const INFERENCE = { domain: "mail" as const, kind: "drift", evidenceIds: ["s1"], createdAt: 1, payload: { cluster: "x" } };

	it("unset flag ⇒ append is a no-op", async () => {
		const { env } = baseEnv();
		const result = await appendInferInference(env, "mail", INFERENCE);
		expect(result).toEqual({ appended: false, reason: "dormant" });
		expect(await readInferInferences(env, "mail")).toEqual([]);
	});

	it("armed domain appends and reads back the inference", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const result = await appendInferInference(env, "mail", INFERENCE);
		expect(result.appended).toBe(true);
		expect(typeof result.id).toBe("string");
		expect(await readInferInferences(env, "mail")).toEqual([{ ...INFERENCE, id: result.id }]);
	});
});

describe("deleteInferSignal — cascading erasure (§3 guardrail 3)", () => {
	it("deletes the signal even when the domain is unarmed or killed — erasure is never gated", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const { id } = await appendInferSignal(env, "mail", SIGNAL);
		const disarmed = { ...env, INFER_ARM_MAIL: undefined, INFER_KILL: "1" } as any;
		const result = await deleteInferSignal(disarmed, "mail", id as string);
		expect(result.deletedSignal).toBe(true);
		expect(await readInferSignals(disarmed, "mail")).toEqual([]);
	});

	it("deleting a signal cascades: an inference derived solely from it is also removed", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const { id: signalId } = await appendInferSignal(env, "mail", SIGNAL);
		const { id: inferenceId } = await appendInferInference(env, "mail", {
			domain: "mail",
			kind: "drift",
			evidenceIds: [signalId as string],
			createdAt: 1,
			payload: {},
		});

		const result = await deleteInferSignal(env, "mail", signalId as string);

		expect(result.deletedSignal).toBe(true);
		expect(result.cascadedInferenceIds).toEqual([inferenceId]);
		expect(await readInferInferences(env, "mail")).toEqual([]);
	});

	it("an inference citing OTHER surviving evidence too is trimmed, not deleted", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const { id: id1 } = await appendInferSignal(env, "mail", SIGNAL);
		const { id: id2 } = await appendInferSignal(env, "mail", { ...SIGNAL, ts: 2 });
		const { id: inferenceId } = await appendInferInference(env, "mail", {
			domain: "mail",
			kind: "drift",
			evidenceIds: [id1 as string, id2 as string],
			createdAt: 1,
			payload: {},
		});

		const result = await deleteInferSignal(env, "mail", id1 as string);

		expect(result.cascadedInferenceIds).toEqual([]);
		const remaining = await readInferInferences(env, "mail");
		expect(remaining).toEqual([{ domain: "mail", kind: "drift", evidenceIds: [id2], createdAt: 1, payload: {}, id: inferenceId }]);
	});

	it("deleting an id that doesn't exist is a harmless no-op", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const result = await deleteInferSignal(env, "mail", "nonexistent");
		expect(result).toEqual({ deletedSignal: false, cascadedInferenceIds: [] });
	});

	it("cascades into a merged-evidence inference logged under a DIFFERENT domain than the deleted signal (#950)", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1" });
		const { id: mailSignalId } = await appendInferSignal(env, "mail", SIGNAL);
		// Centroid drift over vault+mail logs its merged-evidence inference under "vault"
		// (domains[0]) even though evidenceIds includes a mail-domain signal id.
		const { id: inferenceId } = await appendInferInference(env, "vault", {
			domain: "vault",
			kind: "centroid_drift",
			evidenceIds: [mailSignalId as string],
			createdAt: 1,
			payload: {},
		});

		const result = await deleteInferSignal(env, "mail", mailSignalId as string);

		expect(result.deletedSignal).toBe(true);
		expect(result.cascadedInferenceIds).toEqual([inferenceId]);
		expect(await readInferInferences(env, "vault")).toEqual([]);
	});

	it("trims (not deletes) a cross-domain inference that still cites other surviving evidence", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1" });
		const { id: mailSignalId } = await appendInferSignal(env, "mail", SIGNAL);
		const { id: vaultSignalId } = await appendInferSignal(env, "vault", SIGNAL);
		const { id: inferenceId } = await appendInferInference(env, "vault", {
			domain: "vault",
			kind: "centroid_drift",
			evidenceIds: [mailSignalId as string, vaultSignalId as string],
			createdAt: 1,
			payload: {},
		});

		const result = await deleteInferSignal(env, "mail", mailSignalId as string);

		expect(result.cascadedInferenceIds).toEqual([]);
		const remaining = await readInferInferences(env, "vault");
		expect(remaining).toEqual([
			{ domain: "vault", kind: "centroid_drift", evidenceIds: [vaultSignalId], createdAt: 1, payload: {}, id: inferenceId },
		]);
	});
});

describe("deleteInferInference — direct deletion", () => {
	it("deletes a single inference without touching its evidence signals", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const { id: signalId } = await appendInferSignal(env, "mail", SIGNAL);
		const { id: inferenceId } = await appendInferInference(env, "mail", {
			domain: "mail",
			kind: "drift",
			evidenceIds: [signalId as string],
			createdAt: 1,
			payload: {},
		});

		expect(await deleteInferInference(env, "mail", inferenceId as string)).toBe(true);
		expect(await readInferInferences(env, "mail")).toEqual([]);
		expect((await readInferSignals(env, "mail")).length).toBe(1);
	});

	it("returns false for an id that doesn't exist", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		expect(await deleteInferInference(env, "mail", "nonexistent")).toBe(false);
	});
});

describe("purgeInferDomain — whole-domain erasure", () => {
	it("wipes both the signal log and the inference log for one domain, unconditionally", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		const { id: signalId } = await appendInferSignal(env, "mail", SIGNAL);
		await appendInferInference(env, "mail", { domain: "mail", kind: "drift", evidenceIds: [signalId as string], createdAt: 1, payload: {} });

		await purgeInferDomain(env, "mail");

		expect(await readInferSignals(env, "mail")).toEqual([]);
		expect(await readInferInferences(env, "mail")).toEqual([]);
	});

	it("purging one domain does not touch another domain's logs", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_PURCHASES: "1" });
		await appendInferSignal(env, "mail", SIGNAL);
		await appendInferSignal(env, "purchases", SIGNAL);

		await purgeInferDomain(env, "mail");

		expect(await readInferSignals(env, "mail")).toEqual([]);
		expect((await readInferSignals(env, "purchases")).length).toBe(1);
	});

	it("cascades into a merged-evidence inference logged under a DIFFERENT domain than the purged signals (#953)", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1" });
		const { id: mailSignalId } = await appendInferSignal(env, "mail", SIGNAL);
		// Centroid drift over vault+mail logs its merged-evidence inference under "vault"
		// (domains[0]) even though evidenceIds includes a mail-domain signal id.
		await appendInferInference(env, "vault", {
			domain: "vault",
			kind: "centroid_drift",
			evidenceIds: [mailSignalId as string],
			createdAt: 1,
			payload: {},
		});

		await purgeInferDomain(env, "mail");

		expect(await readInferSignals(env, "mail")).toEqual([]);
		expect(await readInferInferences(env, "vault")).toEqual([]);
	});

	it("trims (not deletes) a cross-domain inference that still cites other surviving evidence after a purge", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1" });
		const { id: mailSignalId } = await appendInferSignal(env, "mail", SIGNAL);
		const { id: vaultSignalId } = await appendInferSignal(env, "vault", SIGNAL);
		const { id: inferenceId } = await appendInferInference(env, "vault", {
			domain: "vault",
			kind: "centroid_drift",
			evidenceIds: [mailSignalId as string, vaultSignalId as string],
			createdAt: 1,
			payload: {},
		});

		await purgeInferDomain(env, "mail");

		const remaining = await readInferInferences(env, "vault");
		expect(remaining).toEqual([
			{ domain: "vault", kind: "centroid_drift", evidenceIds: [vaultSignalId], createdAt: 1, payload: {}, id: inferenceId },
		]);
	});

	it("purging a domain with no signals is a harmless no-op for other domains' inferences", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1" });
		const { id: vaultSignalId } = await appendInferSignal(env, "vault", SIGNAL);
		const { id: inferenceId } = await appendInferInference(env, "vault", {
			domain: "vault",
			kind: "drift",
			evidenceIds: [vaultSignalId as string],
			createdAt: 1,
			payload: {},
		});

		await purgeInferDomain(env, "mail");

		expect(await readInferInferences(env, "vault")).toEqual([{ domain: "vault", kind: "drift", evidenceIds: [vaultSignalId], createdAt: 1, payload: {}, id: inferenceId }]);
	});
});
