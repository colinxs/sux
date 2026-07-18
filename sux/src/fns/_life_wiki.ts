// The life-learning "living wiki" engine — the periodic synthesis that studies YOUR own
// signals (notes, files, mail, and what you've taught sux) and regenerates a two-audience
// living wiki: a HUMAN set of readable markdown notes ("what sux knows about my life") and
// a ROBOT llms.txt index (a compact map for the agent). It rides the SAME daily cron as
// mail-triage / self-improve and reuses the EXISTING, tested substrate: each life facet is
// one `recall` fan-out (vault + files + mail + learned, synthesized edge-private via
// Workers-AI), so no new retrieval or model plumbing is invented here.
//
// SAFETY — three independent guarantees, all structural (not mutable defaults):
//   • DORMANT / fail-closed. LIFE_WIKI_ENABLED unset (or "0"/"false"/"off"/empty) → the
//     whole loop is a total no-op: the fn and the cron tick return immediately, reading
//     nothing and — critically — writing nothing. Nothing runs until Colin flips the flag.
//   • SANDBOXED / non-destructive by construction. EVERY write is funneled through
//     wikiPath(), which prefixes the SANDBOX dir and REFUSES (throws) any relative path
//     that would escape it. The wiki lives ONLY under `sux/wiki/` — adjacent to, never
//     overwriting, the user's own notes. Deleting that subdir has zero impact on real files.
//   • EDGE-PRIVATE. All synthesis is `recall` → llm() = Workers-AI at the edge; personal
//     signals never leave for a frontier model. (recall itself fences untrusted material.)
import type { RtEnv } from "../registry";
import { errMsg } from "./_util";

// ── Gate ───────────────────────────────────────────────────────────────────────
// A dedicated toggle var (not a credential): the vault/AI creds gate WHAT can be gathered,
// but arming the autonomous synthesis is its own explicit flag. Read as a truthy toggle
// ("0"/"false"/"off"/"no"/empty → off) so an explicit LIFE_WIKI_ENABLED="0" stays off.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The synthesis may run at all. Unset → the feature is dormant (a total no-op). */
export const hasLifeWiki = (env: RtEnv): boolean => flagOn(env.LIFE_WIKI_ENABLED);

// ── Sandbox ──────────────────────────────────────────────────────────────────────
// The ONE directory the wiki is allowed to touch. Non-dot on purpose: the obsidian fn
// refuses dot-prefixed path segments on writes, so a `.sux-wiki/` sandbox couldn't be
// written through the git backend — `sux/wiki/` can, and stays visibly separate from the
// user's notes. Everything the synthesis emits is regenerable; git history is its undo.
export const SANDBOX_DIR = "sux/wiki";

/** Resolve a wiki-relative path to its full vault path INSIDE the sandbox, or throw. This is
 *  the non-destructive-by-construction choke point: it rejects absolute paths, empty/`.`/`..`
 *  segments, and anything that would resolve outside SANDBOX_DIR — so no facet name, bug, or
 *  crafted input can ever make a write land on a real user note. All wiki writes go through it. */
export function wikiPath(rel: string): string {
	const raw = String(rel ?? "").trim();
	if (!raw || raw.startsWith("/") || raw.includes("\0")) {
		throw new Error(`life-wiki: refusing unsafe path '${rel}' — must be a non-empty vault-relative path.`);
	}
	const segments = raw.replace(/\\/g, "/").split("/");
	for (const seg of segments) {
		if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) {
			throw new Error(`life-wiki: refusing path '${rel}' — segments must be non-empty and not '.', '..', or dot-prefixed (sandbox escape).`);
		}
	}
	return `${SANDBOX_DIR}/${segments.join("/")}`;
}

// ── Facets ─────────────────────────────────────────────────────────────────────────
// The fixed lenses the wiki synthesizes YOUR life through. Each is one recall question over
// your own stores; the answer becomes one human note. Deliberately small + stable so the
// wiki has a predictable shape (and predictable file paths) run to run. `file` is sandbox-
// relative — wikiPath() prefixes SANDBOX_DIR.
export type Facet = { slug: string; title: string; file: string; question: string };

export const FACETS: Facet[] = [
	{
		slug: "people",
		title: "People",
		file: "People.md",
		question: "Who are the important people in my life — family, friends, colleagues, and care providers? For each, what should I remember: how we're connected, and any key facts, dates, or context?",
	},
	{
		slug: "health",
		title: "Health",
		file: "Health.md",
		question: "What is the current state of my health — conditions, medications, providers, and upcoming or recent appointments and results? Summarize what I'd want to remember.",
	},
	{
		slug: "projects",
		title: "Projects & Work",
		file: "Projects.md",
		question: "What are my active projects, work commitments, and obligations right now? What's their status and what are the next steps?",
	},
	{
		slug: "timeline",
		title: "Timeline",
		file: "Timeline.md",
		question: "What are the notable events in my life recently, and what is coming up soon? Give a short chronological timeline of what happened and what's ahead.",
	},
	{
		slug: "interests",
		title: "Interests & Preferences",
		file: "Interests.md",
		question: "What are my interests, tastes, preferences, and the things I care about — hobbies, topics I follow, choices I've made? Summarize what defines what I like.",
	},
];

