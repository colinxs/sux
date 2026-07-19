import { describe, expect, it, vi } from "vitest";
import { appendInferSignal } from "./_infer";
import { detectCentroidDrift } from "./_infer_drift";

function fakeKv() {
	const store = new Map<string, string>();
	const get = vi.fn(async (k: string) => store.get(k) ?? null);
	const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
	return { get, put };
}

const baseEnv = (over: Record<string, string> = {}) => ({ OAUTH_KV: fakeKv(), ...over }) as any;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY_MS; // arbitrary fixed instant, far from epoch to keep windows positive

async function seed(env: any, domain: "mail" | "vault", ts: number, vec: number[]) {
	await appendInferSignal(env, domain, { ts, vec, redacted_snippet: "[redacted]", source_tag: `${domain}:x` });
}

describe("detectCentroidDrift — gating", () => {
	it("killed ⇒ null even with armed domains and plenty of evidence", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1", INFER_KILL: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [1, 0]);
		await seed(env, "mail", NOW - 40 * DAY_MS, [0, 1]);
		expect(await detectCentroidDrift(env, ["mail"], { now: NOW })).toBeNull();
	});

	it("no domain armed ⇒ null", async () => {
		const env = baseEnv();
		expect(await detectCentroidDrift(env, ["mail", "vault"], { now: NOW })).toBeNull();
	});

	it("missing recent or baseline evidence ⇒ null (not enough to compare)", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [1, 0]);
		expect(await detectCentroidDrift(env, ["mail"], { now: NOW })).toBeNull();
	});
});

describe("detectCentroidDrift — arithmetic", () => {
	it("no drift (recent centroid ≈ baseline centroid) ⇒ null", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [1, 0]);
		await seed(env, "mail", NOW - 2 * DAY_MS, [1, 0]);
		await seed(env, "mail", NOW - 40 * DAY_MS, [1, 0]);
		await seed(env, "mail", NOW - 50 * DAY_MS, [1, 0]);
		expect(await detectCentroidDrift(env, ["mail"], { now: NOW })).toBeNull();
	});

	it("orthogonal recent vs baseline centroids clears the default threshold", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [0, 1]);
		await seed(env, "mail", NOW - 2 * DAY_MS, [0, 1]);
		await seed(env, "mail", NOW - 40 * DAY_MS, [1, 0]);
		await seed(env, "mail", NOW - 50 * DAY_MS, [1, 0]);

		const candidate = await detectCentroidDrift(env, ["mail"], { now: NOW });

		expect(candidate).not.toBeNull();
		expect(candidate!.driftScore).toBeCloseTo(1, 5);
		expect(candidate!.cluster).toBe("mail");
		expect(candidate!.evidenceIds.length).toBe(2);
	});

	it("merges evidence across multiple armed domains (vault+mail first slice)", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1", INFER_ARM_VAULT: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [0, 1]);
		await seed(env, "vault", NOW - 1 * DAY_MS, [0, 1]);
		await seed(env, "mail", NOW - 40 * DAY_MS, [1, 0]);
		await seed(env, "vault", NOW - 40 * DAY_MS, [1, 0]);

		const candidate = await detectCentroidDrift(env, ["mail", "vault"], { now: NOW });

		expect(candidate).not.toBeNull();
		expect(candidate!.cluster).toBe("mail+vault");
		expect(candidate!.evidenceIds.length).toBe(2);
	});

	it("an unarmed domain in the requested list contributes zero evidence, not an error", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [0, 1]);
		await seed(env, "mail", NOW - 40 * DAY_MS, [1, 0]);
		// "vault" is requested but never armed here — should be silently excluded, mail alone still works.
		const candidate = await detectCentroidDrift(env, ["mail", "vault"], { now: NOW });
		expect(candidate).not.toBeNull();
		expect(candidate!.cluster).toBe("mail");
	});

	it("a custom threshold can suppress a drift that would otherwise clear the default", async () => {
		const env = baseEnv({ INFER_ARM_MAIL: "1" });
		await seed(env, "mail", NOW - 1 * DAY_MS, [0, 1]);
		await seed(env, "mail", NOW - 40 * DAY_MS, [1, 0]);
		expect(await detectCentroidDrift(env, ["mail"], { now: NOW, threshold: 1.5 })).toBeNull();
	});
});
