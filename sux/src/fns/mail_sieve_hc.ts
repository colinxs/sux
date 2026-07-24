import { type Fn, fail, ok } from "../registry";
import { ALL_DOMAIN_CATEGORIES, tryCompileHighConfidenceSieve } from "./_domain_labels";
import { oj } from "./_util";

// mail_sieve_hc — generates the HIGH-CONFIDENCE sender-domain Sieve (the second consumer of the
// shared _domain_labels source; mail_domain_backfill is the first). Same generate-and-paste floor
// and reversible-tag philosophy as mail_sieve: TEXT ONLY — this fn makes no JMAP calls and installs
// nothing (Sieve/rule writes are a gated, lasting-effect class; docs/proposals/jmap.md D5). It tags
// mail at Fastmail delivery time by FROM domain with addflag only (never fileinto/discard/reject, so
// every message still reaches the inbox), covering brand groups (finance/shopping/travel/…),
// hierarchical education (edu + uw + dept, from an explicit allowlist), and gov/mil. Paste the output into
// Fastmail Settings → Rules → Edit custom Sieve code by hand; mail_domain_backfill applies the
// IDENTICAL rules to mail that already exists.
export const mail_sieve_hc: Fn = {
	name: "mail_sieve_hc",
	surface: "leaf",
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		`Generate a high-confidence sender-domain Sieve script that tags mail at Fastmail delivery time by FROM domain — addflag only (never fileinto/discard/reject, so every message still reaches the inbox). Covers curated FIRST-PARTY brand groups (finance, shopping, travel, shipping, dev, tech, social, news, health — ESP/relay infra deliberately excluded), HIERARCHICAL education (edu + uw + department, e.g. cs.uw.edu → edu,uw,cs, from an explicit department allowlist — an unrecognized UW subdomain degrades to edu,uw rather than inventing a department), and gov/mil. Pass \`categories\` to narrow it (default: all — ${ALL_DOMAIN_CATEGORIES.join(", ")}). Output is TEXT ONLY: this fn never calls JMAP or installs anything — copy the script into Fastmail Settings → Rules → Edit custom Sieve code yourself. To label mail that ALREADY exists (a live Sieve only tags new deliveries), use mail_domain_backfill, which applies the identical rules.`,
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			categories: {
				type: "array",
				items: { type: "string", enum: [...ALL_DOMAIN_CATEGORIES] },
				description: `Which rule blocks to include (default: all). One of ${ALL_DOMAIN_CATEGORIES.join(", ")} ("education" gates the edu/uw/dept cascade).`,
			},
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const categories = Array.isArray(args?.categories) ? args.categories.map(String) : undefined;
		const res = tryCompileHighConfidenceSieve(categories);
		if (!res.ok) return fail(res.error);
		return ok(oj({ script: res.script, categories: res.categories, rule_count: res.rule_count, brand_domains: res.brand_domains, note: "TEXT ONLY — paste into Fastmail Settings → Rules → Edit custom Sieve code; sux never installs this for you. Use mail_domain_backfill to label existing mail with the same rules." }));
	},
};
