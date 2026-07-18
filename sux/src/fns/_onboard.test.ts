import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DIR, DIMENSIONS, initVault, MAX_QUESTIONS, synthesizeProfile, type OnboardDeps } from "./_onboard";

const envWith = (flags: Record<string, string | undefined> = {}) => ({ ...flags }) as any;

const mkDeps = (opts?: { gather?: OnboardDeps["gather"]; synthesize?: OnboardDeps["synthesize"] }): OnboardDeps & { writes: Array<{ path: string; content: string }>; gathered: ReturnType<typeof vi.fn>; synthesized: ReturnType<typeof vi.fn> } => {
	const writes: Array<{ path: string; content: string }> = [];
	const gathered = vi.fn(opts?.gather ?? (async () => ({ materials: ["[vault:x.md]\nsome material"], citations: ["vault:x.md"], status: { vault: "1 hit(s)" } })));
	const synthesized = vi.fn(opts?.synthesize ?? (async (_env: any, system: string) => (system.includes("clarifying questions") ? "NONE" : "A synthesized answer.")));
	return {
		gather: gathered as unknown as OnboardDeps["gather"],
		synthesize: synthesized as unknown as OnboardDeps["synthesize"],
		write: async (_e, path, content) => void writes.push({ path, content }),
		writes,
		gathered,
		synthesized,
	};
};

describe("synthesizeProfile — dimension synthesis", () => {
	it("synthesizes every dimension by default", async () => {
		const deps = mkDeps();
		const report = await synthesizeProfile(envWith(), {}, deps);
		expect(report.dimensions).toHaveLength(DIMENSIONS.length);
		expect(deps.gathered).toHaveBeenCalledTimes(DIMENSIONS.length);
		for (const d of report.dimensions) expect(d.answer).toBe("A synthesized answer.");
	});

	it("limits to the requested dimensions", async () => {
		const deps = mkDeps();
		const report = await synthesizeProfile(envWith(), { dimensions: ["interests", "goals"] }, deps);
		expect(report.dimensions.map((d) => d.slug).sort()).toEqual(["goals", "interests"]);
		expect(deps.gathered).toHaveBeenCalledTimes(2);
	});

	it("degrades to 'nothing found' when a dimension gathers no material at all", async () => {
		const deps = mkDeps({ gather: async () => ({ materials: [], citations: [], status: { vault: "no matches" } }) });
		const report = await synthesizeProfile(envWith(), { dimensions: ["interests"] }, deps);
		expect(report.dimensions[0].answer).toContain("Nothing found");
		// no material to synthesize from, so the dimension itself skips the llm() call — the
		// one remaining call is the gap-fill pass, which still runs over the "nothing found" text.
		expect(deps.synthesized).toHaveBeenCalledTimes(1);
	});

	it("a failing dimension is isolated — it doesn't abort the run or block the others", async () => {
		let n = 0;
		const deps = mkDeps({
			gather: async () => {
				n++;
				if (n === 1) throw new Error("gather blew up");
				return { materials: ["[vault:x.md]\nmaterial"], citations: ["vault:x.md"], status: {} };
			},
		});
		const report = await synthesizeProfile(envWith(), {}, deps);
		expect(report.dimensions.some((d) => d.answer.includes("gather blew up"))).toBe(true);
		expect(report.dimensions).toHaveLength(DIMENSIONS.length);
	});

	it("folds `answers` in as trusted [you answered] material ahead of gathered passages", async () => {
		const seen: string[][] = [];
		const deps = mkDeps({
			synthesize: async (_env, system, material) => {
				if (!system.includes("clarifying questions")) seen.push([material]);
				return "answered synthesis";
			},
		});
		await synthesizeProfile(envWith(), { dimensions: ["interests"], answers: [{ question: "What do you like?", answer: "Climbing." }] }, deps);
		expect(seen[0][0].startsWith("[you answered]")).toBe(true);
		expect(seen[0][0]).toContain("Climbing.");
	});

	it("ignores malformed answers (missing question/answer)", async () => {
		const deps = mkDeps();
		const report = await synthesizeProfile(envWith(), { dimensions: ["interests"], answers: [{ question: "" } as any, { answer: "x" } as any] }, deps);
		expect(report.dimensions[0].citations).not.toContain("you answered");
	});
});

