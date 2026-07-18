import { hasAI } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { DEFAULT_DIR, DIMENSIONS, defaultDeps, initVault, synthesizeProfile, type Answer } from "./_onboard";
import { badVaultPath } from "./obsidian";
import { errMsg, oj } from "./_util";

// onboard — "Sux, learn about me": the flagship self-model (docs/design/north-star.md).
// action:'profile' (read-only) fans recall's cross-store gather inward across your own
// vault/files/mail/calendar/contacts/learned to synthesize a structured profile
// (interests/expertise/relationships/projects/goals) and identifies up to a couple of
// high-signal gaps as `questions`. Pass those back as `answers` on a follow-up call to
// fold them in as trusted material. action:'init' writes the (optionally re-synthesized)
// profile into the vault as one note per dimension plus a "Who I Am" root MOC. See
// _onboard.ts for the synthesis + rendering.
export const onboard: Fn = {
	name: "onboard",
	surface: "leaf",
	cacheable: false,
	cost: 5,
	description:
		"'Sux, learn about me' — the self-model flagship. Fans recall's cross-store gather (vault/files/mail/calendar/contacts/learned — never the web) INWARD to synthesize a structured personal profile across 6 dimensions: interests, expertise, relationships, projects, goals, courses. The courses dimension additionally best-effort-fetches a couple of syllabus/course-page URLs found IN that gathered material (never a web search) to synthesize what's been covered. " +
		"action:'profile' (default, READ-only) returns the synthesized profile plus up to 2 high-signal `questions` — the biggest gaps a direct answer would fill. Pass those back as `answers` ([{question, answer}]) on a follow-up call: they're folded in as trusted material ahead of everything gathered, sharpening the synthesis and shrinking the remaining gaps. " +
		"action:'init' writes the profile into the vault: one note per dimension plus a \"Who I Am\" root MOC linking them (and listing any still-open questions) — default dir 'Who I Am/', override with `dir`. Every note is a git commit, so history is the undo; re-running init overwrites with a fresh synthesis. " +
		"`dimensions` limits either action to a subset of [interests, expertise, relationships, projects, goals, courses] (default: all). Needs the Workers-AI binding; each source degrades quietly when unconfigured, same as recall.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["profile", "init"], default: "profile", description: "profile: read-only synthesis + gap questions. init: write the profile into the vault." },
			dimensions: { type: "array", items: { type: "string", enum: DIMENSIONS.map((d) => d.slug) }, description: "Limit to these self-model dimensions (default: all)." },
			answers: {
				type: "array",
				items: { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } },
				description: "Answers to prior gap-fill `questions`, folded into the synthesis as trusted [you answered] material.",
			},
			dir: { type: "string", description: `Vault directory to write into (action:'init' only). Default '${DEFAULT_DIR}'.` },
		},
	},
	run: async (env: RtEnv, args: any) => {
		if (!hasAI(env)) return failWith("not_configured", "Workers AI binding not configured — needed to synthesize the self-model.");
		const action = args?.action ? String(args.action) : "profile";
		if (action !== "profile" && action !== "init") return failWith("bad_input", `onboard: unknown action '${action}'. Use 'profile' or 'init'.`);

		const dims = Array.isArray(args?.dimensions) ? args.dimensions.map(String) : undefined;
		const answers: Answer[] = Array.isArray(args?.answers)
			? args.answers.filter((a: any) => a && typeof a.question === "string" && typeof a.answer === "string").map((a: any) => ({ question: a.question, answer: a.answer }))
			: [];

		let dir = DEFAULT_DIR;
		if (action === "init") {
			dir = typeof args?.dir === "string" && args.dir.trim() ? args.dir.trim().replace(/^\/+|\/+$/g, "") : DEFAULT_DIR;
			const bad = badVaultPath(`${dir}/index.md`);
			if (bad) return failWith("bad_input", bad);
		}

		try {
			const deps = await defaultDeps();
			const profile = await synthesizeProfile(env, { dimensions: dims, answers }, deps);
			if (action === "profile") {
				return ok(oj({ action, profile: profile.dimensions, questions: profile.questions }));
			}
			const chosenDims = dims && dims.length ? DIMENSIONS.filter((d) => dims.includes(d.slug)) : DIMENSIONS;
			const { written } = await initVault(env, dir, profile.dimensions, chosenDims, profile.questions, deps);
			return ok(oj({ action, dir, written, questions: profile.questions }));
		} catch (e) {
			return failWith("upstream_error", `onboard ${action} failed: ${errMsg(e)}`);
		}
	},
};