// The stores each facet fans out over. mail/files/calendar/contacts degrade quietly when
// unconfigured (recall reports them as "no matches"/"unavailable"), so this list is safe
// regardless of which creds are set. web is intentionally EXCLUDED: the wiki is about YOUR
// signals, not the web. Mirrors onboard's ONBOARD_SOURCES (_onboard.ts) — the facet questions
// above (health's appointments, timeline's upcoming events, people's connections) need
// calendar/contacts to be answerable at all.
const WIKI_SOURCES = ["vault", "files", "mail", "calendar", "contacts", "learned", "imessage"];

// ── Deps (injectable — tests pass fakes) ─────────────────────────────────────────────
export type FacetResult = { slug: string; title: string; file: string; answer: string; citations: string[]; sourceStatus: Record<string, string> };

export type LifeWikiDeps = {
	/** Fan out one facet question over the user's stores and return the synthesized recall. */
	recall: (env: RtEnv, question: string, sources: string[]) => Promise<{ answer: string; citations: string[]; sources: Record<string, string> }>;
	/** Overwrite a note at a FULL vault path with content (git-backed; history is the undo). */
	write: (env: RtEnv, fullPath: string, content: string) => Promise<void>;
};

export type LifeWikiOpts = { facets?: string[]; dry_run?: boolean };

export type LifeWikiReport = {
	dormant?: boolean;
	dry_run?: boolean;
	sandbox: string;
	generated: number;
	written: number;
	facets: Array<{ slug: string; title: string; file?: string; citations: number; sources: Record<string, string>; error?: string }>;
	index?: string;
	llms?: string;
	note?: string;
};

const iso = () => new Date().toISOString();

// ── Rendering (pure) ───────────────────────────────────────────────────────────────
/** One human facet note: frontmatter + the recall synthesis + its citations. Regenerated
 *  each run — the whole body is generated, so it carries no hand-edited region (unlike the
 *  repo wiki's marker-merge; these notes are wholly synthetic and live only in the sandbox). */
export function renderFacetNote(f: Facet, r: { answer: string; citations: string[] }): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`title: "${f.title}"`);
	lines.push("type: life-wiki");
	lines.push(`facet: ${f.slug}`);
	lines.push("generated: true");
	lines.push("---");
	lines.push("");
	lines.push(`# ${f.title}`);
	lines.push("");
	lines.push("> [!note] Auto-generated by sux life-wiki from your own notes, files, mail, and taught examples. Regenerated on a schedule — edits here are overwritten. Safe to delete; nothing else depends on it.");
	lines.push("");
	lines.push(r.answer.trim() || "_Nothing found for this facet yet._");
	if (r.citations.length) {
		lines.push("");
		lines.push("## Sources");
		for (const c of r.citations) lines.push(`- \`${c}\``);
	}
	return `${lines.join("\n")}\n`;
}

/** The human index — "what sux knows about my life": links every facet note + a one-line
 *  gloss of how many sources it drew on. The reader's front door to the wiki. */
export function renderIndex(results: FacetResult[]): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push('title: "What sux knows about my life"');
	lines.push("type: life-wiki-index");
	lines.push("generated: true");
	lines.push("---");
	lines.push("");
	lines.push("# What sux knows about my life");
	lines.push("");
	lines.push("> [!note] Auto-generated living wiki. Each note below is synthesized from your OWN signals — notes, files, mail, and examples you've taught sux — never the open web. Regenerated on a schedule; this whole folder is safe to delete.");
	lines.push("");
	for (const r of results) {
		const hits = r.citations.length;
		lines.push(`- [[${r.file.replace(/\.md$/, "")}|${r.title}]] — ${hits} source${hits === 1 ? "" : "s"}`);
	}
	lines.push("");
	lines.push(`_Last generated: ${iso()}._`);
	return `${lines.join("\n")}\n`;
}

/** The robot index — a compact, deterministic-shaped llms.txt map of the wiki for the agent:
 *  every facet, its sandbox path, its source count, and the first line of its synthesis. */
