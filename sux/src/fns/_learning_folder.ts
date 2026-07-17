// Learning-folder reconciliation (#433): the Dropbox app folder is the human-writable
// inbox (docs/proposals/domains.md §dropbox — "a file dropped in the Dropbox app folder
// becomes visible to capture"), but nothing ever watched it. This sweep lists a
// configured subfolder, diffs its PDFs against what's already whitelisted in the
// oracle (study's provenance ledger — see oracle.ts's StoredKb.sources), and studies
// whatever's new.
//
// FAIL-CLOSED: dormant unless LEARNING_FOLDER_ENABLED is set (mirrors _briefing/_agenda).
//
// study's pdf-from-path branch (study.ts's extractDocText) only reads Dropbox paths
// through Mode B (whole-account, DROPBOX_FULL_*) — the app folder is Mode A. Rather
// than require a second Dropbox credential just to read files the app-folder token can
// already see, this mints a Mode A shared link (dropbox.ts's sharedLink, forced to a
// raw download with dl=1) and hands study that http(s) URL instead — no Mode B needed.
import { type RtEnv } from "../registry";
import { dropbox, hasDropbox, sharedLink } from "./dropbox";
import { dropboxRawUrl } from "./_util";
import { oracle, loadKb } from "./oracle";
import { study } from "./study";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The sweep may run at all. Unset → total no-op (dormant), same posture as briefing/agenda. */
export const hasLearningFolder = (env: RtEnv): boolean => flagOn(env.LEARNING_FOLDER_ENABLED) && hasDropbox(env);

export const learningFolderPath = (env: RtEnv): string => String(env.LEARNING_FOLDER_PATH ?? "/learning").trim() || "/learning";
export const learningFolderTopic = (env: RtEnv): string => String(env.LEARNING_FOLDER_TOPIC ?? "learning").trim() || "learning";

// One run studies at most this many new PDFs — an unattended cron sweep should never
// fan out an unbounded number of Workers-AI transcriptions in one tick.
const MAX_PER_RUN = 5;

const normPath = (p: string): string => `/${String(p ?? "").replace(/^\/+/, "")}`;

export type LearningFolderEntry = { path: string; name: string };

export type LearningFolderDeps = {
	listFolder: (env: RtEnv) => Promise<LearningFolderEntry[]>;
	listStudiedPaths: (env: RtEnv) => Promise<Set<string>>;
	shareUrl: (env: RtEnv, path: string) => Promise<string | undefined>;
	studyPdf: (env: RtEnv, url: string, topic: string, title: string) => Promise<{ ok: boolean; error?: string }>;
};

async function defaultListFolder(env: RtEnv): Promise<LearningFolderEntry[]> {
	const path = learningFolderPath(env);
	const entries: LearningFolderEntry[] = [];
	let cursor: string | undefined;
	do {
		const r = await dropbox.run(env, cursor ? { op: "list", path, cursor } : { op: "list", path });
		if (r.isError) throw new Error(r.content?.[0]?.text ?? `dropbox list failed for ${path}`);
		const j = JSON.parse(r.content?.[0]?.text ?? "{}");
		for (const e of j.entries ?? []) {
			if (e.kind === "file" && /\.pdf$/i.test(String(e.name ?? ""))) entries.push({ path: String(e.path), name: String(e.name) });
		}
		cursor = j.has_more ? j.cursor : undefined;
	} while (cursor);
	return entries;
}

// The set of Dropbox app-folder paths already studied — study.ts records a pdf-from-
// path source as `dropbox:${normFull(path)}`, so a `dropbox:` prefix strip + norm is
// the reconciliation key. Sources are scattered across every topic (a PDF could have
// been studied under any of them), so this unions across all of them.
async function defaultListStudiedPaths(env: RtEnv): Promise<Set<string>> {
	const r = await oracle.run(env, { action: "list" });
	if (r.isError) return new Set();
	const j = JSON.parse(r.content?.[0]?.text ?? "{}");
	const topics: string[] = j.topics ?? [];
	const kbs = await Promise.all(topics.map((t) => loadKb(env, t)));
	const studied = new Set<string>();
	for (const kb of kbs) {
		for (const src of kb?.sources ?? []) {
			if (src.startsWith("dropbox:")) studied.add(normPath(src.slice("dropbox:".length)));
		}
	}
	return studied;
}

async function defaultStudyPdf(env: RtEnv, url: string, topic: string, title: string): Promise<{ ok: boolean; error?: string }> {
	const r = await study.run(env, { action: "learn", source: url, kind: "pdf", topic, title });
	if (r.isError) return { ok: false, error: r.content?.[0]?.text };
	return { ok: true };
}

export function defaultDeps(): LearningFolderDeps {
	return { listFolder: defaultListFolder, listStudiedPaths: defaultListStudiedPaths, shareUrl: sharedLink, studyPdf: defaultStudyPdf };
}

export type LearningFolderResult = { dormant?: true; folder?: string; total?: number; studied?: string[]; skipped?: string[]; errors?: string[] };

/** List the learning folder, diff against what's already studied, and study whatever's
 * new (bounded to MAX_PER_RUN) — the actual reconciliation the issue asks for. */
export async function runLearningFolderSync(env: RtEnv, deps: LearningFolderDeps = defaultDeps()): Promise<LearningFolderResult> {
	if (!hasLearningFolder(env)) return { dormant: true };

	const folder = learningFolderPath(env);
	const topic = learningFolderTopic(env);
	const [entries, studiedPaths] = await Promise.all([deps.listFolder(env), deps.listStudiedPaths(env)]);

	const fresh = entries.filter((e) => !studiedPaths.has(normPath(e.path)));
	const toStudy = fresh.slice(0, MAX_PER_RUN);
	const skipped = fresh.slice(MAX_PER_RUN).map((e) => e.path);

	const studied: string[] = [];
	const errors: string[] = [];
	for (const entry of toStudy) {
		const url = await deps.shareUrl(env, entry.path);
		if (!url) {
			errors.push(`${entry.path}: could not mint a shared link`);
			continue;
		}
		const r = await deps.studyPdf(env, dropboxRawUrl(url), topic, entry.name);
		if (r.ok) studied.push(entry.path);
		else errors.push(`${entry.path}: ${r.error ?? "study failed"}`);
	}

	return { folder, total: entries.length, studied, skipped, ...(errors.length ? { errors } : {}) };
}
