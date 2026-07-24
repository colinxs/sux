import { describe, expect, it } from "vitest";
import { ALL_DOMAIN_CATEGORIES, compileHighConfidenceSieve, labelsFor, UW_DEPTS } from "./_domain_labels";

// The label outputs below are the authoritative expectations from the audited generator's `--check`
// mode (scripts/gen-sieve). labelsFor is a verbatim port, so these must match byte-for-byte.
describe("labelsFor — high-confidence sender-domain labels", () => {
	it("hierarchical education, most-specific first", () => {
		expect(labelsFor("student@uw.edu")).toEqual(["edu", "uw"]);
		expect(labelsFor("prof@cs.uw.edu")).toEqual(["edu", "uw", "cs"]);
		expect(labelsFor("ta@ece.uw.edu")).toEqual(["edu", "uw", "ece"]);
		expect(labelsFor("support@cs.washington.edu")).toEqual(["edu", "uw", "cs"]);
		expect(labelsFor("husky@washington.edu")).toEqual(["edu", "uw"]);
	});

	it("a multi-level UW subdomain stays edu+uw (no messy compound dept flag)", () => {
		expect(labelsFor("x@mail.cs.uw.edu")).toEqual(["edu", "uw"]);
	});

	// #1417 defect 1 — the dept-capture leak. Before the UW_DEPTS allowlist, ANY single-label UW
	// subdomain became a "department": u.washington.edu minted a bogus `u` on 158 of the newest 2000
	// real messages, lists.uw.edu a bogus `lists` on 4. An unrecognized subdomain must degrade to the
	// still-correct edu+uw, never invent a garbage label.
	it("UW infrastructure subdomains do NOT mint a department flag", () => {
		expect(labelsFor("hws-oldies@u.washington.edu")).toEqual(["edu", "uw"]);
		expect(labelsFor("x@lists.uw.edu")).toEqual(["edu", "uw"]);
	});

	it("an unrecognized UW subdomain degrades to edu+uw rather than inventing a dept", () => {
		expect(labelsFor("x@random-infra.uw.edu")).toEqual(["edu", "uw"]);
		expect(labelsFor("x@mail.washington.edu")).toEqual(["edu", "uw"]);
	});

	it("every allowlisted department is a bare single label (no dots, no wildcards)", () => {
		expect(UW_DEPTS.length).toBeGreaterThan(0);
		for (const d of UW_DEPTS) expect(d).toMatch(/^[a-z0-9-]+$/);
	});

	it("generic .edu and international academic TLDs get edu only", () => {
		expect(labelsFor("newton@mit.edu")).toEqual(["edu"]);
		expect(labelsFor("don@balliol.ac.uk")).toEqual(["edu"]);
	});

	it("brand groups match apex + subdomains by first-party domain", () => {
		expect(labelsFor("alerts@email.chase.com")).toEqual(["finance"]);
		expect(labelsFor("receipts@order.amazon.com")).toEqual(["shopping"]);
	});

	it("excludes ESP / relay infrastructure (it carries unrelated brands' mail)", () => {
		expect(labelsFor("x@sendgrid.net")).toEqual([]);
	});

	it("independent institutional TLDs — gov and mil", () => {
		expect(labelsFor("noreply@irs.gov")).toEqual(["gov"]);
		expect(labelsFor("soldier@navy.mil")).toEqual(["mil"]);
	});

	it("personal senders get no label", () => {
		expect(labelsFor("a@gmail.com")).toEqual([]);
		expect(labelsFor("friend@outlook.com")).toEqual([]);
	});

	it("is case-insensitive on the address", () => {
		expect(labelsFor("Prof@CS.UW.EDU")).toEqual(["edu", "uw", "cs"]);
	});
});

describe("compileHighConfidenceSieve — Sieve emission", () => {
	it("declares imap4flags and stays addflag-only (never hides a message)", () => {
		const { script } = compileHighConfidenceSieve();
		expect(script).toContain('require ["imap4flags"];');
		const code = script
			.split("\n")
			.filter((l) => !l.trim().startsWith("#"))
			.join("\n")
			.toLowerCase();
		for (const verb of ["fileinto", "discard", "reject", "redirect"]) expect(code).not.toContain(verb);
	});

	// REWRITTEN for #1417 defect 1. These two assertions previously PINNED THE BUG: they required the
	// `${1}` capture, which is exactly what turned u.washington.edu into a bogus `u` department. `${1}`
	// cannot be conditionally allowlisted inside Sieve, so the dept tier is now emitted as explicit
	// per-dept `:is` blocks ahead of a general UW-subdomain block that yields only edu + uw.
	it("emits the hierarchical education cascade as explicit per-dept blocks, never a ${1} capture", () => {
		const { script } = compileHighConfidenceSieve();
		expect(script).toContain('addflag ["edu", "uw", "cs"];');
		expect(script).toContain('address :domain :is "from" ["cs.uw.edu", "cs.washington.edu"]');
		expect(script).toContain('elsif address :domain :matches "from"');
		expect(script).not.toContain("${1}");
		expect(script).not.toContain("variables");
	});

	it("emits a brand group as an anyof(:is apex, :matches *.apex) block", () => {
		const { script } = compileHighConfidenceSieve();
		expect(script).toContain('address :domain :is "from"');
		expect(script).toContain('address :domain :matches "from"');
		expect(script).toContain('addflag "finance";');
		expect(script).toContain("chase.com");
	});

	it("narrows to the requested categories, omitting the rest", () => {
		const { script, categories } = compileHighConfidenceSieve(["finance"]);
		expect(categories).toEqual(["finance"]);
		expect(script).toContain('addflag "finance";');
		expect(script).not.toContain('addflag "shopping";');
		expect(script).not.toContain('addflag ["edu", "uw", "cs"];');
		expect(script).not.toContain('addflag ["edu", "uw"];');
	});

	it("throws on an unknown category rather than silently emitting a partial script", () => {
		expect(() => compileHighConfidenceSieve(["bogus"])).toThrow(/unknown domain categor/i);
	});

	it("exposes every selectable category (education + gov/mil + brand groups)", () => {
		expect(ALL_DOMAIN_CATEGORIES).toContain("education");
		expect(ALL_DOMAIN_CATEGORIES).toContain("gov");
		expect(ALL_DOMAIN_CATEGORIES).toContain("mil");
		expect(ALL_DOMAIN_CATEGORIES).toContain("finance");
	});
});

