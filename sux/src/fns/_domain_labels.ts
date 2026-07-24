// High-confidence sender-domain → label rules, expressed ONCE and consumed TWICE — the same
// "one definition, two consumers" ethos as _mail_sieve.ts. The two consumers here are:
//   1. `compileHighConfidenceSieve` — emits an addflag-ONLY Fastmail Sieve script that tags mail
//      at DELIVERY time (the mail_sieve_hc generator fn; text-only, pasted into Fastmail by hand).
//   2. `labelsFor` — the identical rules as a JS predicate, so `mail_domain_backfill` can apply the
//      SAME labels to mail that ALREADY exists (Sieve only ever fires on new deliveries). Because
//      both read this single source, the "new mail" and "old mail" paths can never silently diverge.
//
// Two invariants carried from _mail_sieve.ts:
//   TAG, NEVER HIDE — every emitted rule ends in `addflag`, never fileinto/discard/reject. A false
//     positive costs a stray IMAP keyword, never a message vanishing from the inbox.
//   HIGH-CONFIDENCE, FIRST-PARTY ONLY — brand groups list a brand's OWN sender domains (apex +
//     subdomains). ESP / relay infrastructure (sendgrid.net, amazonses.com, mailgun.org, …) is
//     DELIBERATELY excluded: it carries unrelated brands' mail, so tagging it would mislabel.
//
// Matching is by the FROM address domain: apex + any subdomain (email.chase.com and order.amazon.com
// match alongside the bare apex). Education is HIERARCHICAL (stacked tiers, most-specific first):
//   cs.uw.edu -> edu + uw + cs   ·   uw.edu -> edu + uw   ·   mit.edu -> edu
// The dept flag comes from the UW_DEPTS allowlist below; any other UW subdomain (infrastructure like
// u.washington.edu, or a multi-level one like mail.cs.uw.edu) stays edu + uw. gov/mil match by TLD.
//
// Ported verbatim from the audited generator scripts/gen-sieve source — the data + `labelsFor`
// semantics are byte-for-byte the same, so the emitted Sieve and the JS predicate always agree.
import { errMsg } from "./_util";

export type DomainGroup = { label: string; title: string; domains: string[] };
export type IndepTld = { label: string; title: string; patterns: string[] };

