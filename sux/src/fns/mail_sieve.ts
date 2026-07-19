import { type Fn, fail, ok } from "../registry";
import { ALL_SIEVE_CATEGORIES, tryCompileSieve } from "./_mail_sieve";
import { oj } from "./_util";

// mail_sieve — generates a rung-0 coarse pre-filter Sieve script (see docs/design/
// personal-agent-roadmap.md W9) from a curated, objective subset of _mail_triage's classifier
// rules. TEXT ONLY: this fn makes no JMAP calls and installs nothing — Sieve/rule methods are a
// gated, lasting-effect capability class (docs/proposals/jmap.md D5), and the decided floor
// (docs/knowledge/product-vision-and-roadmap.md) is "generate-and-paste; no dynamic filter write
// via token". Paste the output into Fastmail Settings -> Rules -> Custom rule (Sieve) by hand.
export const mail_sieve: Fn = {
	name: "mail_sieve",
	surface: "leaf",
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		`Generate a Sieve script that tags mail at Fastmail delivery time — before sux's Worker-side mail_triage ever runs — with the SAME reversible-tag philosophy (addflag only, never fileinto/discard/reject, so every message still reaches the inbox). Covers a curated, objective subset of _mail_triage's rules: junk-subject cues, promotional/marketing spam-subject cues, mailing-list signals (List-Unsubscribe header + bulk-sender cues), known dev/CI service senders (github/gitlab/vercel/circleci), and generic automated-sender notifications. Pass \`categories\` to narrow it (default: all — ${ALL_SIEVE_CATEGORIES.join(", ")}). Output is TEXT ONLY: this fn never calls JMAP or installs anything — copy the script into Fastmail Settings -> Rules -> Custom rule (Sieve) yourself.`,
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			categories: {
				type: "array",
				items: { type: "string", enum: [...ALL_SIEVE_CATEGORIES] },
				description: `Which rule categories to include (default: all). One of ${ALL_SIEVE_CATEGORIES.join(", ")}.`,
			},
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const categories = Array.isArray(args?.categories) ? args.categories.map(String) : undefined;
		const res = tryCompileSieve(categories);
		if (!res.ok) return fail(res.error);
		return ok(oj({ script: res.script, categories: res.categories, rule_count: res.rule_count, note: "TEXT ONLY — paste into Fastmail Settings -> Rules -> Custom rule (Sieve); sux never installs this for you." }));
	},
};
