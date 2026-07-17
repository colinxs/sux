import { describe, expect, it, vi } from "vitest";
import { type AskGateReminderDeps, composeReminder, type PendingGate, runAskGateReminder } from "./_ask_gate_reminder";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ ASK_GATE_REMINDER_ENABLED: "1", VAULT_TZ: "UTC", OAUTH_KV: kvStub(), ...extra }) as any;

const WAITING_RUN = { instanceId: "inst-1", opId: "mail-triage-plan", startedAt: Date.now() - 60 * 60_000, status: "waiting" };
const ASKS = [{ prompt: "apply these label changes?", timeout: "24h", onTimeout: "fail" }];

const deps = (over: Partial<AskGateReminderDeps> = {}): AskGateReminderDeps => ({
	listRuns: vi.fn(async () => [WAITING_RUN]),
	describeGates: vi.fn(() => ASKS),
	digestAppend: vi.fn(async () => {}),
	sendDigest: vi.fn(async () => {}),
	...over,
});

describe("ask-gate reminder — digest", () => {
	it("composes one bullet per pending gate with the exact answer/veto `run` calls", () => {
		const pending: PendingGate[] = [{ instanceId: "inst-1", opId: "mail-triage-plan", startedAt: 0, age_ms: 90 * 60_000, asks: ASKS }];
		const d = composeReminder(pending);
		expect(d.subject).toMatch(/1 approval waiting/);
		expect(d.body).toContain("mail-triage-plan");
		expect(d.body).toContain("inst-1");
		expect(d.body).toMatch(/run \{action:'answer', instanceId:'inst-1', prompt:'apply these label changes\?', payload:\{approved:true\}\}/);
		expect(d.body).toMatch(/payload:\{approved:false\}/);
	});
});

describe("ask-gate reminder — sweep", () => {
	it("is dormant (no-op) unless ASK_GATE_REMINDER_ENABLED", async () => {
		const r = await runAskGateReminder({ VAULT_TZ: "UTC", OAUTH_KV: kvStub() } as any, deps());
		expect(r.dormant).toBe(true);
	});

	it("armed: finds a waiting+old-enough instance, writes the vault digest, does NOT email (ASK_GATE_REMINDER_EMAIL unset)", async () => {
		const e = env();
		const d = deps();
		const r = await runAskGateReminder(e, d);
		expect(r.pending).toBe(1);
		expect(r.reminded).toBe(1);
		expect(r.digest_written).toBe(true);
		expect(r.emailed).toBe(false);
		expect(d.sendDigest).not.toHaveBeenCalled();
		expect(d.digestAppend).toHaveBeenCalledTimes(1);
		const [, path, content] = (d.digestAppend as any).mock.calls[0];
		expect(path).toMatch(/^Daily\//);
		expect(content).toContain("mail-triage-plan");
	});

	it("emails the digest to self only when ASK_GATE_REMINDER_EMAIL is armed", async () => {
		const e = env({ ASK_GATE_REMINDER_EMAIL: "1" });
		const d = deps();
		const r = await runAskGateReminder(e, d);
		expect(r.emailed).toBe(true);
		expect(d.sendDigest).toHaveBeenCalledTimes(1);
	});

	it("ignores a waiting instance that hasn't aged past ASK_GATE_REMINDER_AFTER_MINUTES yet", async () => {
		const e = env();
		const fresh = { ...WAITING_RUN, startedAt: Date.now() - 60_000 }; // 1 minute old, default threshold is 30min
		const r = await runAskGateReminder(e, deps({ listRuns: vi.fn(async () => [fresh]) }));
		expect(r.pending).toBe(0);
		expect(r.reminded).toBe(0);
	});

	it("ignores a run that isn't currently 'waiting' (running/complete/errored)", async () => {
		const e = env();
		const r = await runAskGateReminder(e, deps({ listRuns: vi.fn(async () => [{ ...WAITING_RUN, status: "running" }]) }));
		expect(r.pending).toBe(0);
		expect(r.reminded).toBe(0);
		expect(r.digest_written).toBeUndefined();
	});

	it("is cooldown-gated per instance — a second sweep within the cooldown window re-reminds nothing", async () => {
		const e = env();
		await runAskGateReminder(e, deps());
		const second = await runAskGateReminder(e, deps());
		expect(second.pending).toBe(1); // still pending...
		expect(second.reminded).toBe(0); // ...but already reminded within the cooldown
	});

	it("a vault-append failure surfaces as `error`, not a thrown exception", async () => {
		const e = env();
		const r = await runAskGateReminder(
			e,
			deps({
				digestAppend: vi.fn(async () => {
					throw new Error("git 503");
				}),
			}),
		);
		expect(r.error).toMatch(/vault append failed/);
	});

	it("an email failure never fails the sweep — the vault digest already landed", async () => {
		const e = env({ ASK_GATE_REMINDER_EMAIL: "1" });
		const r = await runAskGateReminder(
			e,
			deps({
				sendDigest: vi.fn(async () => {
					throw new Error("mail down");
				}),
			}),
		);
		expect(r.digest_written).toBe(true);
		expect(r.emailed).toBe(false);
	});

	it("a listRuns failure surfaces as `error`, never throws", async () => {
		const e = env();
		const r = await runAskGateReminder(
			e,
			deps({
				listRuns: vi.fn(async () => {
					throw new Error("KV down");
				}),
			}),
		);
		expect(r.error).toMatch(/run list failed/);
	});
});