// ── The file's stated premise is that its TWO consumers agree by construction. That premise was only
//    ever asserted by hand-picked examples, and #1417 defect 1 was precisely a rule the two shared and
//    both got wrong. This block pins the agreement mechanically: parse the emitted education cascade
//    back out of the script, evaluate it Sieve-style (first match in the if/elsif chain wins), and
//    require it to equal labelsFor for a table that includes real departments, real infra subdomains,
//    apex, deep subdomains and non-UW education.
//
//    The matcher and evaluator below are deliberately re-derived from Sieve's own :is/:matches
//    semantics rather than imported from _domain_labels — a differential test whose reference is the
//    implementation it is testing can only ever agree with itself.
describe("compileHighConfidenceSieve ↔ labelsFor — agreement by construction", () => {
	type Block = { chain: "open" | "cont"; op: "is" | "matches"; domains: string[]; flags: string[] };

	// Sieve :matches — `*` matches any run (including empty), `?` exactly one character.
	const sieveMatches = (pattern: string, value: string): boolean =>
		new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$").test(value);

	function parseChains(script: string): Block[][] {
		const lines = script.split("\n");
		const chains: Block[][] = [];
		let current: Block[] | null = null;
		for (let i = 0; i < lines.length; i++) {
			const head = /^(if|elsif) address :domain :(is|matches) "from" \[(.+)\] \{$/.exec(lines[i].trim());
			if (!head) continue;
			const body = /^addflag (.+);$/.exec((lines[i + 1] ?? "").trim());
			expect(body, `no addflag directly under: ${lines[i]}`).not.toBeNull();
			const rawFlags = (body as RegExpExecArray)[1];
			const block: Block = {
				chain: head[1] === "if" ? "open" : "cont",
				op: head[2] as "is" | "matches",
				domains: JSON.parse(`[${head[3]}]`) as string[],
				flags: JSON.parse(rawFlags.startsWith("[") ? rawFlags : `[${rawFlags}]`) as string[],
			};
			if (block.chain === "open" || !current) chains.push((current = [block]));
			else current.push(block);
		}
		return chains;
	}

	// First-match-wins over one if/elsif chain, exactly as Sieve evaluates it.
	const evalChain = (chain: Block[], domain: string): string[] => {
		for (const b of chain) {
			const hit = b.op === "is" ? b.domains.includes(domain) : b.domains.some((p) => sieveMatches(p, domain));
			if (hit) return b.flags;
		}
		return [];
	};

	const educationChain = (): Block[] => {
		const chains = parseChains(compileHighConfidenceSieve(["education"]).script);
		expect(chains).toHaveLength(1); // the whole education cascade is ONE if/elsif chain
		return chains[0];
	};

	it("the emitted education cascade and labelsFor produce identical flags", () => {
		const chain = educationChain();
		const table = [
			"uw.edu", "washington.edu", // apex
			"cs.uw.edu", "cs.washington.edu", "ece.uw.edu", "ece.washington.edu", // real departments
			"u.washington.edu", "lists.uw.edu", "mail.uw.edu", "www.washington.edu", "random-infra.uw.edu", // infra
			"mail.cs.uw.edu", "a.b.c.washington.edu", // deep subdomains
			"mit.edu", "balliol.ac.uk", "anu.edu.au", // non-UW education
			"gmail.com", "sendgrid.net", // no education tier at all
		];
		for (const domain of table) {
			expect(evalChain(chain, domain), `sieve vs labelsFor disagree on ${domain}`).toEqual(labelsFor(`x@${domain}`));
		}
	});

	it("the cascade never emits a department the allowlist does not contain", () => {
		for (const block of educationChain()) {
			for (const flag of block.flags) {
				if (flag === "edu" || flag === "uw") continue;
				expect(UW_DEPTS).toContain(flag);
			}
		}
	});

	it("every allowlisted department is reachable at both UW apex spellings", () => {
		for (const dept of UW_DEPTS) {
			expect(labelsFor(`x@${dept}.uw.edu`)).toEqual(["edu", "uw", dept]);
			expect(labelsFor(`x@${dept}.washington.edu`)).toEqual(["edu", "uw", dept]);
		}
	});
});
