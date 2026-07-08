import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { stripHtml } from "./_util";

// people_finder — a PUBLIC-SOURCE person aggregator. It surfaces only
// publicly-listed information (a public institutional directory + public social
// profiles + web-search hits) for legitimate individual lookups: no login/auth
// bypass, no scraping of gated/private records, no paid data-broker feeds. Every
// field it returns is one a person could find themselves by visiting the same
// public pages. It fans out across the sources concurrently and merges what each
// publishes into one deduped profile; a source that errors, is unconfigured, or
// is blocked is isolated into `errors` and never aborts the rest.
//
// Sources:
//   uw       — the UW Enterprise Directory Service (directory.uw.edu), a public
//              faculty/staff directory. It is a server-rendered Django form whose
//              search is an HTTP POST (query/method/population/length; a GET ignores
//              the query). The POST is un-blocked (no bot wall), so runUw hits it
//              directly and parses the server-rendered person-cards.
//   linkedin — the `linkedin` fn (public profile scrape) via the registry.
//   facebook — the `facebook` Graph fn via the registry.
//   web      — the `web_search` fn via the registry (general public web presence).

// TODO(auth): STUDENT records + suppressed phone/box are gated behind a UW-NetID
// SAML session (population=students). An authenticated, cookie-bearing fetch would
// unlock them — deliberately NOT wired here; this stays a public-only aggregator.
const UW_DIRECTORY = "https://directory.uw.edu/";
const UW_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** One person parsed out of a length=full UW directory page. Public fields only. */
export type UwPerson = { name?: string; emails: string[]; phones: string[]; addresses: string[]; work: Array<{ title?: string; org?: string }> };

/**
 * Parse the length=full UW directory HTML into per-person records. The page is
 * server-rendered as repeated `<div class="person-card">` blocks: an
 * `h4.person-name`, a `ul.no-style-list` of "Title, Department" appointment
 * `<li>`s, and a `ul.dir-listing.no-style-list` of Email:/Phone:/Box `<li>`s.
 * Tolerant to churn — pulls only the public name/email/phone/box/title/dept.
 */
