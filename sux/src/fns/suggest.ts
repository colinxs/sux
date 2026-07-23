import { type Fn, fail, ok } from "../registry";
import { appendFeedback } from "./_feedback";
import { fileFeedbackIssue } from "./_feedback_issue";

export const suggest: Fn = {
	name: "suggest",
	description:
		"Request a feature/capability for the sux server. Files a real, buildable GitHub `enhancement` issue directly (the build pipeline can then act on it), deduped by title and daily-capped so it can't spam; also appended to the server-side feedback log (KV, readable at GET /feedback?type=suggest, public+unauthenticated). Use when a tool is missing, an option would help, or a workflow would be nicer. Text is PII-redacted (emails/phones/SSNs/etc.) before it leaves the worker — don't rely on it for anything verbatim, and don't rely on redaction as your only safeguard. Pair of `issue`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The request, concisely — what capability is wanted and why it would help." },
			tool: { type: "string", description: "Optional: the sux tool name the request is about (tags the issue + enables GET /feedback?tool= filtering)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const text = String(args?.text ?? "").trim();
		if (!text) return fail("Provide `text` describing the request.");
		const tool = String(args?.tool ?? "").trim() || undefined;
		// Always keep the KV audit log (GET /feedback compat + a local record even if GitHub filing fails).
		const { total } = await appendFeedback(env, "suggest", text, tool);
		// File a real, buildable GitHub enhancement issue directly (#1423). Degrades to KV-only when dormant.
		const filed = await fileFeedbackIssue(env, "suggest", text, tool);
		switch (filed.status) {
			case "filed":
				return ok(`Filed enhancement #${filed.number}${filed.created ? "" : " (existing — deduped)"}: ${filed.url}. Also logged suggestion #${total} to KV.`);
			case "capped":
				return ok(`Daily GitHub-issue cap reached — logged suggestion #${total} to KV only (GET /feedback?type=suggest).`);
			case "error":
				return ok(`Logged suggestion #${total} to KV; GitHub filing failed (${filed.detail}) — a scheduled sweep will retry.`);
			default: // dormant
				return ok(`Logged suggestion #${total} to KV (GitHub filing dormant — no GITHUB_TOKEN). Read the backlog: GET /feedback?type=suggest`);
		}
	},
};
