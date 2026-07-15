// Compiles a curated, OBJECTIVE subset of _mail_triage's classifyMessage rules into a Sieve
// script — the rung-0 "server-side deterministic filter" from docs/design/personal-agent-roadmap.md
// (W9). This is the "generate-and-paste" floor decided in docs/knowledge/product-vision-and-roadmap.md:
// sux never writes a live Sieve/rule via JMAP (that method class is gated under `allow_destroy` —
// see docs/proposals/jmap.md D5 — and installs a LASTING server-side effect sux cannot audit after
// the fact), so this module only ever produces TEXT for Colin to paste into Fastmail's own Sieve
// editor by hand.
//
// Sieve only ever fires on NEW deliveries — it can't retroactively touch mail already sitting in
// the mailbox. `matchCoarseCategories` below is the SAME rule set expressed as a JS predicate, so
// `mail_sieve_backfill` (a one-time pass over EXISTING mail) can apply identical tags without a
// second, drift-prone copy of the cues.
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

/** A single coarse rule: the Sieve boolean-test expression (already Sieve syntax) used by
 *  `compileSieve`, AND a JS predicate over {from, subject, hasListUnsubscribe} used by
 *  `matchCoarseCategories` for the existing-mail backfill — one definition, two consumers, so the
 *  "runs on new mail" and "runs once over old mail" paths can never silently diverge. */
type CoarseRule = { category: SieveCategory; comment: string; sieveTest: string; flags: string[]; matches: (msg: CoarseMsg) => boolean };

/** The fields a backfill pass has available from `mail_search` results. `hasListUnsubscribe` is
 *  OPTIONAL — mail_search's preview payload carries no headers, so callers without header data
 *  (the default backfill path) simply never set it and that one rule never fires; a caller with
 *  header access (e.g. a future mail_read-backed pass) can supply it for full parity with Sieve. */
export type CoarseMsg = { from?: string; subject?: string; hasListUnsubscribe?: boolean };

const q = (s: string): string => JSON.stringify(s); // Sieve string literals are double-quoted; JSON's quoting/escaping is a superset-safe match for the ASCII cues used here.
const qlist = (items: string[]): string => `[${items.map(q).join(", ")}]`;
const containsAny = (hay: string, needles: string[]): boolean => needles.some((n) => hay.includes(n));

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

function allRules(): CoarseRule[] {
	const rules: CoarseRule[] = [];
	rules.push({
		category: "junk",
		comment: "Obvious spam-signal subject cues (mirrors _mail_triage JUNK_SUBJECT, literal substrings only).",
		sieveTest: `header :contains "subject" ${qlist(JUNK_SUBJECT_CUES)}`,
		flags: ["junk"],
		matches: (m) => containsAny(String(m.subject ?? "").toLowerCase(), JUNK_SUBJECT_CUES),
	});
	rules.push({
		category: "mailing_list",
		comment: "RFC 2369 List-Unsubscribe header present — the strongest objective bulk-mail signal, not available to the Worker-side classifier (search previews carry no headers).",
		sieveTest: `exists "list-unsubscribe"`,
		flags: ["mailing-list"],
		matches: (m) => m.hasListUnsubscribe === true,
	});
	rules.push({
		category: "mailing_list",
		comment: "Bulk-sender local-part cues (mirrors _mail_triage MAILING_LIST_FROM).",
		sieveTest: `address :contains :all "from" ${qlist(MAILING_LIST_FROM_CUES)}`,
		flags: ["mailing-list"],
		matches: (m) => containsAny(String(m.from ?? "").toLowerCase(), MAILING_LIST_FROM_CUES),
	});
	for (const svc of SERVICE_SENDERS) {
		rules.push({
			category: "service_notification",
			comment: `${svc.domain} service notifications (mirrors _mail_triage SERVICE_SENDERS; Sieve can't see subject-cue subtypes without full headers, so this applies the coarse "${svc.flag}" tag only — the Worker classifier still refines it).`,
			sieveTest: `address :domain :is "from" ${q(svc.domain)}`,
			flags: [svc.flag],
			matches: (m) => String(m.from ?? "").toLowerCase().includes(`@${svc.domain}`) || String(m.from ?? "").toLowerCase().includes(`.${svc.domain}`),
		});
	}
	rules.push({
		category: "notification",
		comment: "Generic automated-sender cues (mirrors _mail_triage NOTIFY_FROM's non-service remainder).",
		sieveTest: `address :contains :all "from" ${qlist(NOTIFY_FROM_CUES)}`,
		flags: ["notification"],
		matches: (m) => containsAny(String(m.from ?? "").toLowerCase(), NOTIFY_FROM_CUES),
	});
	return rules;
}

function validateCategories(categories?: readonly string[]): SieveCategory[] {
	const requested = categories && categories.length ? categories : ALL_SIEVE_CATEGORIES;
	const invalid = requested.filter((c) => !ALL_SIEVE_CATEGORIES.includes(c as SieveCategory));
	if (invalid.length) throw new Error(`unknown sieve categor${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")} (valid: ${ALL_SIEVE_CATEGORIES.join(", ")})`);
	return requested as SieveCategory[];
}

/** Compile the requested categories (default: all) into a Sieve script. Pure — no I/O, no JMAP.
 *  Every generated rule ends in `addflag` only; the Sieve implicit `keep` (no fileinto/discard/
 *  reject anywhere in the output) means every message still lands in the inbox, tagged. Throws on
 *  an unknown category name so a typo in the fn's `categories` arg fails loud, not silently-empty. */
export function compileSieve(categories?: readonly string[]): { script: string; categories: SieveCategory[]; rule_count: number } {
	const cats = validateCategories(categories);
	const want = new Set(cats);
	const rules = allRules().filter((r) => want.has(r.category));

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
		lines.push(`if ${r.sieveTest} {`);
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

/** Evaluate the SAME coarse rules against an already-fetched message (the `mail_sieve_backfill`
 *  one-time pass over EXISTING mail — Sieve itself only ever fires on new deliveries). Pure, no
 *  I/O. Returns the deduped set of flags every matching rule would `addflag`. */
export function matchCoarseCategories(msg: CoarseMsg, categories?: readonly string[]): string[] {
	const cats = validateCategories(categories);
	const want = new Set(cats);
	const flags = new Set<string>();
	for (const r of allRules()) {
		if (!want.has(r.category)) continue;
		if (r.matches(msg)) for (const f of r.flags) flags.add(f);
	}
	return [...flags];
}
