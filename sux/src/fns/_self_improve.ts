// Chunk 05 — the self-improvement loop. Rides the daily Cron (index.ts scheduled()
// → selfImproveTick, beside maintenanceTick): consume the `issue`/`suggest` feedback
// backlog (fns/_feedback.ts) since a KV cursor, build a finding per entry, classify a
// LANE, and route by lane. This is the sharpest tool in the box, so it is gated the
// HARDEST — every outward or autonomous action is fail-closed, defaults OFF, and the
// module structurally cannot loosen its own guards.
//
// SAFETY MODEL (fail-closed, layered — mirrors hasDropboxFull's pure env predicates;
// the gate vars are `wrangler secret`s Colin controls, NOT declared in wrangler.jsonc):
//   isKilled       — SELF_IMPROVE_KILL, checked FIRST, before enable and before any
//                    feedback read. Any truthy value halts the whole tick to a no-op.
//                    Kill wins over arm: a tripped kill stops even a fully-armed loop.
//   hasSelfImprove — SELF_IMPROVE_ENABLE && !killed. Unset ⇒ loop inert (ships dormant).
//   canOpenPr      — enabled && GITHUB_TOKEN present && SELF_IMPROVE_PR==='on'. Absent ⇒
//                    REVIEW-ONLY: reads feedback, records findings to KV, opens NOTHING.
//   isArmed        — canOpenPr && SELF_IMPROVE_ARM==='armed' (explicit sentinel). The
//                    ONLY gate under which mergePr() is reachable — and only on the
//                    fix/refactor/cleanup lane, only when the PR's CI is green.
//   SECURITY lane  — ALWAYS PR, in a code path with NO arm check and NO merge call
//                    reachable. Even armed, even when the classifier is unsure, security
//                    never auto-merges. Ambiguous findings bias to security ⇒ PR.
//   RATE CAP       — SELF_IMPROVE_DAILY_CAP is a compile-time literal const (below), NOT
//                    from env, NOT from KV. The loop reads the const and writes only a KV
//                    day-counter, so it structurally cannot raise its own cap.
//
// The module imports nothing that can write env vars, wrangler config, or the repo's
// workflow/CI files — so it cannot disable its own kill-switch or edit the CI that gates
// a merge. The Worker cannot author code diffs itself: "open a change" means opening a
// structured GitHub PR describing the finding+lane for a human/Claude session to fill in;
// the auto-merge machinery exists and is exercised by tests but stays inert until armed.
import type { RtEnv } from "../registry";
import { TOOL_ANNOTATIONS } from "../registry";
import { type FeedbackEntry, type FeedbackKind, readFeedback } from "./_feedback";
import { githubAuthHeaders } from "../github-auth";

// ── Gate predicates (pure env, fail-closed) ──────────────────────────────────

/** Hard stop: any truthy SELF_IMPROVE_KILL halts the entire tick. Checked before enable. */
export const isKilled = (env: RtEnv): boolean => !!env.SELF_IMPROVE_KILL;

/** Master enable — default OFF. Killed always wins, so a tripped kill overrides enable. */
export const hasSelfImprove = (env: RtEnv): boolean => !!env.SELF_IMPROVE_ENABLE && !isKilled(env);

/** May open a PR: enabled + a GitHub token + the explicit PR opt-in. Else review-only. */
export const canOpenPr = (env: RtEnv): boolean => hasSelfImprove(env) && !!env.GITHUB_TOKEN && env.SELF_IMPROVE_PR === "on";

/** Auto-merge armed: canOpenPr + the explicit 'armed' sentinel (not merely truthy). */
export const isArmed = (env: RtEnv): boolean => canOpenPr(env) && env.SELF_IMPROVE_ARM === "armed";

// ── Rate cap (compile-time literal — the loop cannot raise it) ────────────────
// A const, deliberately NOT read from env or KV: the loop reads this number and writes
// only the per-day KV counter, so no code path (and no injected KV value) can lift the cap.
const SELF_IMPROVE_DAILY_CAP = 3;

const CURSOR_KEY = "sux:selfimprove:cursor";
const COUNT_PREFIX = "sux:selfimprove:count:";
const FINDINGS_KEY = "sux:selfimprove:findings";
const FINDINGS_CAP = 200;
const COUNTER_TTL_SECONDS = 60 * 60 * 48; // two days — a day-counter needs no longer

const DEFAULT_REPO = "colinxs/sux";

// ── Lane classifier ──────────────────────────────────────────────────────────
export type Lane = "security" | "feature" | "fix" | "refactor" | "cleanup";

