import { describe, expect, it, vi } from "vitest";
import { expert_draft } from "./expert_draft";

const SOURCES = [{ id: "s1", citation: "Some Journal 2024", excerpt: "A 0.41 meq/L level is ABOVE the 0.4 meq/L threshold." }];

function parse(r: any): any {
	return JSON.parse(r.content[0].text);
}

/** env with the real llm() driving a stubbed AI.run, keyed by system-prompt shape (draft vs
 *  skeptic) — mirrors oracle.test.ts's makeEnv convention: order-independent, real llm(). */
function makeEnv(opts: { draft?: unknown; skeptic?: unknown | unknown[] } = {}) {
	let skepticCall = 0;
	const skeptic = opts.skeptic ?? { refuted: false, issues: [] };
	const skepticSeq = Array.isArray(skeptic) ? skeptic : [skeptic, skeptic, skeptic];
	const run = vi.fn(async (_model: string, inputs: any) => {
		const system: string = inputs.messages.find((m: any) => m.role === "system").content;
		if (/ADVERSARIAL reviewer/.test(system)) {
			const v = skepticSeq[Math.min(skepticCall, skepticSeq.length - 1)];
			skepticCall++;
			return { response: typeof v === "string" ? v : JSON.stringify(v) };
		}
		const d = opts.draft ?? { assessment: "This reads as a plausible breach.", claims: [{ claim: "the level was under threshold", status: "supported", source_id: "s1" }] };
		return { response: typeof d === "string" ? d : JSON.stringify(d) };
	});
	return { env: { AI: { run } } as any, run };
}

const BASE_ARGS = { role: "toxicologist", question: "does this read as a breach", fact_pattern: "patient had a 0.41 meq/L level", sources: SOURCES };

describe("expert_draft", () => {
	it("requires role/question/fact_pattern/sources", async () => {
		const { env } = makeEnv();
		expect((await expert_draft.run(env, { ...BASE_ARGS, role: "" })).isError).toBe(true);
		expect((await expert_draft.run(env, { ...BASE_ARGS, question: "" })).isError).toBe(true);
		expect((await expert_draft.run(env, { ...BASE_ARGS, fact_pattern: "" })).isError).toBe(true);
		expect((await expert_draft.run(env, { ...BASE_ARGS, sources: [] })).isError).toBe(true);
	});

	it("fails not_configured without an AI binding", async () => {
		const r = await expert_draft.run({} as any, BASE_ARGS);
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("not_configured");
	});

	it("always carries the unconditional non-expert disclaimer, pass or reject", async () => {
		const { env: passEnv } = makeEnv({ skeptic: { refuted: false, issues: [] } });
		const pass = parse(await expert_draft.run(passEnv, BASE_ARGS));
		expect(pass.disclaimer).toMatch(/NOT a real expert/);

		const { env: rejectEnv } = makeEnv({ skeptic: { refuted: true, issues: ["error"] } });
		const rejected = parse(await expert_draft.run(rejectEnv, BASE_ARGS));
		expect(rejected.disclaimer).toMatch(/NOT a real expert/);
	});

	it("returns the draft assessment/claims when the majority of adversarial reviewers do NOT refute", async () => {
		const { env, run } = makeEnv({ skeptic: [{ refuted: false, issues: [] }, { refuted: false, issues: [] }, { refuted: true, issues: ["minor nit"] }] });
		const out = parse(await expert_draft.run(env, BASE_ARGS));
		expect(out.review).toMatchObject({ rejected: false, votes: 3, refuted: 1 });
		expect(out.assessment).toBe("This reads as a plausible breach.");
		expect(out.claims).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(4); // 1 draft + 3 skeptics
	});

	it("reproduces the vault precedent's failure modes — a threshold error and a scope-mismatched citation are caught by adversarial review and the draft is withheld", async () => {
		// The draft (as an unreviewed model might produce it) makes the exact mistake the vault
		// precedent's real-world attempt made: it calls 0.41 "under" a 0.4 threshold (it's above),
		// and cites s1 for a claim s1 never actually tested (scope mismatch).
		const badDraft = {
			assessment: "The 0.41 meq/L level was under the 0.4 threshold, consistent with a breach.",
			claims: [
				{ claim: "0.41 is under the 0.4 threshold", status: "supported", source_id: "s1" },
				{ claim: "this specific patient subtype was studied in s1", status: "supported", source_id: "s1" },
			],
		};
		// All 3 independent reviewers catch it (majority-refute kills it) — this asserts the
		// MECHANISM enforces "never presented without surviving review", not that an LLM can
		// reliably self-detect the error (that's inherently unverifiable without a live model).
		const { env } = makeEnv({
			draft: badDraft,
			skeptic: [
				{ refuted: true, issues: ["0.41 is ABOVE 0.4, not under it — arithmetic/threshold error"] },
				{ refuted: true, issues: ["s1 doesn't establish this patient's subtype was studied — scope-mismatched citation"] },
				{ refuted: false, issues: [] },
			],
		});
		const out = parse(await expert_draft.run(env, BASE_ARGS));
		expect(out.review.rejected).toBe(true);
		expect(out.assessment).toMatch(/REJECTED by adversarial review/);
		expect(out.claims).toEqual([]);
		expect(out.review.issues.join(" ")).toMatch(/threshold error/);
		expect(out.review.issues.join(" ")).toMatch(/scope-mismatched citation/);
	});

	it("defaults an unparseable skeptic response to refuted (fail-closed, never a silent pass)", async () => {
		const { env } = makeEnv({ skeptic: ["not json at all", "not json at all", "not json at all"] });
		const out = parse(await expert_draft.run(env, BASE_ARGS));
		expect(out.review.rejected).toBe(true);
		expect(out.review.refuted).toBe(3);
	});

	it("parses a draft wrapped in a ```json code fence", async () => {
		const fenced = "```json\n" + JSON.stringify({ assessment: "ok", claims: [] }) + "\n```";
		const { env } = makeEnv({ draft: fenced, skeptic: { refuted: false, issues: [] } });
		const out = parse(await expert_draft.run(env, BASE_ARGS));
		expect(out.assessment).toBe("ok");
	});
});
