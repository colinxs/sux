import { describe, expect, it } from "vitest";
import { describeSensitivity, isOverDeadline, newRequestContext, observeSensitivity, remainingMs } from "./request-context";
import { MAX_SENSITIVITY, PUBLIC, sameSensitivity, sensitivity, tagsOf } from "./sensitivity";

const ctxStub = () => ({ waitUntil: () => {} });
const mk = (over: Partial<Parameters<typeof newRequestContext>[1]> = {}) => newRequestContext(ctxStub(), { reqId: "r1", deadlineMs: 60_000, now: 1_000, ...over });

describe("per-request context — the isolate is SHARED, so this must not be (#1456)", () => {
	// THE test for this unit. A single-request test passes trivially and proves nothing about
	// the actual hazard: two tools/call requests run concurrently in one isolate, and anything
	// parked on the shared env gets clobbered — intermittently, which is the worst way to find
	// out. Everything else here is a property check; this one is the reason the unit exists.
	it("two OVERLAPPING requests never observe each other's context", async () => {
		const base = { KV: "shared-binding" };
		// The real shape: a shallow per-request clone where bindings share the one env by
		// reference and only the context is per-request (index.ts's `{...env, _egress: …}`).
		const envA = { ...base, _egress: newRequestContext(ctxStub(), { reqId: "A", login: "alice", deadlineMs: 60_000, now: 0 }) };
		const envB = { ...base, _egress: newRequestContext(ctxStub(), { reqId: "B", login: "bob", deadlineMs: 60_000, now: 0 }) };

		const yieldTick = () => new Promise((r) => setTimeout(r, 0));
		const requestA = async () => {
			observeSensitivity(envA._egress, ["phi"], "mychart:uwmedicine");
			await yieldTick();
			observeSensitivity(envA._egress, ["financial"], "monarch");
			await yieldTick();
			return { tags: tagsOf(envA._egress.sensitivity), reqId: envA._egress.reqId, login: envA._egress.login, prov: [...envA._egress.provenance] };
		};
		const requestB = async () => {
			await yieldTick();
			observeSensitivity(envB._egress, ["legal"], "vault:legal/");
			await yieldTick();
			return { tags: tagsOf(envB._egress.sensitivity), reqId: envB._egress.reqId, login: envB._egress.login, prov: [...envB._egress.provenance] };
		};

		const [a, b] = await Promise.all([requestA(), requestB()]);
		expect(a).toEqual({ tags: ["phi", "financial"], reqId: "A", login: "alice", prov: ["mychart:uwmedicine", "monarch"] });
		expect(b).toEqual({ tags: ["legal"], reqId: "B", login: "bob", prov: ["vault:legal/"] });
		// Neither leaked into the other, in either direction.
		expect(a.tags).not.toContain("legal");
		expect(b.tags).not.toContain("phi");
		// And the shared binding really was shared — otherwise this test would pass by cloning
		// everything, which is not the mechanism under test.
		expect(envA.KV).toBe(envB.KV);
		expect(envA.KV).toBe("shared-binding");
	});

	it("a fresh context is PUBLIC, not MAX — seeding it maximal would make every request maximally sensitive forever, since join can only widen", () => {
		expect(sameSensitivity(mk().sensitivity, PUBLIC)).toBe(true);
	});

	it("observeSensitivity JOINS — a later read can never narrow what an earlier read established", () => {
		const rc = mk();
		observeSensitivity(rc, ["phi"], "mychart");
		// A real empty Set is a genuine claim ("classified, nothing applies"); an empty ARRAY is
		// not, because it is indistinguishable from a dropped field and classify() taints it.
		observeSensitivity(rc, new Set(), "public-web");
		expect(tagsOf(rc.sensitivity)).toEqual(["phi"]);
		observeSensitivity(rc, ["legal"], "vault:legal/");
		expect(tagsOf(rc.sensitivity)).toEqual(["phi", "legal"]);
	});

	it("an empty ARRAY taints but an empty SET does not — the dropped-field case must not read as 'nothing applies'", () => {
		const viaArray = mk();
		observeSensitivity(viaArray, [], "serialized-source");
		expect(sameSensitivity(viaArray.sensitivity, MAX_SENSITIVITY)).toBe(true);
		const viaSet = mk();
		observeSensitivity(viaSet, new Set(), "classified-source");
		expect(sameSensitivity(viaSet.sensitivity, PUBLIC)).toBe(true);
	});

	it("an unclassified source taints the request — classify fails closed, so a source with no tags is not silently free", () => {
		const rc = mk();
		observeSensitivity(rc, undefined, "mystery-source");
		expect(sameSensitivity(rc.sensitivity, MAX_SENSITIVITY)).toBe(true);
	});

	it("provenance is deduped and ordered by first touch, so a refusal can be explained", () => {
		const rc = mk();
		observeSensitivity(rc, ["phi"], "mychart");
		observeSensitivity(rc, ["phi"], "mychart");
		observeSensitivity(rc, ["legal"], "vault");
		expect(rc.provenance).toEqual(["mychart", "vault"]);
	});

	it("deadline is readable rather than re-derived per call site, and degradation has a signal to fire on", () => {
		const rc = mk({ deadlineMs: 1_000, now: 5_000 });
		expect(remainingMs(rc, 5_000)).toBe(1_000);
		expect(remainingMs(rc, 5_600)).toBe(400);
		expect(isOverDeadline(rc, 5_600)).toBe(false);
		// Floors at 0 rather than going negative — a caller doing `remaining > 0` must not be
		// fooled by a negative number comparing false for the wrong reason.
		expect(remainingMs(rc, 9_999)).toBe(0);
		expect(isOverDeadline(rc, 9_999)).toBe(true);
	});

	it("defaults to sync mode, and carries the other modes the design names", () => {
		expect(mk().mode).toBe("sync");
		expect(mk({ mode: "async-pull" }).mode).toBe("async-pull");
	});

	it("describeSensitivity is audit-safe — tag names and provenance labels only, never the login", () => {
		const rc = mk({ login: "alice" });
		observeSensitivity(rc, ["phi"], "mychart:uwmedicine");
		const d = describeSensitivity(rc);
		expect(d).toEqual({ tags: ["phi"], provenance: ["mychart:uwmedicine"], maxed: false });
		expect(JSON.stringify(d)).not.toContain("alice");
		observeSensitivity(rc, undefined, "mystery");
		expect(describeSensitivity(rc).maxed).toBe(true);
	});

	it("describeSensitivity returns copies — a caller mutating the audit view must not reclassify the request", () => {
		const rc = mk();
		observeSensitivity(rc, ["phi"], "mychart");
		describeSensitivity(rc).provenance.push("injected");
		expect(rc.provenance).toEqual(["mychart"]);
	});

	it("carries the same reqId/login/ctx the egress audit already relied on — EgressContext is widened, not replaced", () => {
		const ctx = ctxStub();
		const rc = newRequestContext(ctx, { reqId: "abc123", login: "alice", deadlineMs: 60_000, now: 0 });
		expect(rc.reqId).toBe("abc123");
		expect(rc.login).toBe("alice");
		expect(rc.ctx).toBe(ctx);
		expect(sensitivity()).toBeInstanceOf(Set);
	});
});
