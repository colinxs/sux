import { type Fn, fail, ok } from "../registry";
import { appendFeedback } from "./_feedback";
import { fileFeedbackIssue } from "./_feedback_issue";

export const issue: Fn = {
	name: "issue",
	description:
		"Report a bug with the sux server. Files a real, buildable GitHub `bug` issue directly (the build pipeline can then act on it), deduped by title and daily-capped so it can't spam; also appended to the server-side feedback log (KV, readable at GET /feedback?type=issue, public+unauthenticated). Use when a tool errors, returns wrong output, or a capability is missing. Text is PII-redacted (emails/phones/SSNs/etc.) before it leaves the worker — don't rely on it for anything verbatim, and don't rely on redaction as your only safeguard. Pair of `suggest`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The problem, concisely — what tool, what happened, expected vs actual." },
			tool: { type: "string", description: "Optional: the sux tool name the issue is about (tags the issue + enables GET /feedback?tool= filtering)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide `text` describing the issue.");
		const tool = String(args?.tool ?? "").trim() || undefined;
		// Always keep the KV audit log (GET /feedback compat + a local record even if GitHub filing fails).
		const { total } = await appendFeedback(env, "issue", text, tool);
		// File a real, buildable GitHub issue directly (#1423). Degrades to KV-only when dormant.
		const filed = await fileFeedbackIssue(env, "issue", text, tool);
		switch (filed.status) {
			case "filed":
				return ok(`Filed bug #${filed.number}${filed.created ? "" : " (existing — deduped)"}: ${filed.url}. Also logged issue #${total} to KV.`);
			case "capped":
				return ok(`Daily GitHub-issue cap reached — logged issue #${total} to KV only (GET /feedback?type=issue).`);
			case "error":
				return ok(`Logged issue #${total} to KV; GitHub filing failed (${filed.detail}) — a scheduled sweep will retry.`);
			default: // dormant
				return ok(`Logged issue #${total} to KV (GitHub filing dormant — no GITHUB_TOKEN). Read the backlog: GET /feedback?type=issue`);
		}
	},
};
