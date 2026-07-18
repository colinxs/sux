import { describe, expect, it, vi } from "vitest";
import {
	appendInferInference,
	appendInferSignal,
	deleteInferInference,
	deleteInferSignal,
	inferSignalId,
	purgeInferDomain,
	readInferInferences,
	readInferSignals,
	type InferSignal,
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

const SIGNAL_A: InferSignal = { ts: 1, vec: [0.1, 0.2], redacted_snippet: "[a]", source_tag: "mail:a" };
const SIGNAL_B: InferSignal = { ts: 2, vec: [0.3, 0.4], redacted_snippet: "[b]", source_tag: "mail:b" };

describe("inference log — gated append, ungated read", () => {
	it("dormant domain appends nothing", async () => {
		const { env } = baseEnv();
		const result = await appendInferInference(env, "mail", { id: "i1", createdAt: 1, cluster: "x", evidenceIds: [] });
		expect(result).toEqual({ appended: false, reason: "dormant" });
		expect(await readInferInferences(env, "mail")).toEqual([]);
	});

	it("killed domain appends nothing even if armed", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_KILL: "1" });
		const result = await appendInferInference(env, "mail", { id: "i1", createdAt: 1, cluster: "x", evidenceIds: [] });
		expect(result).toEqual({ appended: false, reason: "killed" });
	});

	it("armed domain appends and reads back", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferInference(env, "mail", { id: "i1", createdAt: 1, cluster: "x", evidenceIds: [inferSignalId(SIGNAL_A)] });
		expect(await readInferInferences(env, "mail")).toEqual([{ id: "i1", createdAt: 1, cluster: "x", evidenceIds: [inferSignalId(SIGNAL_A)] }]);
	});
});

describe("deleteInferSignal — cascading erasure", () => {
	it("deletes the targeted signal and cascades to any inference citing it", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferSignal(env, "mail", SIGNAL_A);
		await appendInferSignal(env, "mail", SIGNAL_B);
		await appendInferInference(env, "mail", { id: "i1", createdAt: 5, cluster: "topic", evidenceIds: [inferSignalId(SIGNAL_A)] });
		await appendInferInference(env, "mail", { id: "i2", createdAt: 6, cluster: "other", evidenceIds: [inferSignalId(SIGNAL_B)] });

		const result = await deleteInferSignal(env, "mail", inferSignalId(SIGNAL_A));
		expect(result).toEqual({ deletedSignals: 1, cascadedInferences: 1 });

		const signals = await readInferSignals(env, "mail");
		expect(signals).toEqual([SIGNAL_B]);

		const inferences = await readInferInferences(env, "mail");
		expect(inferences.map((i) => i.id)).toEqual(["i2"]);
	});

	it("deletion works even for a domain that is now dormant (not gated behind arm/kill)", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferSignal(env, "mail", SIGNAL_A);
		await appendInferInference(env, "mail", { id: "i1", createdAt: 5, cluster: "topic", evidenceIds: [inferSignalId(SIGNAL_A)] });

		// Domain gets disarmed after the data was written — erasure must still work.
		delete env.INFER_ARM_MAIL;
		const result = await deleteInferSignal(env, "mail", inferSignalId(SIGNAL_A));
		expect(result).toEqual({ deletedSignals: 1, cascadedInferences: 1 });
	});

	it("deleting a non-cited signal leaves other inferences untouched", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferSignal(env, "mail", SIGNAL_A);
		await appendInferSignal(env, "mail", SIGNAL_B);
		await appendInferInference(env, "mail", { id: "i1", createdAt: 5, cluster: "topic", evidenceIds: [inferSignalId(SIGNAL_B)] });

		const result = await deleteInferSignal(env, "mail", inferSignalId(SIGNAL_A));
		expect(result).toEqual({ deletedSignals: 1, cascadedInferences: 0 });
		expect((await readInferInferences(env, "mail")).map((i) => i.id)).toEqual(["i1"]);
	});

	it("deleting an id that doesn't exist is a no-op", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferSignal(env, "mail", SIGNAL_A);
		const result = await deleteInferSignal(env, "mail", "mail:nope@999");
		expect(result).toEqual({ deletedSignals: 0, cascadedInferences: 0 });
		expect(await readInferSignals(env, "mail")).toEqual([SIGNAL_A]);
	});
});

describe("deleteInferInference", () => {
	it("removes only the targeted inference, leaves signals untouched", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1" });
		await appendInferSignal(env, "mail", SIGNAL_A);
		await appendInferInference(env, "mail", { id: "i1", createdAt: 5, cluster: "topic", evidenceIds: [inferSignalId(SIGNAL_A)] });
		await appendInferInference(env, "mail", { id: "i2", createdAt: 6, cluster: "other", evidenceIds: [] });

		const result = await deleteInferInference(env, "mail", "i1");
		expect(result).toEqual({ deleted: 1 });
		expect((await readInferInferences(env, "mail")).map((i) => i.id)).toEqual(["i2"]);
		expect(await readInferSignals(env, "mail")).toEqual([SIGNAL_A]);
	});
});

describe("purgeInferDomain", () => {
	it("clears both the signal log and the inference log for the domain", async () => {
		const { env } = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_FILES: "1" });
		await appendInferSignal(env, "mail", SIGNAL_A);
		await appendInferInference(env, "mail", { id: "i1", createdAt: 5, cluster: "topic", evidenceIds: [] });
		await appendInferSignal(env, "files", SIGNAL_B);

		await purgeInferDomain(env, "mail");
		expect(await readInferSignals(env, "mail")).toEqual([]);
		expect(await readInferInferences(env, "mail")).toEqual([]);
		// Purging one domain doesn't touch another domain's log.
		expect(await readInferSignals(env, "files")).toEqual([SIGNAL_B]);
	});
});
