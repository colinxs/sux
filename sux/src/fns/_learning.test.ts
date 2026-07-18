import { describe, expect, it, vi } from "vitest";
import { getKindWeight, listKindWeights, recordOutcome } from "./_learning";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = () => ({ OAUTH_KV: kvStub() }) as any;

describe("_learning — W8 approval learning signal", () => {
	it("a kind with no history is neutral (weight 1)", async () => {
		expect(await getKindWeight(env(), "bill_due")).toBe(1);
	});

	it("approvals nudge weight up, rejections nudge it down, both clamped", async () => {
		const e = env();
		for (let i = 0; i < 3; i++) await recordOutcome(e, "rx_ready", "approved");
		expect(await getKindWeight(e, "rx_ready")).toBeGreaterThan(1);

		const e2 = env();
		for (let i = 0; i < 20; i++) await recordOutcome(e2, "unanswered", "rejected");
		const w = await getKindWeight(e2, "unanswered");
		expect(w).toBeLessThan(1);
		expect(w).toBeGreaterThanOrEqual(0.25); // clamped, never zeroed out — never suppressed
	});

	it("listKindWeights reports per-kind stats + weight, deduped", async () => {
		const e = env();
		await recordOutcome(e, "bill_due", "approved");
		await recordOutcome(e, "bill_due", "rejected");
		const rows = await listKindWeights(e, ["bill_due", "bill_due", "rx_ready"]);
		expect(rows).toHaveLength(2);
		const bill = rows.find((r) => r.kind === "bill_due");
		expect(bill).toMatchObject({ approved: 1, rejected: 1 });
	});

	it("a missing OAUTH_KV never throws — degrades to neutral", async () => {
		await expect(recordOutcome({} as any, "bill_due", "approved")).resolves.toBeUndefined();
		expect(await getKindWeight({} as any, "bill_due")).toBe(1);
	});
});