// The ONLY lanes an armed loop may auto-merge. Security + feature are never in here.
const AUTO_MERGE_LANES: ReadonlySet<Lane> = new Set<Lane>(["fix", "refactor", "cleanup"]);

const SECURITY_RE = /\b(auth|token|secret|inject|injection|leak|credential|password|cve|rce|ssrf|xss|csrf|vuln|exploit|exfil|bypass)\b/i;
const FEATURE_RE = /\b(add|support|new|feature|would be nice|wish|please|allow|option to|ability to|enhance)\b/i;
const CLEANUP_RE = /\b(dead code|unused|duplicate|dupe|cleanup|clean up|remove|stale|leftover|redundant)\b/i;
const REFACTOR_RE = /\b(slow|perf|performance|refactor|simplify|optimi[sz]e|tidy|reorgani[sz]e)\b/i;
const FIX_RE = /\b(wrong|crash|error|broken|broke|fail|failed|failing|bug|500|regression|throws?|exception|incorrect)\b/i;

export type Finding = {
	lane: Lane;
	reason: string;
	text: string;
	at: number;
	kind: FeedbackKind;
	tool?: string;
};

/**
 * Derive a lane from a feedback entry: its `tool` tag (via TOOL_ANNOTATIONS) plus a
 * keyword heuristic over the text. Ordering encodes the safety bias:
 *   1. security keywords win outright (even if the text also asks to "add" something);
 *   2. suggest-kind or feature language ⇒ feature (PR-only);
 *   3. cleanup / refactor language ⇒ those lanes (auto-mergeable when armed);
 *   4. fix language ⇒ fix (auto-mergeable when armed);
 *   5. anything left ambiguous ⇒ security ⇒ PR-only (never auto-merge on a guess).
 * TOOL_ANNOTATIONS gives read/write/destructive but NOT security — security is derived
 * purely from the classifier here, never assumed from an annotation.
 */
export function classifyLane(env: RtEnv, entry: FeedbackEntry): { lane: Lane; reason: string } {
	const text = String(entry.text ?? "");
	const ann = entry.tool ? TOOL_ANNOTATIONS[entry.tool] : undefined;
	const touchesWrite = ann ? ann.readOnlyHint === false : false;

	if (SECURITY_RE.test(text)) return { lane: "security", reason: "security keyword in feedback text" };
	if (entry.kind === "suggest" || FEATURE_RE.test(text)) return { lane: "feature", reason: entry.kind === "suggest" ? "suggest-kind feedback" : "feature-request language" };
	if (CLEANUP_RE.test(text)) return { lane: "cleanup", reason: "cleanup language" };
	if (REFACTOR_RE.test(text)) return { lane: "refactor", reason: "refactor/perf language" };
	if (FIX_RE.test(text)) return { lane: "fix", reason: touchesWrite ? "fix language on a write tool" : "fix language" };
	// Ambiguous — bias to the safest always-PR lane rather than risk an auto-merge.
	return { lane: "security", reason: "ambiguous — defaulted to security (PR-only) for safety" };
}

function buildFinding(env: RtEnv, entry: FeedbackEntry): Finding {
	const { lane, reason } = classifyLane(env, entry);
	return { lane, reason, text: String(entry.text ?? ""), at: entry.at, kind: entry.kind, ...(entry.tool ? { tool: entry.tool } : {}) };
}

// ── GitHub PR / merge client (all outward calls; gated by the predicates above) ─
// Net-new GitHub API surface (git/refs + /pulls + check-runs + /merge). Uses
// githubAuthHeaders so the token is host-restricted and never leaks off github.com.
// The real client makes real calls but is ONLY constructed+invoked behind the gates;
// tests inject a fake to assert routing WITHOUT touching the network.
export interface GithubClient {
	/** Open a PR carrying the finding; returns the PR number + head commit sha. */
	openPr(finding: Finding): Promise<{ number: number; sha: string }>;
	/** True only when the head sha has ≥1 completed check and ALL conclude success. */
	checkRunsGreen(sha: string): Promise<boolean>;
	/** Merge the PR (auto-merge lanes only, only when armed + green). */
	mergePr(prNumber: number): Promise<void>;
}

const GH_API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "sux-self-improve", "X-GitHub-Api-Version": "2022-11-28" };