// ── Brand groups: label <- list of first-party sender domains. NO ESP/relay infra
//    (sendgrid.net, amazonses.com, mailgun.org, etc.) — those carry unrelated brands' mail.
export const GROUPS: DomainGroup[] = [
	{ label: "finance", title: "Banks, card issuers, brokerages, payments & fintech", domains: [
		"chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com",
		"capitalone.com", "pnc.com", "truist.com", "td.com", "tdbank.com", "ally.com", "discover.com",
		"americanexpress.com", "aexp.com", "synchrony.com", "synchronybank.com", "hsbc.com", "hsbc.co.uk",
		"barclays.com", "barclaycardus.com", "navyfederal.org", "usaa.com", "schwab.com", "fidelity.com",
		"vanguard.com", "etrade.com", "morganstanley.com", "ml.com", "merrilledge.com", "tdameritrade.com",
		"robinhood.com", "sofi.com", "marcus.com", "goldmansachs.com", "paypal.com", "venmo.com", "cash.app",
		"squareup.com", "block.xyz", "stripe.com", "wise.com", "revolut.com", "coinbase.com", "gemini.com",
		"kraken.com", "plaid.com", "intuit.com", "turbotax.com", "quickbooks.com", "creditkarma.com",
		"experian.com", "equifax.com", "transunion.com", "fico.com", "nerdwallet.com", "fanniemae.com",
	] },
	{ label: "shopping", title: "Retail & e-commerce", domains: [
		"amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com", "bestbuy.com", "costco.com",
		"samsclub.com", "homedepot.com", "lowes.com", "ikea.com", "wayfair.com", "overstock.com", "chewy.com",
		"petco.com", "petsmart.com", "newegg.com", "bhphotovideo.com", "macys.com", "nordstrom.com",
		"nordstromrack.com", "kohls.com", "gap.com", "oldnavy.com", "bananarepublic.com", "nike.com",
		"adidas.com", "lululemon.com", "rei.com", "patagonia.com", "backcountry.com", "thenorthface.com",
		"zappos.com", "sephora.com", "ulta.com", "cvs.com", "walgreens.com", "williams-sonoma.com",
		"crateandbarrel.com", "potterybarn.com", "aliexpress.com", "temu.com", "shein.com", "shopify.com",
		"instacart.com", "doordash.com", "ubereats.com", "grubhub.com", "gopuff.com",
	] },
	{ label: "travel", title: "Airlines, hotels, booking, rail & rideshare", domains: [
		"united.com", "delta.com", "aa.com", "southwest.com", "alaskaair.com", "jetblue.com", "spirit.com",
		"flyfrontier.com", "hawaiianairlines.com", "britishairways.com", "lufthansa.com", "airfrance.com",
		"klm.com", "emirates.com", "qatarairways.com", "singaporeair.com", "aircanada.ca", "marriott.com",
		"hilton.com", "hyatt.com", "ihg.com", "choicehotels.com", "wyndhamhotels.com", "fourseasons.com",
		"airbnb.com", "vrbo.com", "booking.com", "expedia.com", "hotels.com", "priceline.com", "kayak.com",
		"orbitz.com", "travelocity.com", "tripadvisor.com", "uber.com", "lyft.com", "amtrak.com",
		"enterprise.com", "hertz.com", "avis.com", "budget.com", "turo.com", "getaround.com", "viator.com",
		"ticketmaster.com", "stubhub.com", "seatgeek.com",
	] },
	{ label: "shipping", title: "Carriers, delivery & logistics", domains: [
		"ups.com", "fedex.com", "usps.com", "dhl.com", "dhl.de", "ontrac.com", "lasership.com", "purolator.com",
		"canadapost.ca", "canadapost-postescanada.ca", "royalmail.com", "aftership.com", "shipstation.com",
		"shippo.com", "easypost.com", "narvar.com", "route.com",
	] },
	{ label: "dev", title: "Developer tools, CI, cloud & infrastructure", domains: [
		"github.com", "gitlab.com", "bitbucket.org", "atlassian.com", "atlassian.net", "vercel.com",
		"netlify.com", "circleci.com", "travis-ci.com", "travis-ci.org", "npmjs.com", "docker.com",
		"cloudflare.com", "amazonaws.com", "awsapps.com", "azure.com", "digitalocean.com", "heroku.com",
		"linode.com", "akamai.com", "fastly.com", "datadoghq.com", "sentry.io", "pagerduty.com", "opsgenie.com",
		"hashicorp.com", "mongodb.com", "redis.com", "redislabs.com", "snowflake.com", "databricks.com",
		"confluent.io", "elastic.co", "gitpod.io", "jetbrains.com", "jfrog.com", "sonatype.com", "sonarsource.com",
		"sonarcloud.io", "codecov.io", "coveralls.io", "snyk.io", "gitguardian.com", "launchdarkly.com",
		"twilio.com", "pypi.org", "rubygems.org", "packagist.org", "readthedocs.org", "python.org", "nodejs.org",
		"golang.org", "rust-lang.org", "kubernetes.io", "cncf.io", "apache.org", "gnu.org", "sourceforge.net",
		"stackoverflow.com", "stackexchange.com", "hackerone.com", "bugcrowd.com",
	] },
	{ label: "tech", title: "Platforms, productivity & consumer-tech accounts", domains: [
		"google.com", "microsoft.com", "apple.com", "dropbox.com", "box.com", "adobe.com", "mozilla.org",
		"zoom.us", "calendly.com", "notion.so", "asana.com", "trello.com", "monday.com", "clickup.com",
		"airtable.com", "docusign.net", "docusign.com", "hellosign.com", "1password.com", "dashlane.com",
		"lastpass.com", "bitwarden.com", "okta.com", "auth0.com", "grammarly.com", "evernote.com", "todoist.com",
		"figma.com", "canva.com", "miro.com", "loom.com", "zendesk.com", "intercom.io", "salesforce.com",
		"hubspot.com", "zapier.com", "ifttt.com", "samsung.com", "sony.com", "dell.com", "hp.com", "lenovo.com",
		"logitech.com", "sonos.com", "ring.com", "wyze.com",
	] },
	{ label: "social", title: "Social networks & communities", domains: [
		"facebook.com", "facebookmail.com", "fb.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
		"reddit.com", "redditmail.com", "pinterest.com", "tiktok.com", "snapchat.com", "discord.com",
		"discordapp.com", "telegram.org", "whatsapp.com", "nextdoor.com", "meetup.com", "quora.com", "tumblr.com",
		"twitch.tv", "youtube.com", "vimeo.com", "threads.net", "bsky.app", "strava.com", "goodreads.com",
		"letterboxd.com",
	] },
	{ label: "news", title: "News, media & newsletter platforms", domains: [
		"nytimes.com", "wsj.com", "dowjones.com", "washingtonpost.com", "theatlantic.com", "economist.com",
		"ft.com", "bloomberg.com", "reuters.com", "apnews.com", "npr.org", "bbc.co.uk", "bbc.com", "theguardian.com",
		"cnn.com", "foxnews.com", "nbcnews.com", "cbsnews.com", "politico.com", "axios.com", "vox.com", "wired.com",
		"arstechnica.com", "theverge.com", "techcrunch.com", "engadget.com", "cnet.com", "seattletimes.com",
		"thestranger.com", "crosscut.com", "substack.com", "beehiiv.com", "ghost.io", "morningbrew.com",
		"thehustle.co", "semafor.com", "thedispatch.com", "puck.news", "404media.co",
	] },
	{ label: "health", title: "Healthcare, insurers & pharmacy (PNW-weighted)", domains: [
		"kaiserpermanente.org", "uwmedicine.org", "providence.org", "swedish.org", "virginiamason.org",
		"seattlechildrens.org", "cigna.com", "aetna.com", "uhc.com", "unitedhealthcare.com", "bcbs.com",
		"regence.com", "premera.com", "anthem.com", "humana.com", "express-scripts.com", "caremark.com",
		"optum.com", "goodrx.com", "zocdoc.com", "onemedical.com", "teladoc.com", "questdiagnostics.com",
		"labcorp.com", "23andme.com",
	] },
];