export function parseUwDirectory(html: string): UwPerson[] {
	const out: UwPerson[] = [];
	// Split on the card marker; each part holds exactly one card's content (the next
	// card's marker starts the following part), so the first-match regexes below stay
	// scoped to this card.
	const parts = html.split(/<div class="person-card">/i).slice(1);
	for (const part of parts) {
		const nameM = part.match(/<h4[^>]*class="[^"]*person-name[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
		const name = nameM ? stripHtml(nameM[1]) : undefined;

		// Appointments live in `ul.no-style-list` (EXACT class — the contact list uses
		// "dir-listing no-style-list", which this pattern deliberately won't match).
		const work: Array<{ title?: string; org?: string }> = [];
		const apptM = part.match(/<ul class="no-style-list">([\s\S]*?)<\/ul>/i);
		if (apptM) {
			for (const li of apptM[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
				const t = stripHtml(li[1]);
				if (!t) continue;
				// "<Title>, <Department>" — split on the LAST comma (titles can contain commas).
				const idx = t.lastIndexOf(",");
				if (idx >= 0) work.push({ title: t.slice(0, idx).trim(), org: t.slice(idx + 1).trim() });
				else work.push({ title: t });
			}
		}

		// Contact fields live in the dir-listing ul (fall back to the whole card).
		const emails: string[] = [];
		const phones: string[] = [];
		const addresses: string[] = [];
		const listM = part.match(/<ul class="dir-listing no-style-list">([\s\S]*?)<\/ul>/i);
		const listBlock = listM ? listM[1] : part;
		for (const li of listBlock.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
			const t = stripHtml(li[1]);
			if (/^Email:/i.test(t)) {
				for (const e of t.replace(/^Email:/i, "").split(/[,\s]+/)) if (e.includes("@")) emails.push(e.trim());
			} else if (/^Phone:/i.test(t)) {
				for (const p of t.replace(/^Phone:/i, "").split(",")) {
					const v = p.trim();
					if (v) phones.push(v);
				}
			} else if (/person-box-number/i.test(li[0]) || /^Box\b/i.test(t)) {
				addresses.push(t.trim());
			}
		}

		if (name || emails.length || work.length) out.push({ name, emails, phones, addresses, work });
	}
	return out;
}

/** A source's public contribution to the merged profile, tagged with its origin. */
type Contribution = {
	source: string;
	name?: string;
	emails?: string[];
	phones?: string[];
	addresses?: string[];
	work?: Array<{ title?: string; org?: string }>;
	profiles?: Array<{ network: string; url: string }>;
};

/** Alpha tokens (2+ chars) of a name, lowercased — for loose match filtering. */
function nameTokens(s: string): string[] {
	return s
		.toLowerCase()
		.replace(/[^a-z\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

/** True when every token of the query name appears in the candidate name. */
function personMatches(personName: string, queryName: string): boolean {
	const qt = nameTokens(queryName);
	const pn = personName.toLowerCase();
	return qt.length > 0 && qt.every((t) => pn.includes(t));
}

/** Render + parse the public UW directory for `name`, merged into one contribution. */
async function runUw(env: RtEnv, name: string, limit: number): Promise<Contribution> {
	// directory.uw.edu is a server-rendered Django form: search is an HTTP POST
	// (GET ignores the query). A plain POST is un-blocked (no bot wall), so hit it
	// directly rather than through a browser render. Public faculty/staff tier only.
	const body = new URLSearchParams({ query: name, method: "name", population: "employees", length: "full" }).toString();
	const resp = await fetch(UW_DIRECTORY, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UW_UA, accept: "text/html" },
		body,
		signal: AbortSignal.timeout(20000),
	});
	if (!resp.ok) throw new Error(`UW directory HTTP ${resp.status}`);
	const people = parseUwDirectory(await resp.text());
	if (!people.length) return { source: "uw" };
	// A name search can return many people (e.g. 205 for "smith"); keep only cards
	// whose name matches the query (fall back to the first few) and merge those.
	const matched = people.filter((p) => p.name && personMatches(p.name, name));
	const chosen = (matched.length ? matched : people).slice(0, Math.max(1, limit));
	const emails: string[] = [];
	const phones: string[] = [];
	const addresses: string[] = [];
	const work: Array<{ title?: string; org?: string }> = [];
	for (const p of chosen) {
		emails.push(...p.emails);
		phones.push(...p.phones);
		addresses.push(...p.addresses);
		work.push(...p.work);
	}
	return { source: "uw", name: chosen[0]?.name, emails, phones, addresses, work };
}

/** Distil the `linkedin` fn's JSON output into a contribution. */
function fromLinkedin(text: string): Contribution {
	const j = JSON.parse(text);
	const headline = typeof j.headline === "string" ? j.headline : undefined;
	const current = Array.isArray(j.current) ? j.current : [];
	const work: Array<{ title?: string; org?: string }> = [];
	if (current.length) for (const c of current) work.push({ title: headline, org: String(c) });
	else if (headline) work.push({ title: headline });
	const profiles: Array<{ network: string; url: string }> = [];
	if (typeof j.url === "string" && j.url) profiles.push({ network: "linkedin", url: j.url });
	// A LinkedIn `location` is a coarse city/region, not a mailing address — leave it
	// out of `addresses` (which is reserved for physical/box addresses, e.g. UW's).
	return { source: "linkedin", name: typeof j.name === "string" ? j.name : undefined, work, profiles };
}

/** Distil the `facebook` Graph fn's JSON node into a contribution. */
function fromFacebook(text: string): Contribution {
	const j = JSON.parse(text);
	const profiles: Array<{ network: string; url: string }> = [];
	if (typeof j.link === "string" && j.link) profiles.push({ network: "facebook", url: j.link });
	const emails = typeof j.email === "string" && j.email ? [j.email] : [];
	return { source: "facebook", name: typeof j.name === "string" ? j.name : undefined, profiles, emails };
}

/** Classify a URL's host into a social network (or "web" for general presence). */
function classifyUrl(url: string): string | null {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
	if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";
	if (/(^|\.)facebook\.com$/.test(host)) return "facebook";
	if (/(^|\.)(twitter|x)\.com$/.test(host)) return "twitter";
	if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
	if (/(^|\.)github\.com$/.test(host)) return "github";
	return "web";
}

/** Pull public profile URLs (and any emails) out of the `web_search` text result. */
function fromWeb(text: string): Contribution {
	const profiles: Array<{ network: string; url: string }> = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) {
		const url = m[0].replace(/[.,);]+$/, "");
		const net = classifyUrl(url);
		if (!net || seen.has(url)) continue;
		seen.add(url);
		profiles.push({ network: net, url });
	}
	const emails: string[] = [];
	for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) emails.push(m[0]);
	return { source: "web", profiles, emails };
}

