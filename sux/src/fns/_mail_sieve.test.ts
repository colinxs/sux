import { describe, expect, it } from "vitest";
import { ALL_SIEVE_CATEGORIES, compileSieve, matchCoarseCategories, tryCompileSieve } from "./_mail_sieve";

// Safety invariant this whole module exists to guarantee: every rule ADDS an IMAP keyword and
// NOTHING ELSE. If any of these verbs ever creep into the generator, a message could vanish from
// the inbox or bounce — the exact hiding behavior _mail_triage's classifier is designed to avoid.
const FORBIDDEN_VERBS = ["fileinto", "discard", "reject", "redirect", "vacation"];

describe("compileSieve — safety invariants", () => {
	it("never emits a hiding/destructive verb, for every category and the default (all)", () => {
		for (const cats of [undefined, ...ALL_SIEVE_CATEGORIES.map((c) => [c])]) {
			const { script } = compileSieve(cats as any);
			// Check actual Sieve statements only — explanatory `#` comments may use the English
			// words ("rejects", "discards") in prose without emitting the verb as executable code.
			const code = script
				.split("\n")
				.filter((l) => !l.trim().startsWith("#"))
				.join("\n")
				.toLowerCase();
			for (const verb of FORBIDDEN_VERBS) expect(code).not.toContain(verb);
		}
	});

	it("declares the imap4flags extension it uses", () => {
		const { script } = compileSieve();
		expect(script).toContain('require ["imap4flags"];');
	});

	it("throws on an unknown category rather than silently compiling an empty/partial script", () => {
		expect(() => compileSieve(["not_a_real_category"])).toThrow(/unknown sieve categor/i);
	});
});

describe("compileSieve — category coverage", () => {
	it("junk: emits a subject :contains test with addflag \"junk\"", () => {
		const { script, rule_count } = compileSieve(["junk"]);
		expect(script).toContain('header :contains "subject"');
		expect(script).toContain('addflag "junk";');
		expect(rule_count).toBe(1);
	});

	it("mailing_list: emits both the List-Unsubscribe exists test and the bulk-sender address test", () => {
		const { script, rule_count } = compileSieve(["mailing_list"]);
		expect(script).toContain('exists "list-unsubscribe"');
		expect(script).toContain('address :contains :all "from"');
		expect(script).toContain('addflag "mailing-list";');
		expect(rule_count).toBe(2);
	});

	it("service_notification: emits one domain rule per known service with its own flag", () => {
		const { script, rule_count } = compileSieve(["service_notification"]);
		for (const [domain, flag] of [
			["github.com", "gh"],
			["gitlab.com", "gitlab"],
			["vercel.com", "vercel"],
			["circleci.com", "ci"],
		]) {
			expect(script).toContain(`address :domain :is "from" "${domain}"`);
			expect(script).toContain(`addflag "${flag}";`);
		}
		expect(rule_count).toBe(4);
	});

	it("notification: emits the generic automated-sender address test", () => {
		const { script, rule_count } = compileSieve(["notification"]);
		expect(script).toContain('address :contains :all "from"');
		expect(script).toContain('addflag "notification";');
		expect(rule_count).toBe(1);
	});

	it("default (no categories passed) includes every category's rules", () => {
		const all = compileSieve();
		const summed = ALL_SIEVE_CATEGORIES.reduce((n, c) => n + compileSieve([c]).rule_count, 0);
		expect(all.rule_count).toBe(summed);
		expect(all.categories).toEqual([...ALL_SIEVE_CATEGORIES]);
	});

	it("narrowing to a subset omits the other categories' flags", () => {
		const { script } = compileSieve(["junk"]);
		expect(script).not.toContain('addflag "mailing-list"');
		expect(script).not.toContain('addflag "gh"');
		expect(script).not.toContain('addflag "notification"');
	});
});

describe("tryCompileSieve — non-throwing wrapper", () => {
	it("returns {ok:true, script} for a valid call", () => {
		const res = tryCompileSieve(["junk"]);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.script.length).toBeGreaterThan(0);
	});

	it("returns {ok:false, error} instead of throwing for an invalid category", () => {
		const res = tryCompileSieve(["bogus"]);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/unknown sieve categor/i);
	});
});

describe("matchCoarseCategories — backfill's JS mirror of the Sieve rules", () => {
	it("matches a junk-subject cue", () => {
		expect(matchCoarseCategories({ subject: "You WON the lottery! Claim your prize now" })).toContain("junk");
	});

	it("matches a bulk-sender mailing-list cue from `from`", () => {
		expect(matchCoarseCategories({ from: "newsletter@substack.com", subject: "Weekly roundup" })).toContain("mailing-list");
	});

	it("never sets the List-Unsubscribe rule without hasListUnsubscribe (no headers in a search preview)", () => {
		const flags = matchCoarseCategories({ from: "someone@example.com", subject: "hi" });
		expect(flags).not.toContain("mailing-list");
		expect(matchCoarseCategories({ from: "someone@example.com", subject: "hi", hasListUnsubscribe: true })).toContain("mailing-list");
	});

	it("matches each known service sender to its own flag", () => {
		expect(matchCoarseCategories({ from: "notifications@github.com" })).toContain("gh");
		expect(matchCoarseCategories({ from: "bot@gitlab.com" })).toContain("gitlab");
		expect(matchCoarseCategories({ from: "noreply@vercel.com" })).toContain("vercel");
		expect(matchCoarseCategories({ from: "ci@circleci.com" })).toContain("ci");
	});

	it("matches the generic notify-from catch-all", () => {
		expect(matchCoarseCategories({ from: "no-reply@somesaas.example" })).toContain("notification");
	});

	it("returns no flags for an unremarkable personal message", () => {
		expect(matchCoarseCategories({ from: "friend@gmail.com", subject: "lunch tomorrow?" })).toEqual([]);
	});

	it("respects a narrowed `categories` filter", () => {
		expect(matchCoarseCategories({ subject: "you won the lottery", from: "newsletter@x.com" }, ["junk"])).toEqual(["junk"]);
	});

	it("throws on an unknown category, same as compileSieve", () => {
		expect(() => matchCoarseCategories({}, ["bogus"])).toThrow(/unknown sieve categor/i);
	});
});
