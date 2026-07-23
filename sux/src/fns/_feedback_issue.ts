// Direct GitHub-issue filing for the `issue`/`suggest` fns (#1423). Previously both
// only appended to the KV feedback log (`_feedback.ts`), read solely by the self-improve
// cron's confidence-routing — so an explicit "file an issue" call could sit unfiled for a
// tick, get budget-capped, or never surface if self-improve was off. This files a REAL,
// buildable GitHub issue on invocation instead: `issue` → a `bug`, `suggest` → an
// `enhancement` (both labels the build pipeline selects), plus a `feedback` provenance
// marker. It deliberately does NOT use the `self-improve` label, so user-filed feedback
// never enters self-improve's autonomous PR-attempt pipeline (that stays #1116's concern).
//
// Guards against spam the same way self-improve's own LOW-finding path does: PII redaction,
// exact-title dedup against open feedback issues, and a per-kind daily cap. Degrades
// cleanly to the KV log when GITHUB_TOKEN is absent (dormant), so nothing regresses.
//
// The tiny ghFetch below is a deliberate ~10-line local copy rather than an export from the
// big, gated `_self_improve.ts` module — keeping user-feedback filing decoupled from the
// self-improve lifecycle is worth more than removing the duplication. It reuses the shared
// `githubAuthHeaders` (host-restricted token) so the auth surface is not duplicated.
import { githubAuthHeaders } from "../github-auth";
import type { RtEnv } from "../registry";
import type { FeedbackKind } from "./_feedback";
import { redactPII } from "./redact";

const GH_API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "sux-feedback", "X-GitHub-Api-Version": "2022-11-28" };
const DEFAULT_FEEDBACK_REPO = "SuxOS/sux";
const FEEDBACK_LABEL = "feedback";
// `issue` files a bug, `suggest` files a buildable enhancement — both are labels the
// issue-build pipeline selects, so a suggestion becomes actionable work, not a dead note.
const KIND_LABEL: Record<FeedbackKind, string> = { issue: "bug", suggest: "enhancement" };
// Per-kind cap on issues filed per UTC day — a recurring call can't spam the tracker.
const DAILY_CAP = 20;
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 4000;

export type FeedbackFiling =
	| { status: "filed"; number: number; created: boolean; url: string }
	| { status: "capped" }
	| { status: "dormant" }
	| { status: "error"; detail: string };

type Fetcher = typeof fetch;

async function ghFetch(env: RtEnv, method: string, path: string, body: unknown, fetchImpl: Fetcher): Promise<{ status: number; json: any }> {
	const url = `${GH_API}${path}`;
	const resp = await fetchImpl(url, {
		method,
		headers: { ...GH_HEADERS, ...githubAuthHeaders(env, url), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(30_000),
	});
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

/** Build a stable, deduplicable title. Tool tag (when present) makes same-tool reports
 *  collapse onto one open issue; the first line of the (redacted) text is the summary. */
function feedbackTitle(kind: FeedbackKind, text: string, tool?: string): string {
	const firstLine = text.split("\n")[0].trim().replace(/\s+/g, " ");
	const prefix = tool ? `${KIND_LABEL[kind]}(${tool})` : KIND_LABEL[kind];
	const title = `[${prefix}] ${firstLine}`;
	return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

function feedbackBody(kind: FeedbackKind, text: string, tool?: string): string {
	const via = kind === "issue" ? "`issue`" : "`suggest`";
	return [
		text,
		"",
		"---",
		`_Filed by the sux ${via} fn${tool ? ` about \`${tool}\`` : ""}. Text is PII-redacted at the source._`,
	].join("\n");
}

/** Per-UTC-day, per-kind cap counter in KV. Best-effort (no CAS) — feedback filing is
 *  low-frequency, so a rare lost increment just permits one extra file, never a hard error. */
async function underDailyCap(env: RtEnv, kind: FeedbackKind): Promise<{ ok: boolean; bump: () => Promise<void> }> {
	const day = new Date().toISOString().slice(0, 10);
	const key = `sux:feedback:filed:${kind}:${day}`;
	const n = Number((await env.OAUTH_KV.get(key)) ?? "0") || 0;
	return {
		ok: n < DAILY_CAP,
		bump: async () => {
			// 48h TTL so yesterday's counters self-evict; the day is in the key so it's a fresh count.
			await env.OAUTH_KV.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 });
		},
	};
}

/**
 * File a real GitHub issue for a feedback entry. Returns:
 *  - `dormant` when GITHUB_TOKEN is unset (caller keeps the KV log as the record),
 *  - `capped` when the per-kind daily cap is hit,
 *  - `filed` with `created:false` when an open feedback issue with the same title already
 *    exists (dedup — no cap spent), or `created:true` for a freshly opened issue,
 *  - `error` on an API failure (caller still has the KV log).
 */
export async function fileFeedbackIssue(env: RtEnv, kind: FeedbackKind, text: string, tool?: string, fetchImpl: Fetcher = fetch): Promise<FeedbackFiling> {
	if (!env.GITHUB_TOKEN) return { status: "dormant" };
	// Reuse self-improve's repo target (default the sux repo) — feedback issues land where the
	// build pipeline picks them up. No separate binding: keeps the RtEnv surface unchanged.
	const repo = String(env.SELF_IMPROVE_REPO ?? "").trim() || DEFAULT_FEEDBACK_REPO;
	const base = `/repos/${repo}`;
	const clean = redactPII(text).redacted.slice(0, MAX_BODY_CHARS);
	const title = feedbackTitle(kind, clean, tool);
	try {
		// Dedup: an OPEN feedback issue with the same title already tracks this — collapse onto
		// it (PRs share the /issues list and carry `pull_request`, so filter those out).
		const existing = await ghFetch(env, "GET", `${base}/issues?labels=${FEEDBACK_LABEL}&state=open&per_page=100`, undefined, fetchImpl);
		if (existing.status < 400 && Array.isArray(existing.json)) {
			const hit = existing.json.find((i: any) => !i?.pull_request && String(i?.title ?? "") === title);
			if (hit) return { status: "filed", number: Number(hit.number), created: false, url: String(hit.html_url ?? "") };
		}
		const cap = await underDailyCap(env, kind);
		if (!cap.ok) return { status: "capped" };
		const created = await ghFetch(env, "POST", `${base}/issues`, { title, body: feedbackBody(kind, clean, tool), labels: [KIND_LABEL[kind], FEEDBACK_LABEL] }, fetchImpl);
		if (created.status >= 400) return { status: "error", detail: `HTTP ${created.status}` };
		await cap.bump();
		return { status: "filed", number: Number(created.json?.number), created: true, url: String(created.json?.html_url ?? "") };
	} catch (e) {
		return { status: "error", detail: e instanceof Error ? e.message : String(e) };
	}
}