async function ghFetch(env: RtEnv, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN absent — self-improve GitHub calls are dormant.");
	const url = `${GH_API}${path}`;
	const resp = await fetch(url, {
		method,
		headers: { ...GH_HEADERS, ...githubAuthHeaders(env, url), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(30_000),
	});
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

/** The production GitHub client. Repo from SELF_IMPROVE_REPO (default the sux repo). */
export function githubClient(env: RtEnv): GithubClient {
	const repo = String(env.SELF_IMPROVE_REPO ?? "").trim() || DEFAULT_REPO;
	const base = `/repos/${repo}`;
	const branchName = (f: Finding) => `self-improve/${f.lane}-${f.at}`;
	return {
		async openPr(finding) {
			// Resolve the default branch, snapshot its tree into an empty tracking commit,
			// point a new branch at it, and open a PR. The commit carries NO code change —
			// a human/Claude session pushes the actual fix onto the branch; the loop only
			// files the finding. It never writes the repo's workflow/CI files.
			const meta = await ghFetch(env, "GET", base);
			if (meta.status >= 400) throw new Error(`self-improve: repo lookup failed HTTP ${meta.status}`);
			const baseBranch = String(meta.json?.default_branch ?? "main");
			const ref = await ghFetch(env, "GET", `${base}/git/ref/heads/${baseBranch}`);
			if (ref.status >= 400) throw new Error(`self-improve: base ref failed HTTP ${ref.status}`);
			const baseSha = String(ref.json?.object?.sha ?? "");
			const baseCommit = await ghFetch(env, "GET", `${base}/git/commits/${baseSha}`);
			if (baseCommit.status >= 400) throw new Error(`self-improve: base commit failed HTTP ${baseCommit.status}`);
			const treeSha = String(baseCommit.json?.tree?.sha ?? "");
			const commit = await ghFetch(env, "POST", `${base}/git/commits`, { message: `self-improve(${finding.lane}): ${finding.text.slice(0, 72)}`, tree: treeSha, parents: [baseSha] });
			if (commit.status >= 400) throw new Error(`self-improve: commit failed HTTP ${commit.status}`);
			const headSha = String(commit.json?.sha ?? "");
			const branch = branchName(finding);
			const newRef = await ghFetch(env, "POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: headSha });
			if (newRef.status >= 400) throw new Error(`self-improve: branch create failed HTTP ${newRef.status}`);
			const pr = await ghFetch(env, "POST", `${base}/pulls`, {
				title: `self-improve(${finding.lane}): ${finding.text.slice(0, 72)}`,
				head: branch,
				base: baseBranch,
				body: prBody(finding),
			});
			if (pr.status >= 400) throw new Error(`self-improve: PR open failed HTTP ${pr.status}`);
			return { number: Number(pr.json?.number), sha: headSha };
		},
		async checkRunsGreen(sha) {
			const runs = await ghFetch(env, "GET", `${base}/commits/${sha}/check-runs`);
			if (runs.status >= 400) return false;
			const list: any[] = Array.isArray(runs.json?.check_runs) ? runs.json.check_runs : [];
			// No checks, or any non-success/incomplete run ⇒ NOT green. Never merge on
			// unknown/pending/failing — a red auto-merge to main is the one unrecoverable failure.
			if (list.length === 0) return false;
			return list.every((r) => r?.status === "completed" && r?.conclusion === "success");
		},
		async mergePr(prNumber) {
			const r = await ghFetch(env, "PUT", `${base}/pulls/${prNumber}/merge`, { merge_method: "squash" });
			if (r.status >= 400) throw new Error(`self-improve: merge failed HTTP ${r.status}`);
		},
	};
}

function prBody(f: Finding): string {
	return [
		`Auto-filed by the sux self-improvement loop.`,
		``,
		`- **lane**: ${f.lane}`,
		`- **why**: ${f.reason}`,
		f.tool ? `- **tool**: ${f.tool}` : ``,
		`- **kind**: ${f.kind}`,
		``,
		`> ${f.text}`,
		``,
		`This branch has no code change yet — a maintainer/Claude session authors the fix on it.`,
	].filter(Boolean).join("\n");
}

// ── Review-only findings log (internal KV record; never an outward action) ────
function safeParse(s: string | null): Finding[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

async function recordFinding(env: RtEnv, finding: Finding): Promise<void> {
	const items = safeParse(await env.OAUTH_KV.get(FINDINGS_KEY));
	items.unshift(finding);
	if (items.length > FINDINGS_CAP) items.length = FINDINGS_CAP;
	await env.OAUTH_KV.put(FINDINGS_KEY, JSON.stringify(items));
}

/** Read the internal review-only findings log (newest first). Not an outward action. */
export async function readFindings(env: RtEnv, limit = 50): Promise<Finding[]> {
	return safeParse(await env.OAUTH_KV.get(FINDINGS_KEY)).slice(0, Math.max(0, limit));
}

// ── Rate cap: read the const, write only the KV day-counter ───────────────────
const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** Consume one unit of today's outward budget. False (skip) once the const cap is hit. */
async function tryConsumeCap(env: RtEnv): Promise<boolean> {
	const key = `${COUNT_PREFIX}${utcDay()}`;
	const n = Number(await env.OAUTH_KV.get(key)) || 0;
	if (n >= SELF_IMPROVE_DAILY_CAP) return false;
	await env.OAUTH_KV.put(key, String(n + 1), { expirationTtl: COUNTER_TTL_SECONDS });
	return true;
}

// ── Routing (safety enforced structurally by control flow) ────────────────────
export type TickResult = {
	dormant: boolean;
	reason: string;
	processed: number;
	prs: number;
	merges: number;
	skipped: number;
	error?: string;
};

/**
 * Route one finding. The merge call is reachable ONLY from the fix/refactor/cleanup
 * branch, ONLY inside the isArmed() guard, ONLY when CI is green — so an unarmed loop
 * (or any security/feature finding, even armed) can at most open a PR. Security + feature
 * return before the merge branch is ever entered.
 */
async function routeFinding(env: RtEnv, finding: Finding, github: GithubClient, result: TickResult): Promise<void> {
	if (!canOpenPr(env)) return; // review-only: recordFinding already ran; open nothing outward.

	// SECURITY + FEATURE lanes: PR only. No arm check, no mergePr in scope here.
	if (!AUTO_MERGE_LANES.has(finding.lane)) {
		if (!(await tryConsumeCap(env))) {
			result.skipped++;
			return;
		}
		await github.openPr(finding);
		result.prs++;
		return;
	}

	// FIX / REFACTOR / CLEANUP: open the PR, then auto-merge ONLY if armed AND CI is green.
	if (!(await tryConsumeCap(env))) {
		result.skipped++;
		return;
	}
	const pr = await github.openPr(finding);
	result.prs++;
	if (isArmed(env) && (await github.checkRunsGreen(pr.sha))) {
		if (!(await tryConsumeCap(env))) {
			result.skipped++;
			return;
		}
		await github.mergePr(pr.number);
		result.merges++;
	}
}

// ── The tick (rides index.ts scheduled(), beside maintenanceTick) ─────────────
export async function selfImproveTick(env: RtEnv, deps: { github?: GithubClient } = {}): Promise<TickResult> {
	const result: TickResult = { dormant: false, reason: "", processed: 0, prs: 0, merges: 0, skipped: 0 };
	try {
		// Kill wins over everything — checked before enable and before any feedback read.
		if (isKilled(env)) {
			result.dormant = true;
			result.reason = "killed";
			return result;
		}
		// Master enable unset ⇒ whole loop inert (ships dormant). No feedback read, no record.
		if (!hasSelfImprove(env)) {
			result.dormant = true;
			result.reason = "disabled";
			return result;
		}
		const github = deps.github ?? githubClient(env);
		result.reason = canOpenPr(env) ? (isArmed(env) ? "armed" : "pr-only") : "review-only";

		const cursor = Number(await env.OAUTH_KV.get(CURSOR_KEY)) || 0;
		// Idempotent: only entries strictly newer than the cursor, oldest-first so the
		// cursor advances monotonically. A re-run (double/overlapping cron fire) sees the
		// advanced cursor and re-opens nothing.
		const fresh = (await readFeedback(env, undefined, 500)).filter((e) => e.at > cursor).sort((a, b) => a.at - b.at);
		let maxAt = cursor;
		for (const entry of fresh) {
			const finding = buildFinding(env, entry);
			await recordFinding(env, finding); // review-only record — always, regardless of outward gating.
			try {
				await routeFinding(env, finding, github, result);
			} catch (e) {
				console.warn(`sux self-improve: routing '${entry.text.slice(0, 60)}' failed: ${String((e as Error)?.message ?? e)}`);
			}
			result.processed++;
			// Advance past every ATTEMPTED entry (even a failed route) so a poison entry
			// can't wedge the loop into re-opening the same PRs every day.
			if (entry.at > maxAt) maxAt = entry.at;
		}
		if (maxAt > cursor) await env.OAUTH_KV.put(CURSOR_KEY, String(maxAt));
	} catch (e) {
		// Never throw out of the tick — it rides ctx.waitUntil beside maintenanceTick.
		result.error = String((e as Error)?.message ?? e);
		console.warn(`sux self-improve tick error: ${result.error}`);
	}
	return result;
}