// ── Education is HIERARCHICAL — stacked tiers, matched most-specific first (if/elsif):
//      cs.uw.edu -> edu + uw + cs   (dept from the UW_DEPTS allowlist below)
//      uw.edu    -> edu + uw
//      mit.edu   -> edu
export const UW_APEX = ["uw.edu", "washington.edu"]; // University of Washington (apex forms)

// ── UW departments — an ALLOWLIST, deliberately, not an infra blocklist (#1417 defect 1).
//    This rule used to treat ANY single-label UW subdomain as a department, so infrastructure hosts
//    minted garbage labels: measured against the newest 2000 real messages, u.washington.edu produced
//    a bogus `u` on 158 of them and lists.uw.edu a bogus `lists` on 4, indistinguishable from the
//    legitimate `cs` (137).
//
//    Allowlist over blocklist because the two fail in opposite directions. UW's infrastructure
//    subdomains are unbounded and unknowable, so a blocklist is permanently incomplete — every host
//    nobody thought of still emits a garbage department. An allowlist fails BENIGNLY: an unrecognized
//    subdomain simply degrades to `edu` + `uw`, which is still CORRECT, only less specific. It can
//    never invent a label. That is this codebase's conservative-by-construction doctrine.
//
//    ADDING A DEPARTMENT IS A ONE-LINE CHANGE — append its subdomain label here and both consumers
//    (labelsFor and the emitted Sieve) pick it up. Omission costs specificity, never correctness, so
//    only add a department you have actually confirmed; do not seed this from a remembered org chart.
export const UW_DEPTS = [
	"cs", // Paul G. Allen School of Computer Science & Engineering (cs.uw.edu / cs.washington.edu)
	"ece", // Department of Electrical & Computer Engineering (ece.uw.edu / ece.washington.edu)
];
export const EDU_GENERIC = [ // generic .edu + international academic TLDs (non-UW)
	"*.edu", "*.ac.uk", "*.edu.au", "*.ac.nz", "*.ac.jp", "*.edu.cn", "*.edu.sg", "*.ac.in", "*.edu.hk",
];
// ── Independent institutional TLDs (no overlap with the edu cascade or each other).
export const INDEP_TLD: IndepTld[] = [
	{ label: "gov", title: "Government — US .gov + international", patterns: [
		"*.gov", "*.gov.uk", "*.gc.ca", "*.canada.ca", "*.gov.au", "*.govt.nz", "*.europa.eu",
	] },
	{ label: "mil", title: "US military — .mil", patterns: [
		"*.mil",
	] },
];

