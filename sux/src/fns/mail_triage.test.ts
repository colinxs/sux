import { afterEach, describe, expect, it, vi } from "vitest";

// The leaf's run() only orchestrates: gate → dispatch to the (heavily tested) core +
// log helpers. Mock both seams so we exercise the dispatch itself — dormant no-op,
// undo guard, log read, the run happy path, and the catch → upstream_error.
const core = vi.hoisted(() => ({ hasMailTriage: vi.fn(), defaultDeps: vi.fn(), runTriage: vi.fn() }));
vi.mock("./_mail_triage", () => core);
const log = vi.hoisted(() => ({ readTriageEntries: vi.fn(), bulkUndo: vi.fn() }));
vi.mock("./_mail_triage_log", () => log);

import type { RtEnv } from "../registry";
import { mail_triage } from "./mail_triage";

const env = {} as RtEnv;
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

afterEach(() => vi.clearAllMocks());

describe("mail_triage.run", () => {
	it("is a dormant no-op when the master flag is unset", async () => {
		core.hasMailTriage.mockReturnValue(false);
		const r = await mail_triage.run(env, { action: "run" });
		expect(r.isError).toBeFalsy();
		expect(body(r).dormant).toBe(true);
		expect(core.runTriage).not.toHaveBeenCalled();
		expect(core.defaultDeps).not.toHaveBeenCalled();
	});

	it("rejects undo without a cycle_id (bad_input)", async () => {
		core.hasMailTriage.mockReturnValue(true);
		const r = await mail_triage.run(env, { action: "undo" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
		expect(log.bulkUndo).not.toHaveBeenCalled();
	});

	it("undoes a cycle by its cycle_id", async () => {
		core.hasMailTriage.mockReturnValue(true);
		log.bulkUndo.mockResolvedValueOnce({ cycle: "c1", reverted: 3 });
		const r = await mail_triage.run(env, { action: "undo", cycle_id: "c1" });
		expect(log.bulkUndo).toHaveBeenCalledWith(env, "c1");
		expect(body(r)).toEqual({ cycle: "c1", reverted: 3 });
	});

	it("reads the action log, wrapping entries with a count", async () => {
		core.hasMailTriage.mockReturnValue(true);
		const entries = [{ id: "a" }, { id: "b" }];
		log.readTriageEntries.mockResolvedValueOnce(entries);
		const r = await mail_triage.run(env, { action: "log", cycle_id: "c9", limit: 5 });
		expect(log.readTriageEntries).toHaveBeenCalledWith(env, { cycle: "c9", limit: 5 });
		expect(body(r)).toEqual({ count: 2, entries });
	});

	it("runs a cycle (default action) through defaultDeps + runTriage", async () => {
		core.hasMailTriage.mockReturnValue(true);
		const deps = { marker: true };
		core.defaultDeps.mockResolvedValueOnce(deps);
		const report = { cycle: "c2", did: [], suggests: [] };
		core.runTriage.mockResolvedValueOnce(report);
		const r = await mail_triage.run(env, { mailbox: "inbox", max: 10, dry_run: true, unread: false });
		expect(core.defaultDeps).toHaveBeenCalledTimes(1);
		expect(core.runTriage).toHaveBeenCalledWith(env, { mailbox: "inbox", max: 10, dry_run: true, cycle_id: undefined, budget_ms: undefined, unread: false }, deps);
		expect(body(r)).toEqual(report);
	});

	it("maps a thrown error to upstream_error", async () => {
		core.hasMailTriage.mockReturnValue(true);
		core.defaultDeps.mockResolvedValueOnce({});
		core.runTriage.mockRejectedValueOnce(new Error("jmap exploded"));
		const r = await mail_triage.run(env, {});
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(r.content[0].text).toContain("jmap exploded");
	});
});
