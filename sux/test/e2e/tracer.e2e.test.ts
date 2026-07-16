import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { type Harness, startHarness } from "./harness";

// TRACER BULLET (Tier 2, real durable run on local workerd) — the confirmation that the
// op-engine's tree→Workflow-primitive mapping (unit-proven with fake steps in cluster D)
// actually executes DURABLY on workerd, INCLUDING the human `ask` pause resumed by a
// real external event. Drives the stubbed `assimilate-pdfs-e2e` op (e2e-worker.ts) via
// the wrangler-dev harness: stage a zip → start a durable instance → send the ask event
// with `wrangler workflows instances send-event --local` → assert the instance completes
// with the abstract and that BOTH sinks wrote to R2.

const HOST = "http://127.0.0.1:18790";
const REPO_ROOT = join(__dirname, "..", "..", "..");
const E2E_CONFIG = join(__dirname, "wrangler.e2e.jsonc");
const execFileP = promisify(execFile);

async function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<any> {
	const r = await fetch(`${HOST}${path}`, { method: "POST", body, headers });
	return r.json();
}
async function get(path: string): Promise<any> {
	return (await fetch(`${HOST}${path}`)).json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stepCount = (s: any): number => s.__LOCAL_DEV_STEP_OUTPUTS?.length ?? 0;

async function pollStatus(id: string, done: (s: any) => boolean, tries = 60): Promise<any> {
	let last: any;
	for (let i = 0; i < tries; i++) {
		last = await get(`/e2e/status?id=${id}`);
		if (done(last)) return last;
		await sleep(500);
	}
	throw new Error(`instance ${id} never reached target state; last status = ${JSON.stringify(last)}`);
}

describe("MCP e2e: durable tracer bullet (assimilate-pdfs on real workerd)", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await startHarness({});
	}, 30_000);
	afterAll(async () => {
		await h.stop();
	});

	it("runs assimilate-pdfs durably, pauses at ask, resumes via send-event, writes both sinks", async () => {
		// Stage a 2-entry zip as the op's R2 input handle.
		const zip = zipSync({ "a.pdf": strToU8("PDF-A-CONTENT"), "b.pdf": strToU8("PDF-B-CONTENT") });
		const zipHandle = await post("/e2e/stage?type=application/zip", zip, { "content-type": "application/octet-stream" });
		expect(zipHandle.r2Key).toMatch(/^cas\//);

		// Start the durable run → { instanceId }.
		const started = await post("/e2e/run", JSON.stringify({ op: "assimilate-pdfs-e2e", input: zipHandle }), { "content-type": "application/json" });
		expect(started.instanceId).toBeTruthy();
		const id: string = started.instanceId;

		// The durable run executes its pre-`ask` steps — unzip + extract×2 (the fan-out)
		// + reconcile = 4 memoized steps — then SUSPENDS at the human `ask`. (Local dev
		// reports a suspended instance as "running", so gate on the durable step count,
		// not the status string.) That it is not yet "complete" proves it genuinely
		// paused for the human rather than running straight through.
		const paused = await pollStatus(id, (s) => stepCount(s) >= 4);
		expect(paused.status).not.toBe("complete");
		expect(paused.status).not.toBe("errored");
		expect(stepCount(paused)).toBeGreaterThanOrEqual(4);
		await sleep(750); // let the waitForEvent waiter register before delivering the event

		// Resume the pause with the real external event the `ask` waits on.
		await execFileP(
			"npx",
			["wrangler", "workflows", "instances", "send-event", "op-workflow", id, "--local", "--port", "18790", "--config", E2E_CONFIG, "--type", "ask:review master?", "--payload", "{}"],
			{ cwd: REPO_ROOT },
		);

		// After the event, it drives to completion with the abstract + summary handle.
		const done = await pollStatus(id, (s) => s.status === "complete" || s.status === "errored");
		expect(done.status).toBe("complete");
		expect(done.output.abstract).toMatch(/^e2e-abstract:/);
		expect(done.output.summaryHandle.sha256).toMatch(/^[0-9a-f]{64}$/);

		// Both sinks are real R2 writes: `published/<sha>` (r2) and `vault/<sha>` (vault).
		const sha = done.output.summaryHandle.sha256;
		expect((await get(`/e2e/r2head?key=published/${sha}`)).present).toBe(true);
		expect((await get(`/e2e/r2head?key=vault/${sha}`)).present).toBe(true);
	}, 60_000);
});
