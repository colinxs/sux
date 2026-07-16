import { type Fn, fail, failWith, ok } from "../registry";
import { errMsg, fetchTextOk, isHttpUrl, oj, sha256Hex } from "./_util";

/** SHA-256 hex of a UTF-8 string. */
async function sha256Text(s: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(s));
}

/** Result of fetching pipeline state: either a JSON string (+ which resources hit the
 *  per_page cap and may have more beyond it) or an error message. `truncated` is reported
 *  out-of-band rather than folded into `data` — it must never affect the hash, or a page-cap
 *  flag flipping on its own would report a spurious `changed:true`. */
type PipelineResult = { success: true; data: string; truncated: string[] } | { success: false; error: string };

const PER_PAGE = 30;

/** A 403/429 from the GitHub API is almost always rate-limiting, not a real upstream error —
 *  surface the reset/retry hint from the response headers instead of a bare status code. */
function rateLimitMessage(res: Response): string | undefined {
	if (res.status !== 403 && res.status !== 429) return undefined;
	const retryAfter = res.headers.get("retry-after");
	const remaining = res.headers.get("x-ratelimit-remaining");
	const reset = res.headers.get("x-ratelimit-reset");
	if (retryAfter) return `GitHub API rate limited: retry after ${retryAfter}s.`;
	if (remaining === "0" && reset) return `GitHub API rate limited: resets at ${new Date(Number(reset) * 1000).toISOString()}.`;
	return undefined;
}

/**
 * Fetch PRs, issues, and workflow runs for a repository, combine into a state
 * snapshot, and hash it. Returns JSON with activity changes.
 */
async function fetchPipelineState(owner: string, repo: string, token?: string): Promise<PipelineResult> {
	const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
	const headers: HeadersInit = {
		Accept: "application/vnd.github.v3+json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const state: Record<string, unknown> = {};
	const truncated: string[] = [];

	try {
		// Fetch PRs (open + recent closed) — required
		const prsRes = await fetch(`${baseUrl}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`, { headers });
		if (!prsRes.ok) {
			return { success: false, error: rateLimitMessage(prsRes) ?? `GitHub API error: ${prsRes.status} ${prsRes.statusText}` };
		}
		const prs = await prsRes.json();
		state.pull_requests = prs;
		if (Array.isArray(prs) && prs.length === PER_PAGE) truncated.push("pull_requests");

		// Fetch issues (open + recent closed) — required. GitHub's /issues endpoint also
		// returns pull requests (distinguished by a `pull_request` field on each item), so
		// filter those out or PR activity double-counts against `pull_requests` above and can
		// push real issue updates out of the top-PER_PAGE window.
		const issuesRes = await fetch(`${baseUrl}/issues?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`, { headers });
		if (!issuesRes.ok) {
			return { success: false, error: rateLimitMessage(issuesRes) ?? `GitHub API error: ${issuesRes.status} ${issuesRes.statusText}` };
		}
		const issuesRaw = await issuesRes.json();
		state.issues = Array.isArray(issuesRaw) ? issuesRaw.filter((item: any) => item?.pull_request == null) : issuesRaw;
		if (Array.isArray(issuesRaw) && issuesRaw.length === PER_PAGE) truncated.push("issues");

		// Fetch workflow runs (recent) — optional. `sort` isn't a documented query param for
		// this endpoint (results are already newest-first); dropped rather than silently ignored.
		try {
			const actionsRes = await fetch(`${baseUrl}/actions/runs?per_page=${PER_PAGE}`, { headers });
			if (actionsRes.ok) {
				const actions = (await actionsRes.json()) as { workflow_runs?: unknown[] };
				state.actions = actions;
				if (Array.isArray(actions?.workflow_runs) && actions.workflow_runs.length === PER_PAGE) truncated.push("actions");
			}
		} catch {
			// Actions not available or disabled
		}
	} catch (e) {
		return { success: false, error: `Failed to fetch pipeline state: ${errMsg(e)}` };
	}

	// Serialize to consistent JSON string for hashing
	return { success: true, data: JSON.stringify(state, null, 0), truncated };
}

export const watch_pipeline: Fn = {
	name: "watch_pipeline",
	description:
		"Detect whether a GitHub repository's pipeline resources (PRs, issues, GitHub Actions) have changed since the last check. Fetches pull requests, issues, and workflow runs from the GitHub API, combines their state, SHA-256 hashes it, and compares to the last-seen hash stored in KV (namespaced by owner/repo). First check records the hash (first_seen:true, changed:false); later checks report changed=true if the hash differs and update it. Returns JSON {owner, repo, changed, first_seen, hash, previous_hash?, truncated?, checked_at}. `truncated` (when present) lists which resources hit the 30-item page cap — there may be more activity than was checked. Requires GitHub token for authentication (recommended for rate limits). Stateful — never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["owner", "repo"],
		properties: {
			owner: { type: "string", description: "GitHub owner/organization name." },
			repo: { type: "string", description: "GitHub repository name." },
			token: {
				type: "string",
				description: "Optional GitHub personal access token or OAuth token for higher rate limits and private repos.",
			},
		},
	},
	cacheable: false,
	run: async (env, args) => {
		try {
			const owner = String(args?.owner ?? "");
			const repo = String(args?.repo ?? "");
			const token = args?.token != null ? String(args.token) : undefined;

			if (!owner || !repo) {
				return failWith("bad_input", "Provide both owner and repo.");
			}

			// Validate owner and repo are alphanumeric + dash/underscore (basic sanity check)
			if (!/^[a-z0-9._-]+$/i.test(owner) || !/^[a-z0-9._-]+$/i.test(repo)) {
				return failWith("bad_input", "Invalid owner or repo name.");
			}

			const result = await fetchPipelineState(owner, repo, token);
			if (!result.success) {
				return failWith("upstream_error", result.error);
			}

			const hash = await sha256Text(result.data);
			const keyId = await sha256Text(`${owner}/${repo}`);
			const kvKey = `sux:watch_pipeline:${keyId}`;

			const previous = await env.OAUTH_KV.get(kvKey);
			const firstSeen = previous === null;
			const changed = !firstSeen && hash !== previous;

			// Store the new hash whenever it differs
			if (firstSeen || changed) {
				await env.OAUTH_KV.put(kvKey, hash);
			}

			const out: Record<string, unknown> = {
				owner,
				repo,
				changed,
				first_seen: firstSeen,
				hash,
				...(firstSeen ? {} : { previous_hash: previous }),
				...(result.truncated.length ? { truncated: result.truncated } : {}),
				checked_at: new Date().toISOString(),
			};
			const response = ok(oj(out));
			response.noCache = true; // stateful: the stored hash mutates each check
			return response;
		} catch (e) {
			return fail(`watch_pipeline failed: ${errMsg(e)}`);
		}
	},
};
