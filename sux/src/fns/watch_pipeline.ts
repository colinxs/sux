import { type Fn, fail, failWith, ok } from "../registry";
import { fetchTextOk, isHttpUrl, sha256Hex, oj } from "./_util";

/** SHA-256 hex of a UTF-8 string. */
async function sha256Text(s: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(s));
}

/** Result of fetching pipeline state: either a JSON string or an error message. */
type PipelineResult = { success: true; data: string } | { success: false; error: string };

/**
 * Fetch GitHub merge queues, PRs, issues, and actions for a repository,
 * combine into a state snapshot, and hash it. Returns JSON with activity changes.
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

	try {
		// Fetch merge queue (if enabled) — optional
		try {
			const mqRes = await fetch(`${baseUrl}/queues`, { headers });
			if (mqRes.ok) {
				state.merge_queues = await mqRes.json();
			}
		} catch {
			// Merge queue not available or not enabled
		}

		// Fetch PRs (open + recent closed) — required
		const prsRes = await fetch(`${baseUrl}/pulls?state=all&sort=updated&direction=desc&per_page=30`, { headers });
		if (!prsRes.ok) {
			return { success: false, error: `GitHub API error: ${prsRes.status} ${prsRes.statusText}` };
		}
		state.pull_requests = await prsRes.json();

		// Fetch issues (open + recent closed) — required
		const issuesRes = await fetch(`${baseUrl}/issues?state=all&sort=updated&direction=desc&per_page=30`, { headers });
		if (!issuesRes.ok) {
			return { success: false, error: `GitHub API error: ${issuesRes.status} ${issuesRes.statusText}` };
		}
		state.issues = await issuesRes.json();

		// Fetch workflow runs (recent) — optional
		try {
			const actionsRes = await fetch(`${baseUrl}/actions/runs?per_page=30&sort=created`, { headers });
			if (actionsRes.ok) {
				state.actions = await actionsRes.json();
			}
		} catch {
			// Actions not available or disabled
		}
	} catch (e) {
		return { success: false, error: `Failed to fetch pipeline state: ${String((e as Error)?.message ?? e)}` };
	}

	// Serialize to consistent JSON string for hashing
	return { success: true, data: JSON.stringify(state, null, 0) };
}

export const watch_pipeline: Fn = {
	name: "watch_pipeline",
	description:
		"Detect whether a GitHub repository's pipeline resources (merge queues, PRs, issues, GitHub Actions) have changed since the last check. Fetches merge queues, pull requests, issues, and workflow runs from the GitHub API, combines their state, SHA-256 hashes it, and compares to the last-seen hash stored in KV (namespaced by owner/repo). First check records the hash (first_seen:true, changed:false); later checks report changed=true if the hash differs and update it. Returns JSON {owner, repo, changed, first_seen, hash, previous_hash?, checked_at}. Requires GitHub token for authentication (recommended for rate limits). Stateful — never cached.",
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
				checked_at: new Date().toISOString(),
			};
			const response = ok(oj(out));
			response.noCache = true; // stateful: the stored hash mutates each check
			return response;
		} catch (e) {
			return fail(`watch_pipeline failed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