/** Invoke a pre-resolved registry fn and return its text result, throwing its error text. */
async function callFn(fns: Fn[], env: RtEnv, fnName: string, args: Record<string, unknown>): Promise<string> {
	const fn = fns.find((f) => f.name === fnName);
	if (!fn) throw new Error(`fn '${fnName}' not found in registry.`);
	const r = await fn.run(env, args);
	const text = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(text || `${fnName} failed.`);
	return text;
}

const ALL_SOURCES = ["uw", "linkedin", "facebook", "web"] as const;

export const people_finder: Fn = {
	name: "people_finder",
	cost: 5,
	description:
		"Public-source person aggregator — find publicly-listed information about a person by fanning out across a public institutional directory and public social/web sources, then merging into one deduped profile. " +
		"PUBLIC SOURCES ONLY: no login/auth bypass, no private records, no data brokers — every field is one the person could find on the same public pages. " +
		"`name` (required) is the person; `org` (e.g. 'uw'), `email`, `employer`, `location` are optional disambiguators; `sources` narrows the fan-out to a subset of ['uw','linkedin','facebook','web'] (default all); `limit` caps each list (default 10). " +
		"Sources: uw = the public UW faculty/staff directory (directory.uw.edu) via a direct POST; linkedin/facebook/web = the `linkedin`, `facebook`, and `web_search` fns via the registry. " +
		"Per-source failure is isolated into `errors` and never aborts the rest. " +
		"Returns JSON { name, emails, phones, addresses, work:[{title,org,source}], profiles:[{network,url}], sources:[], errors:[{source,error}] }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["name"],
		properties: {
			name: { type: "string", description: "Person's full name to look up (e.g. 'Arden Hellmann')." },
			org: { type: "string", description: "Optional org hint, e.g. 'uw' to include the UW directory source." },
			email: { type: "string", description: "Optional email disambiguator, folded into the web/social queries." },
			employer: { type: "string", description: "Optional employer disambiguator, folded into the web/social queries." },
			location: { type: "string", description: "Optional location disambiguator, folded into the web/social queries." },
			sources: {
				type: "array",
				items: { type: "string", enum: [...ALL_SOURCES] },
				description: "Subset of sources to fan across (default: all). Unknown names are ignored.",
			},
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Cap on each merged list (emails/phones/work/profiles)." },
		},
	},
	cacheable: true,
	ttl: 300, // live external directory/web state — cache only briefly
	run: async (env: RtEnv, args) => {
		const name = String(args?.name ?? "").trim();
		if (!name) return failWith("bad_input", "`name` is required.");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));

		// Resolve the source subset. Default = all. uw is additionally enabled whenever
		// org names 'uw' (so `org:"uw"` opts it in even under a narrowed `sources`).
		const orgUw = String(args?.org ?? "").toLowerCase().includes("uw");
		const requested: string[] | null = Array.isArray(args?.sources)
			? (args.sources as unknown[]).map((s) => String(s).trim().toLowerCase()).filter((s) => (ALL_SOURCES as readonly string[]).includes(s))
			: null;
		const selected: string[] = requested ? [...new Set(requested)] : [...ALL_SOURCES];
		if (orgUw && !selected.includes("uw")) selected.push("uw");
		if (selected.length === 0) return failWith("bad_input", `No known sources selected. Options: ${ALL_SOURCES.join(", ")}.`);

		// The name plus any disambiguators, for the social/web queries.
		const disamb = [args?.employer, args?.location, args?.email].filter((v) => typeof v === "string" && v).map(String);
		const queryString = [name, ...disamb].join(" ").trim();

		// Resolve the registry ONCE up front. A per-source `await import("./index")`
		// inside the concurrent fan-out races (vitest resolves the first dynamic import
		// to the mock and the rest to the real module) — import once, like product_search.
		// Dynamic import breaks the static index.ts -> people_finder.ts -> index.ts cycle.
		const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };

		const runSource = async (source: string): Promise<Contribution | null> => {
			switch (source) {
				case "uw":
					return runUw(env, name, limit);
				case "linkedin":
					return fromLinkedin(await callFn(FUNCTIONS, env, "linkedin", { name, query: queryString }));
				case "facebook":
					return fromFacebook(await callFn(FUNCTIONS, env, "facebook", { name, query: queryString }));
				case "web":
					return fromWeb(await callFn(FUNCTIONS, env, "web_search", { query: queryString, limit }));
				default:
					return null;
			}
		};

		// Each source in its own settled slot — a rejection is isolated into `errors`.
		const settled = await Promise.allSettled(selected.map((s) => runSource(s)));

		const emails: string[] = [];
		const phones: string[] = [];
		const addresses: string[] = [];
		const work: Array<{ title?: string; org?: string; source: string }> = [];
		const profiles: Array<{ network: string; url: string }> = [];
		const sources: string[] = [];
		const errors: Array<{ source: string; error: string }> = [];
		let resolvedName = "";

		for (let i = 0; i < settled.length; i++) {
			const source = selected[i];
			const s = settled[i];
			if (s.status === "rejected") {
				errors.push({ source, error: String((s.reason as Error)?.message ?? s.reason) });
				continue;
			}
			const c = s.value;
			if (!c) continue;
			sources.push(source);
			// Prefer the UW directory's canonical name, else the first source that names one.
			if (c.name && (!resolvedName || source === "uw")) resolvedName = c.name;
			if (c.emails) emails.push(...c.emails);
			if (c.phones) phones.push(...c.phones);
			if (c.addresses) addresses.push(...c.addresses);
			if (c.work) for (const w of c.work) work.push({ ...w, source });
			if (c.profiles) profiles.push(...c.profiles);
		}

		// Dedupe + cap every list.
		const dedupe = (xs: string[]): string[] => [...new Map(xs.map((x) => [x.trim().toLowerCase(), x.trim()])).values()].filter(Boolean);
		const dedupePhones = (xs: string[]): string[] => [...new Map(xs.map((x) => [x.replace(/\D/g, ""), x.trim()])).values()].filter(Boolean);
		const dedupeWork = [...new Map(work.map((w) => [`${w.title ?? ""}|${w.org ?? ""}`, w])).values()].filter((w) => w.title || w.org);
		const dedupeProfiles = [...new Map(profiles.map((p) => [p.url, p])).values()];

		const profile = {
			name: resolvedName || name,
			emails: dedupe(emails).slice(0, limit),
			phones: dedupePhones(phones).slice(0, limit),
			addresses: dedupe(addresses).slice(0, limit),
			work: dedupeWork.slice(0, limit),
			profiles: dedupeProfiles.slice(0, limit),
			sources: [...new Set(sources)],
			errors,
		};
		return ok(JSON.stringify(profile, null, 2));
	},
};
