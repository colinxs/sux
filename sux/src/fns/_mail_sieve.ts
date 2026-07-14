// Compiles a curated, OBJECTIVE subset of _mail_triage's classifyMessage rules into a Sieve
// script — the rung-0 "server-side deterministic filter" from docs/design/personal-agent-roadmap.md
// (W9). This is the "generate-and-paste" floor decided in docs/knowledge/product-vision-and-roadmap.md:
// sux never writes a live Sieve/rule via JMAP (that method class is gated under `allow_destroy` —
// see docs/proposals/jmap.md D5 — and installs a LASTING server-side effect sux cannot audit after
// the fact), so this module only ever produces TEXT for Colin to paste into Fastmail's own Sieve
// editor by hand.
//
// Two design constraints carried over from the in-Worker classifier's safety invariants:
//  1. TAG, NEVER HIDE — every rule ends in `addflag`, never `fileinto`/`discard`/`reject`. A false
//     positive costs a stray IMAP keyword, never a message vanishing from the inbox. The Sieve
//     implicit `keep` still delivers to INBOX when no fileinto/discard fires, so this holds by
//     construction (no rule below ever calls those verbs).
//  2. COARSE ON PURPOSE — classifyMessage's JS regexes encode nuance (sensitive-sender guards,
//     personal-domain gating, confidence tiers) that has no Sieve equivalent pre-delivery. Only the
//     rules whose triggering signal is a SENDER match or a short literal-substring subject/header
//     cue (safe to over-fire — worst case is an extra keyword) are compiled. Everything ambiguous
//     (transaction/receipt/important/personal) stays a Worker-side, full-context decision.
import { errMsg } from "./_util";

export type SieveCategory = "junk" | "mailing_list" | "service_notification" | "notification";

export const ALL_SIEVE_CATEGORIES: readonly SieveCategory[] = ["junk", "mailing_list", "service_notification", "notification"];

/** A single Sieve rule: a boolean test expression (already Sieve syntax, `anyof [...]` etc.) and the
 *  IMAP keyword(s) it applies via `addflag` when the test matches. One rule per `if` block. */
type SieveRule = { category: SieveCategory; comment: string; test: string; flags: string[] };

const q = (s: string): string => JSON.stringify(s); // Sieve string literals are double-quoted; JSON's quoting/escaping is a superset-safe match for the ASCII cues used here.
const qlist = (items: string[]): string => `[${items.map(q).join(", ")}]`;

// Mirrors _mail_triage.ts JUNK_SUBJECT — literal substrings only (Sieve `:contains` has no regex/
// word-boundary support), so entries here are the least-ambiguous tokens from that pattern.
const JUNK_SUBJECT_CUES = ["lottery", "you won", "claim your prize", "viagra", "nigerian prince", "wire transfer", "risk-free", "100% free", "crypto giveaway"];

// Mirrors _mail_triage.ts MAILING_LIST_FROM — bulk-sender local-parts. `List-Unsubscribe` is a
// stronger, header-based signal RFC 2369 mail clients set that classifyMessage doesn't check (it
// only sees search-result preview text) — included here because Sieve CAN see full headers.
const MAILING_LIST_FROM_CUES = ["newsletter", "no-reply", "noreply", "news@", "updates@", "hello@", "team@", "marketing@", "list@", "announce@"];

// Mirrors _mail_triage.ts SERVICE_SENDERS — domain suffix match, one keyword per known service.
const SERVICE_SENDERS: Array<{ domain: string; flag: string }> = [
	{ domain: "github.com", flag: "gh" },
	{ domain: "gitlab.com", flag: "gitlab" },
	{ domain: "vercel.com", flag: "vercel" },
	{ domain: "circleci.com", flag: "ci" },
];

// Mirrors _mail_triage.ts NOTIFY_FROM's non-overlapping remainder (service senders above already
// claim github/gitlab/vercel/circleci, so this is the generic automated-sender catch-all).
const NOTIFY_FROM_CUES = ["no-reply", "noreply", "do-not-reply", "donotreply", "notifications@", "automated@"];