export function renderLlms(results: FacetResult[]): string {
	const lines: string[] = [];
	lines.push("# sux life-wiki (robot index)");
	lines.push("# What sux has learned about the user's life, synthesized from their own signals.");
	lines.push(`# sandbox: ${SANDBOX_DIR}/  (regenerable; safe to delete)`);
	lines.push("");
	for (const r of results) {
		const first = (r.answer.split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
		lines.push(`## ${r.title} [${r.slug}]`);
		lines.push(`path: ${SANDBOX_DIR}/${r.file}`);
		lines.push(`sources: ${r.citations.length}`);
		lines.push(`summary: ${first || "(nothing found yet)"}`);
		lines.push("");
	}
	return `${lines.join("\n")}`;
}

// ── The synthesis ────────────────────────────────────────────────────────────────────
/** Regenerate the living wiki once. Fail-closed: with LIFE_WIKI_ENABLED unset this returns a
 *  dormant no-op and WRITES NOTHING (deps.write is never called — the dormancy guarantee the
 *  tests pin). Otherwise it synthesizes each selected facet via `recall`, then writes the
 *  facet notes + the human index + the robot llms.txt — every write through wikiPath(), so
 *  nothing can land outside the sandbox. dry_run gathers + renders but writes nothing. Never
 *  throws out of a single facet: a failing recall is recorded per-facet and the rest proceed. */
export async function runLifeWiki(env: RtEnv, opts: LifeWikiOpts, deps: LifeWikiDeps): Promise<LifeWikiReport> {
	if (!hasLifeWiki(env)) {
		return {
			dormant: true,
			sandbox: SANDBOX_DIR,
			generated: 0,
			written: 0,
			facets: [],
			note: "life_wiki is disabled — set LIFE_WIKI_ENABLED to synthesize a living wiki from your own signals into the sandbox. Fail-closed: nothing runs and nothing is written until the flag is set.",
		};
	}

	const dryRun = opts.dry_run === true;
	const wanted = Array.isArray(opts.facets) && opts.facets.length ? new Set(opts.facets.map(String)) : null;
	const chosen = wanted ? FACETS.filter((f) => wanted.has(f.slug)) : FACETS;

	const results: FacetResult[] = [];
	const facetReport: LifeWikiReport["facets"] = [];
	let written = 0;

	for (const f of chosen) {
		try {
			const r = await deps.recall(env, f.question, WIKI_SOURCES);
			const res: FacetResult = { slug: f.slug, title: f.title, file: f.file, answer: r.answer ?? "", citations: r.citations ?? [], sourceStatus: r.sources ?? {} };
			results.push(res);
			if (!dryRun) {
				await deps.write(env, wikiPath(f.file), renderFacetNote(f, res));
				written++;
			}
			facetReport.push({ slug: f.slug, title: f.title, file: `${SANDBOX_DIR}/${f.file}`, citations: res.citations.length, sources: res.sourceStatus });
		} catch (e) {
			facetReport.push({ slug: f.slug, title: f.title, citations: 0, sources: {}, error: errMsg(e) });
		}
	}

	// Indexes reflect only the facets that synthesized. Best-effort: an index-write failure
	// must not undo the facet notes already written, so it's caught and reported, not fatal.
	let indexPath: string | undefined;
	let llmsPath: string | undefined;
	if (!dryRun && results.length) {
		try {
			await deps.write(env, wikiPath("index.md"), renderIndex(results));
			indexPath = `${SANDBOX_DIR}/index.md`;
			written++;
		} catch {
			/* index is regenerable next tick — never fail the run over it */
		}
		try {
			await deps.write(env, wikiPath("llms.txt"), renderLlms(results));
			llmsPath = `${SANDBOX_DIR}/llms.txt`;
			written++;
		} catch {
			/* llms index is regenerable next tick */
		}
	}

	return { dry_run: dryRun || undefined, sandbox: SANDBOX_DIR, generated: results.length, written, facets: facetReport, index: indexPath, llms: llmsPath };
}

// ── Default deps: the real recall fn + git-backed vault write ──────────────────────────
/** Real deps: the existing `recall` fn (edge-private cross-store synthesis) and the obsidian
 *  git backend (every write a commit → history is the undo). Dynamically imported to keep the
 *  cron path from pulling the whole retrieval surface unless the feature is armed, mirroring
 *  _mail_triage.defaultDeps. Tests inject fakes and never touch this. */
export async function defaultDeps(): Promise<LifeWikiDeps> {
	const { recall } = await import("./recall");
	const { obsidian } = await import("./obsidian");
	return {
		recall: async (env, question, sources) => {
			const r = await recall.run(env, { question, sources });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "recall failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return { answer: String(parsed?.answer ?? ""), citations: Array.isArray(parsed?.citations) ? parsed.citations.map(String) : [], sources: (parsed?.sources ?? {}) as Record<string, string> };
		},
		write: async (env, fullPath, content) => {
			const r = await obsidian.run(env, { action: "write", path: fullPath, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault write failed");
		},
	};
}