describe("synthesizeProfile — courses dimension", () => {
	it("fetches urls found in the gathered material and folds them in as [syllabus:] material", async () => {
		const fetched: string[] = [];
		const deps = mkDeps({
			gather: async () => ({ materials: ["[mail:receipt]\nEnrolled in CS101, see https://school.edu/cs101/syllabus for the syllabus."], citations: ["mail:receipt"], status: {} }),
		});
		deps.fetchUrl = async (_env, url) => {
			fetched.push(url);
			return "Week 1: intro. Week 2: recursion.";
		};
		const report = await synthesizeProfile(envWith(), { dimensions: ["courses"] }, deps);
		expect(fetched).toEqual(["https://school.edu/cs101/syllabus"]);
		expect(report.dimensions[0].citations).toContain("syllabus:https://school.edu/cs101/syllabus");
	});

	it("caps fetched urls at MAX_COURSE_LINKS and isolates a failing fetch", async () => {
		const deps = mkDeps({
			gather: async () => ({
				materials: ["see https://a.edu/x and https://b.edu/y and https://c.edu/z"],
				citations: [],
				status: {},
			}),
		});
		let calls = 0;
		deps.fetchUrl = async (_env, url) => {
			calls++;
			if (url.includes("a.edu")) throw new Error("fetch failed");
			return `material for ${url}`;
		};
		const report = await synthesizeProfile(envWith(), { dimensions: ["courses"] }, deps);
		expect(calls).toBe(2); // MAX_COURSE_LINKS caps candidates before any fetch runs
		expect(report.dimensions[0].citations).not.toContain("syllabus:https://a.edu/x");
		expect(report.dimensions[0].citations).toContain("syllabus:https://b.edu/y");
	});

	it("skips fetching entirely when deps.fetchUrl is not provided", async () => {
		const deps = mkDeps({
			gather: async () => ({ materials: ["see https://a.edu/x"], citations: [], status: {} }),
		});
		const report = await synthesizeProfile(envWith(), { dimensions: ["courses"] }, deps);
		expect(report.dimensions[0].answer).toBe("A synthesized answer.");
	});
});

describe("synthesizeProfile — gap-fill", () => {
	it("returns [] when the synthesizer says NONE", async () => {
		const deps = mkDeps();
		const report = await synthesizeProfile(envWith(), { dimensions: ["interests"] }, deps);
		expect(report.questions).toEqual([]);
	});

	it("parses one question per line and caps at MAX_QUESTIONS", async () => {
		const deps = mkDeps({
			synthesize: async (_env, system) => {
				if (system.includes("clarifying questions")) return "- What is your job?\n- Who is your emergency contact?\n- A third one that should be dropped?";
				return "an answer";
			},
		});
		const report = await synthesizeProfile(envWith(), { dimensions: ["interests"] }, deps);
		expect(report.questions).toHaveLength(MAX_QUESTIONS);
		expect(report.questions[0]).toBe("What is your job?");
		expect(report.questions[1]).toBe("Who is your emergency contact?");
	});

	it("a failing gap-fill call degrades to no questions rather than throwing", async () => {
		const deps = mkDeps({
			synthesize: async (_env, system) => {
				if (system.includes("clarifying questions")) throw new Error("llm down");
				return "an answer";
			},
		});
		const report = await synthesizeProfile(envWith(), { dimensions: ["interests"] }, deps);
		expect(report.questions).toEqual([]);
	});
});

describe("initVault — writes one note per dimension + a root MOC", () => {
	it("writes every chosen dimension's note plus dir/index.md", async () => {
		const deps = mkDeps();
		const results = DIMENSIONS.map((d) => ({ slug: d.slug, title: d.title, file: d.file, answer: `About ${d.title} [vault:x.md].`, citations: ["vault:x.md"], sources: {} }));
		const { written } = await initVault(envWith(), DEFAULT_DIR, results, DIMENSIONS, [], deps);
		expect(written).toHaveLength(DIMENSIONS.length + 1);
		for (const d of DIMENSIONS) expect(deps.writes.some((w) => w.path === `${DEFAULT_DIR}/${d.file}`)).toBe(true);
		expect(deps.writes.some((w) => w.path === `${DEFAULT_DIR}/index.md`)).toBe(true);
	});

	it("writes to a custom dir", async () => {
		const deps = mkDeps();
		const results = [{ slug: "interests", title: "Interests", file: "Interests.md", answer: "x", citations: [], sources: {} }];
		const dims = DIMENSIONS.filter((d) => d.slug === "interests");
		await initVault(envWith(), "Custom/Dir", results, dims, [], deps);
		expect(deps.writes.map((w) => w.path)).toEqual(["Custom/Dir/Interests.md", "Custom/Dir/index.md"]);
	});

	it("the root MOC lists still-open questions", async () => {
		const deps = mkDeps();
		const results = [{ slug: "interests", title: "Interests", file: "Interests.md", answer: "x", citations: [], sources: {} }];
		const dims = DIMENSIONS.filter((d) => d.slug === "interests");
		await initVault(envWith(), DEFAULT_DIR, results, dims, ["What is your job?"], deps);
		const root = deps.writes.find((w) => w.path === `${DEFAULT_DIR}/index.md`);
		expect(root?.content).toContain("What is your job?");
	});
});