// ── Matching primitives — a glob (`*` = any run, `?` = one char) compiled to an anchored regex,
//    mirroring what the emitted Sieve `:matches`/`:is` tests evaluate. Ported verbatim so the JS
//    predicate and the Sieve script agree by construction.
const globToRegex = (p: string): RegExp =>
	new RegExp("^" + p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
const matchesAny = (domain: string, patterns: string[]): boolean => patterns.some((p) => globToRegex(p).test(domain));

/**
 * The high-confidence labels for a FROM address (the backfill's JS mirror of the emitted Sieve).
 * Returns the deduped, ORDERED set of flags: education tier(s) first (edu, uw, dept), then any
 * independent institutional TLD (gov/mil), then brand-group labels. `[]` when nothing matches —
 * personal senders (gmail/outlook) and deliberately-excluded ESP infra (sendgrid.net) land here.
 */
export function labelsFor(fromAddress: string): string[] {
	const domain = String(fromAddress).toLowerCase().split("@").pop() ?? "";
	const flags: string[] = [];
	// Education — HIERARCHICAL, most-specific first (mirrors the emitted if/elsif chain). The dept tier
	// is the UW_DEPTS allowlist: an exact `<dept>.<apex>` match, so no other subdomain — infrastructure
	// (u.washington.edu) or multi-level (mail.cs.uw.edu) — can mint one. Both fall through to edu + uw,
	// which is why the old explicit deep-subdomain guard is no longer needed.
	if (UW_DEPTS.some((dept) => UW_APEX.some((d) => domain === `${dept}.${d}`))) {
		flags.push("edu", "uw", domain.slice(0, domain.indexOf(".")));
	} else if (matchesAny(domain, UW_APEX.map((d) => `*.${d}`))) flags.push("edu", "uw");
	else if (UW_APEX.includes(domain)) flags.push("edu", "uw");
	else if (matchesAny(domain, EDU_GENERIC)) flags.push("edu");
	for (const g of INDEP_TLD) if (matchesAny(domain, g.patterns)) flags.push(g.label);
	for (const g of GROUPS) {
		const apex = new Set(g.domains.map((d) => d.toLowerCase()));
		if (apex.has(domain) || matchesAny(domain, g.domains.map((d) => `*.${d}`))) flags.push(g.label);
	}
	return flags;
}

// ── Sieve compiler — the SECOND consumer. Emits an addflag-only script from the SAME data above.
//    `categories` narrows which blocks are emitted: "education" gates the edu/uw/dept cascade; every
//    other category is an INDEP_TLD label (gov/mil) or a brand-GROUP label (finance, shopping, …).
export const ALL_DOMAIN_CATEGORIES: readonly string[] = ["education", ...INDEP_TLD.map((g) => g.label), ...GROUPS.map((g) => g.label)];

const q = (s: string): string => JSON.stringify(s);
const list = (items: string[]): string => items.map(q).join(", ");
const dedupe = (a: string[]): string[] => [...new Set(a)];

function validateDomainCategories(categories?: readonly string[]): string[] {
	const requested = categories && categories.length ? categories : ALL_DOMAIN_CATEGORIES;
	const invalid = requested.filter((c) => !ALL_DOMAIN_CATEGORIES.includes(c));
	if (invalid.length) throw new Error(`unknown domain categor${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")} (valid: ${ALL_DOMAIN_CATEGORIES.join(", ")})`);
	return [...requested];
}

/**
 * Compile the requested categories (default: all) into a high-confidence Fastmail Sieve script.
 * Pure — no I/O, no JMAP. Every generated rule ends in `addflag` only; the Sieve implicit `keep`
 * (no fileinto/discard/reject anywhere) means every message still lands in the inbox, tagged.
 * Throws on an unknown category so a typo fails loud, not silently-empty.
 */
export function compileHighConfidenceSieve(categories?: readonly string[]): { script: string; categories: string[]; rule_count: number; brand_domains: number } {
	const cats = validateDomainCategories(categories);
	const want = new Set(cats);

	const out: string[] = [];
	out.push('require ["imap4flags"];');
	out.push("");
	out.push("# ─────────────────────────────────────────────────────────────────────────────");
	out.push("# High-confidence sender-domain labels for Fastmail — generated, addflag-ONLY.");
	out.push("#");
	out.push("# Every rule TAGS the message with an IMAP keyword and nothing else: no fileinto,");
	out.push("# no discard, no reject. Sieve's implicit keep still delivers every message to the");
	out.push("# inbox, so a false positive costs a stray keyword, never a hidden email.");
	out.push("#");
	out.push("# HIERARCHICAL education labels (stacked tiers, most-specific first):");
	out.push("#   cs.uw.edu -> edu + uw + cs   ·   uw.edu -> edu + uw   ·   mit.edu -> edu");
	out.push("#");
	out.push("# Matching is by the FROM address domain (:domain), apex + any subdomain. ESP/relay");
	out.push("# infrastructure domains are deliberately excluded — they carry unrelated senders.");
	out.push("#");
	out.push("# Paste into Fastmail → Settings → Rules → Edit custom Sieve code → Save.");
	out.push("# ─────────────────────────────────────────────────────────────────────────────");

	let rule_count = 0;
	let brand_domains = 0;

	// Education — HIERARCHICAL cascade, most-specific first. The department tier is emitted as one
	// EXPLICIT `:is` block per allowlisted dept, ahead of the general UW-subdomain block. Sieve's `${1}`
	// capture cannot be conditionally allowlisted — it would tag whatever the wildcard happened to eat
	// (u.washington.edu -> "u") — so the concrete domains are spelled out instead (#1417 defect 1).
	// With no capture left to protect, the old *.*.uw.edu deep-subdomain guard is redundant: the general
	// *.uw.edu block already matches a.b.uw.edu and yields the same edu + uw.
	if (want.has("education")) {
		const uwSub = UW_APEX.map((d) => `*.${d}`);
		out.push("");
		out.push("# UW department subdomains — HIERARCHICAL: edu + uw + dept. Explicit per-department");
		out.push("# blocks (an allowlist), so an infrastructure subdomain can never mint a bogus dept.");
		UW_DEPTS.forEach((dept, i) => {
			const domains = UW_APEX.map((d) => `${dept}.${d}`);
			out.push(`${i === 0 ? "if" : "elsif"} address :domain :is "from" [${list(domains)}] {`);
			out.push(`    addflag ["edu", "uw", ${q(dept)}];`);
			out.push("}");
		});
		out.push("");
		out.push("# Any other UW subdomain (u.washington.edu, lists.uw.edu, mail.cs.uw.edu) — edu + uw only");
		out.push(`${UW_DEPTS.length ? "elsif" : "if"} address :domain :matches "from" [${list(uwSub)}] {`);
		out.push('    addflag ["edu", "uw"];');
		out.push("}");
		out.push("");
		out.push("# UW apex (uw.edu / washington.edu) — edu + uw");
		out.push(`elsif address :domain :matches "from" [${list(UW_APEX)}] {`);
		out.push('    addflag ["edu", "uw"];');
		out.push("}");
		out.push("");
		out.push("# Generic education — .edu + intl academic TLDs (non-UW) — edu");
		out.push(`elsif address :domain :matches "from" [${list(EDU_GENERIC)}] {`);
		out.push('    addflag "edu";');
		out.push("}");
		rule_count += UW_DEPTS.length + 3;
	}

	// Independent institutional TLDs (gov, mil — no overlap, so plain ifs).
	for (const g of INDEP_TLD) {
		if (!want.has(g.label)) continue;
		const pats = dedupe(g.patterns);
		out.push("");
		out.push(`# ${g.title} — label "${g.label}" (${pats.length} pattern${pats.length === 1 ? "" : "s"})`);
		out.push(`if address :domain :matches "from" [${list(pats)}] {`);
		out.push(`    addflag "${g.label}";`);
		out.push("}");
		rule_count += 1;
	}

	// Brand groups: exact apex list + wildcard subdomain list under one anyof.
	for (const g of GROUPS) {
		if (!want.has(g.label)) continue;
		const apex = dedupe(g.domains);
		brand_domains += apex.length;
		const subs = apex.map((d) => `*.${d}`);
		out.push("");
		out.push(`# ${g.title} — label "${g.label}" (${apex.length} domains, apex + subdomains)`);
		out.push("if anyof (");
		out.push(`    address :domain :is "from" [${list(apex)}],`);
		out.push(`    address :domain :matches "from" [${list(subs)}]`);
		out.push(") {");
		out.push(`    addflag "${g.label}";`);
		out.push("}");
		rule_count += 1;
	}

	out.push("");
	return { script: out.join("\n"), categories: cats, rule_count, brand_domains };
}

/** Non-throwing wrapper (mirrors _mail_sieve.tryCompileSieve) for the mail_sieve_hc fn shell. */
export function tryCompileHighConfidenceSieve(
	categories?: readonly string[],
): { ok: true; script: string; categories: string[]; rule_count: number; brand_domains: number } | { ok: false; error: string } {
	try {
		return { ok: true, ...compileHighConfidenceSieve(categories) };
	} catch (e) {
		return { ok: false, error: errMsg(e) };
	}
}