function buildRules(categories: readonly SieveCategory[]): SieveRule[] {
	const rules: SieveRule[] = [];
	const want = new Set(categories);
	if (want.has("junk")) {
		rules.push({
			category: "junk",
			comment: "Obvious spam-signal subject cues (mirrors _mail_triage JUNK_SUBJECT, literal substrings only).",
			test: `header :contains "subject" ${qlist(JUNK_SUBJECT_CUES)}`,
			flags: ["junk"],
		});
	}
	if (want.has("mailing_list")) {
		rules.push({
			category: "mailing_list",
			comment: "RFC 2369 List-Unsubscribe header present — the strongest objective bulk-mail signal, not available to the Worker-side classifier (search previews carry no headers).",
			test: `exists "list-unsubscribe"`,
			flags: ["mailing-list"],
		});
		rules.push({
			category: "mailing_list",
			comment: "Bulk-sender local-part cues (mirrors _mail_triage MAILING_LIST_FROM).",
			test: `address :contains :all "from" ${qlist(MAILING_LIST_FROM_CUES)}`,
			flags: ["mailing-list"],
		});
	}
	if (want.has("service_notification")) {
		for (const svc of SERVICE_SENDERS) {
			rules.push({
				category: "service_notification",
				comment: `${svc.domain} service notifications (mirrors _mail_triage SERVICE_SENDERS; Sieve can't see subject-cue subtypes without full headers, so this applies the coarse "${svc.flag}" tag only — the Worker classifier still refines it).`,
				test: `address :domain :is "from" ${q(svc.domain)}`,
				flags: [svc.flag],
			});
		}
	}
	if (want.has("notification")) {
		rules.push({
			category: "notification",
			comment: "Generic automated-sender cues (mirrors _mail_triage NOTIFY_FROM's non-service remainder).",
			test: `address :contains :all "from" ${qlist(NOTIFY_FROM_CUES)}`,
			flags: ["notification"],
		});
	}
	return rules;
}

/** Compile the requested categories (default: all) into a Sieve script. Pure — no I/O, no JMAP.
 *  Every generated rule ends in `addflag` only; the Sieve implicit `keep` (no fileinto/discard/
 *  reject anywhere in the output) means every message still lands in the inbox, tagged. Throws on
 *  an unknown category name so a typo in the fn's `categories` arg fails loud, not silently-empty. */
export function compileSieve(categories?: readonly string[]): { script: string; categories: SieveCategory[]; rule_count: number } {
	const requested = categories && categories.length ? categories : ALL_SIEVE_CATEGORIES;
	const invalid = requested.filter((c) => !ALL_SIEVE_CATEGORIES.includes(c as SieveCategory));
	if (invalid.length) throw new Error(`unknown sieve categor${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")} (valid: ${ALL_SIEVE_CATEGORIES.join(", ")})`);
	const cats = requested as SieveCategory[];
	const rules = buildRules(cats);

	const lines: string[] = [];
	lines.push('require ["imap4flags"];');
	lines.push("");
	lines.push("# Generated by sux mail_sieve — a coarse, rung-0 PRE-FILTER that runs at Fastmail delivery time,");
	lines.push("# before sux's Worker-side mail_triage ever sees the message. Tags only (addflag) — it NEVER");
	lines.push("# files into Junk, discards, or rejects, so every message still reaches the inbox. Paste this");
	lines.push("# into Fastmail Settings -> Rules -> Custom rule (Sieve) by hand; sux never installs it for you.");
	for (const r of rules) {
		lines.push("");
		lines.push(`# ${r.comment}`);
		lines.push(`if ${r.test} {`);
		for (const f of r.flags) lines.push(`    addflag "${f}";`);
		lines.push("}");
	}
	lines.push("");
	return { script: lines.join("\n"), categories: cats, rule_count: rules.length };
}

export function tryCompileSieve(categories?: readonly string[]): { ok: true; script: string; categories: SieveCategory[]; rule_count: number } | { ok: false; error: string } {
	try {
		return { ok: true, ...compileSieve(categories) };
	} catch (e) {
		return { ok: false, error: errMsg(e) };
	}
}
