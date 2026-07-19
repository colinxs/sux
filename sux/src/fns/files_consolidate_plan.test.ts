import { beforeEach, describe, expect, it, vi } from "vitest";
import { files_consolidate_plan } from "./files_consolidate_plan";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

vi.mock("./_files_binary_dup", () => ({ collectBinaryCandidates: vi.fn(async () => ({ files: [], truncated: false })), findBinaryDuplicateFiles: vi.fn(() => []) }));

const WRITE_ARMED = { DROPBOX_FULL_TOKEN: "tok", DROPBOX_FULL_WRITE_ENABLED: "1" };

describe("files_consolidate_plan", () => {
	beforeEach(() => {
		runVerb.mockReset();
	});

	it("is disabled unless FILES_CONSOLIDATE_ENABLED is set", async () => {
		const res = await files_consolidate_plan.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("FILES_CONSOLIDATE_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("also needs DROPBOX_FULL_WRITE_ENABLED armed even when FILES_CONSOLIDATE_ENABLED is set", async () => {
		const res = await files_consolidate_plan.run({ FILES_CONSOLIDATE_ENABLED: "1" } as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("DROPBOX_FULL_WRITE_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("clusters files_semantic's existing embeddings and starts a durable run", async () => {
		const chunks = [
			{ path: "/a.txt", text: "x", embedding: [1, 0, 0] },
			{ path: "/b.txt", text: "x", embedding: [0.999, 0.001, 0] },
			{ path: "/c.txt", text: "x", embedding: [0, 1, 0] },
		];
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => ({ cursor: "c1", version: 1, at: 0, total: 3, truncated: false, chunks }) }));
		vi.resetModules();
		const { files_consolidate_plan: freshFn } = await import("./files_consolidate_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await freshFn.run({ FILES_CONSOLIDATE_ENABLED: "1", ...WRITE_ARMED } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("files-consolidate-plan");
		expect(call.mode).toBe("durable");
		expect(call.input).toHaveLength(1);
		expect(new Set(call.input[0].paths)).toEqual(new Set(["/a.txt", "/b.txt"]));
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 3, candidates: 1, instanceId: "abc123" });
	});

	it("merges binary content_hash clusters alongside text-embedding clusters", async () => {
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => ({ cursor: "c1", version: 1, at: 0, total: 0, truncated: false, chunks: [] }) }));
		vi.doMock("./_files_binary_dup", () => ({
			collectBinaryCandidates: vi.fn(async () => ({ files: [{ path: "/a.png", content_hash: "h1" }, { path: "/b.png", content_hash: "h1" }], truncated: false })),
			findBinaryDuplicateFiles: vi.fn(() => [{ paths: ["/a.png", "/b.png"] }]),
		}));
		vi.resetModules();
		const { files_consolidate_plan: freshFn } = await import("./files_consolidate_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "bin1" });

		const res = await freshFn.run({ FILES_CONSOLIDATE_ENABLED: "1", ...WRITE_ARMED } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.input).toEqual([{ paths: ["/a.png", "/b.png"] }]);
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scannedBinary: 2, candidates: 1, instanceId: "bin1" });
	});

	it("skips starting a run when there are no duplicate candidates", async () => {
		const chunks = [
			{ path: "/a.txt", text: "x", embedding: [1, 0, 0] },
			{ path: "/b.txt", text: "x", embedding: [0, 1, 0] },
		];
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => ({ cursor: "c1", version: 1, at: 0, total: 2, truncated: false, chunks }) }));
		vi.doMock("./_files_binary_dup", () => ({ collectBinaryCandidates: vi.fn(async () => ({ files: [], truncated: false })), findBinaryDuplicateFiles: vi.fn(() => []) }));
		vi.resetModules();
		const { files_consolidate_plan: freshFn } = await import("./files_consolidate_plan");

		const res = await freshFn.run({ FILES_CONSOLIDATE_ENABLED: "1", ...WRITE_ARMED } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ scanned: 2, scannedBinary: 0, candidates: 0, note: "no duplicate candidates found — nothing to archive" });
	});

	it("reports not_configured when files_semantic has no index (Dropbox Mode B not configured)", async () => {
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => null }));
		vi.doMock("./_files_binary_dup", () => ({ collectBinaryCandidates: vi.fn(async () => ({ files: [], truncated: false })), findBinaryDuplicateFiles: vi.fn(() => []) }));
		vi.resetModules();
		const { files_consolidate_plan: freshFn } = await import("./files_consolidate_plan");

		const res = await freshFn.run({ FILES_CONSOLIDATE_ENABLED: "1", ...WRITE_ARMED } as any, {});

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("Dropbox Mode B");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("surfaces a files_semantic failure as an upstream_error", async () => {
		vi.doMock("./_files_semantic", () => ({
			filesSemanticIndex: async () => {
				throw new Error("Dropbox down");
			},
		}));
		vi.resetModules();
		const { files_consolidate_plan: freshFn } = await import("./files_consolidate_plan");

		const res = await freshFn.run({ FILES_CONSOLIDATE_ENABLED: "1", ...WRITE_ARMED } as any, {});

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("Dropbox down");
	});
});
