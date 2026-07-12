import { type Fn, failWith, ok } from "../registry";
import { smartFetch } from "../proxy";

// UW person lookup — directory.uw.edu scrape (works today, no secret) with an
// optional PWS mutual-TLS tier behind the UW_PWS_CERT binding.
//
// The public directory is a classic server-rendered form: GET / mints a short-
// lived `edu.uw.directory.session` cookie, then a POST / (with that cookie)
// runs one search. The session cookie is SINGLE-USE — one GET → one POST per
// lookup — so every call re-primes it. Faculty/staff are public; students are
// FERPA-gated behind SAML (/saml/login) and simply never appear in the
// anonymous scrape (we honor that — never try to defeat it). Suppressed people
// are absent by construction. Non-commercial, single online look-up only
// (RCW 42.56): no bulk/mass-scrape, no cache-and-redistribute.
//
// The richer, student-inclusive record lives behind PWS (ws.admin.washington.edu),
// which requires client-cert mTLS. On CF Workers that's an `mtls_certificates`
// binding — its presence IS "cert set". Fail-closed: absent → scrape-only, never
// an error. directory.uw.edu is literally the public face of PWS (holds the cert
// server-side), so the scrape gives faculty/staff title/department/box already.

const BASE = "https://directory.uw.edu";
const PWS_BASE = "https://ws.admin.washington.edu";
// Identifying, non-deceptive UA + contact per the directory's non-commercial ToS.
const UA = "sux-mcp/1.0 (+https://github.com/colinxs/sux; personal single-lookup)";

type Method = "name" | "email" | "department" | "box" | "phone";
// The directory <select name="method"> option values (box → box_number).
const METHOD_FIELD: Record<Method, string> = {
	name: "name",
	email: "email",
	department: "department",
	box: "box_number",
	phone: "phone",
};

type PersonRecord = {
	displayName: string;
	netid: string | null;
	email: string | null;
	title: string | null;
	department: string | null;
	positions: string[];
	phone: string | null;
	fax: string | null;
	boxNumber: string | null;
	category: string;
	regid: string | null;
};

const decodeEntities = (s: string): string =>
	s
		.replace(/&#34;|&quot;/gi, '"')
		.replace(/&#38;|&amp;/gi, "&")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));

/** Strip tags, decode entities, collapse whitespace. */
const clean = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** All <li>…</li> inner strings within `ul` HTML. */
function liTexts(ul: string): string[] {
	return [...ul.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => clean(m[1])).filter(Boolean);
}

/** Detect the auth wall: the anonymous page offers a SAML sign-in for students. */
function isStudentGated(html: string, wantStudents: boolean): boolean {
	return wantStudents && /\/saml\/login/i.test(html);
}

/** base64(person_href) → the PWS RegID (path is /identity/v2/person/{REGID}/full.json). */
function regidFromHref(b64: string): string | null {
	try {
		const path = atob(b64);
		return path.match(/\/person\/([0-9A-Fa-f]{32})\//)?.[1]?.toUpperCase() ?? null;
	} catch {
		return null;
	}
}

/** Parse the `length=full` directory response into person records. */
function parseCards(html: string): PersonRecord[] {
	const records: PersonRecord[] = [];
	for (const m of html.matchAll(/<div class="person-card">([\s\S]*?)<!-- End Person Card -->/gi)) {
		const card = m[1];
		const displayName = clean(card.match(/<h4 class="person-name">([\s\S]*?)<\/h4>/i)?.[1] ?? "");
		if (!displayName) continue;

		// Departments/appointments: the first plain `no-style-list` ul (the dir-listing
		// ul that follows carries the class "dir-listing no-style-list").
		const deptUl = card.match(/<ul class="no-style-list">([\s\S]*?)<\/ul>/i)?.[1] ?? "";
		const positions = liTexts(deptUl);

		const listUl = card.match(/<ul class="dir-listing[^"]*">([\s\S]*?)<\/ul>/i)?.[1] ?? "";
		const items = liTexts(listUl);
		const pick = (label: RegExp): string | null => {
			const hit = items.find((t) => label.test(t));
			return hit ? hit.replace(label, "").trim() : null;
		};
		const email = pick(/^Email:\s*/i);
		const phone = pick(/^Phone:\s*/i);
		const fax = pick(/^Fax:\s*/i);
		const boxRaw = items.find((t) => /^Box\b/i.test(t)) ?? null;
		// Tolerate an optional colon (`Box: 352350`), matching the colon-suffixed form
		// email/phone/fax already use — otherwise a colon would survive as a stray prefix.
		const boxNumber = boxRaw ? boxRaw.replace(/^Box:?\s*/i, "").trim() : null;

		const regid = regidFromHref(card.match(/name="person_href"\s+value="([^"]+)"/i)?.[1] ?? "");

		// title/department: split the first appointment on its first comma
		// ("Professor Emeritus, Paul G. Allen School …"). No comma → treat the
		// whole thing as the department.
		let title: string | null = null;
		let department: string | null = null;
		if (positions[0]) {
			const c = positions[0].indexOf(",");
			if (c === -1) {
				department = positions[0];
			} else {
				title = positions[0].slice(0, c).trim();
				department = positions[0].slice(c + 1).trim();
			}
		}
		const netid = email?.match(/^([^@]+)@(?:uw\.edu|washington\.edu|u\.washington\.edu)$/i)?.[1]?.toLowerCase() ?? null;

		records.push({ displayName, netid, email, title, department, positions, phone, fax, boxNumber, category: "faculty/staff", regid });
	}
	return records;
}

/** Best-effort PWS mTLS enrichment; returns a raw record when the cert tier is on. */
async function pwsFetch(env: Parameters<Fn["run"]>[0], regid: string): Promise<Record<string, unknown> | null> {
	const cert = env.UW_PWS_CERT;
	if (!cert) return null;
	try {
		const resp = await cert.fetch(`${PWS_BASE}/identity/v2/person/${regid}/full.json`, {
			headers: { Accept: "application/json", "User-Agent": UA },
			signal: AbortSignal.timeout(15_000),
		});
		if (!resp.ok) return null;
		return (await resp.json().catch(() => null)) as Record<string, unknown> | null;
	} catch {
		return null; // fail-closed: PWS is an enhancement, never a hard dependency
	}
}

/** Auto-route a free-form query to a directory search method. */
function routeMethod(query: string, explicit?: string): { method: Method; query: string } {
	if (explicit && explicit in METHOD_FIELD) {
		const method = explicit as Method;
		// A NetID given to the email method → {netid}@uw.edu.
		if (method === "email" && query && !query.includes("@")) return { method, query: `${query}@uw.edu` };
		return { method, query };
	}
	if (query.includes("@")) return { method: "email", query };
	const digits = query.replace(/\D/g, "");
	if (digits.length >= 7 && digits.length <= 11 && /^[\d\s().+-]+$/.test(query)) return { method: "phone", query };
	return { method: "name", query };
}

export const uw: Fn = {
	name: "uw",
	cost: 2,
	description:
		"UW person lookup — search the public University of Washington directory (directory.uw.edu) for faculty/staff by name, email/NetID, department, box number, or phone. Returns { query, method, count, truncated, results:[{ displayName, netid, email, title, department, positions[], phone, fax, boxNumber, category, regid }] }. `method` auto-detects (name / email when it has an @ / phone when it's digits); pass it to force one. NetID → email (looks up {netid}@uw.edu). Non-commercial single lookup only (RCW 42.56). Students are FERPA-gated behind UW sign-in and are NOT returned; suppressed people don't appear. A richer PWS tier activates automatically when the UW_PWS_CERT mTLS binding is set.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "The person to look up — a name, email, NetID, department, box number, or phone." },
			method: {
				type: "string",
				enum: ["auto", "name", "email", "department", "box", "phone"],
				default: "auto",
				description: "Search field. auto (default) picks name/email/phone from the query shape. box searches by mail-stop box number.",
			},
			students: {
				type: "boolean",
				default: false,
				description: "Set true only to signal you want a student — the student directory is FERPA-gated behind UW SAML sign-in, so this returns a sign-in-required note rather than results.",
			},
			limit: { type: "integer", minimum: 1, maximum: 50, default: 25, description: "Max records to return (a broad name can match hundreds; the rest are truncated)." },
		},
	},
	cacheable: true,
	ttl: 3600,
	annotations: { readOnlyHint: true, openWorldHint: true },
	run: async (env, args) => {
		const rawQuery = String(args?.query ?? "").trim();
		if (!rawQuery) return failWith("bad_input", "`query` is required — a name, email, NetID, department, box number, or phone.");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 25));
		const wantStudents = args?.students === true;

		const explicit = typeof args?.method === "string" && args.method !== "auto" ? args.method : undefined;
		const { method, query } = routeMethod(rawQuery, explicit);

		// One session cookie per lookup: GET primes it (single-use), POST spends it.
		let cookie: string;
		try {
			const g = await smartFetch(env, `${BASE}/`, { headers: { "User-Agent": UA, Accept: "text/html" } });
			if (g.status >= 400) return failWith("upstream_error", `directory.uw.edu returned HTTP ${g.status} priming the session.`);
			const setCookie = g.headers.get("set-cookie") ?? "";
			const sess = setCookie.match(/edu\.uw\.directory\.session=[^;]+/)?.[0];
			if (!sess) return failWith("layout_change", "directory.uw.edu did not set the expected session cookie — the form may have changed.");
			cookie = sess;
		} catch (e) {
			return failWith("upstream_error", `directory.uw.edu unreachable: ${String((e as Error)?.message ?? e)}`);
		}

		const body = new URLSearchParams({
			query,
			method: METHOD_FIELD[method],
			population: "employees",
			length: "full",
		}).toString();

		let html: string;
		try {
			const resp = await smartFetch(env, `${BASE}/`, {
				method: "POST",
				headers: {
					"User-Agent": UA,
					Accept: "text/html",
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: cookie,
				},
				body,
			});
			if (resp.status >= 400) return failWith("upstream_error", `directory.uw.edu search returned HTTP ${resp.status}.`);
			html = await resp.text();
		} catch (e) {
			return failWith("upstream_error", `directory.uw.edu search failed: ${String((e as Error)?.message ?? e)}`);
		}

		if (isStudentGated(html, wantStudents)) {
			return ok(
				JSON.stringify(
					{
						query: rawQuery,
						method,
						sign_in_required: true,
						note: "Student directory entries are FERPA-gated behind UW SAML sign-in (directory.uw.edu/saml/login). sux does not authenticate as a user, so students aren't returned. Faculty/staff lookups work without sign-in.",
					},
					null,
					2,
				),
			);
		}

		const all = parseCards(html);
		if (!all.length) {
			return ok(
				JSON.stringify(
					{
						query: rawQuery,
						method,
						count: 0,
						results: [],
						note: "No public faculty/staff match. Students and suppressed/FERPA-restricted people don't appear in the anonymous directory.",
					},
					null,
					2,
				),
			);
		}

		const results = all.slice(0, limit);

		// PWS mTLS tier (fail-closed): enrich each returned record when the cert is set.
		if (env.UW_PWS_CERT) {
			await Promise.all(
				results.map(async (r) => {
					if (!r.regid) return;
					const pws = await pwsFetch(env, r.regid);
					if (pws) (r as PersonRecord & { pws?: unknown }).pws = pws;
				}),
			);
		}

		return ok(
			JSON.stringify(
				{
					query: rawQuery,
					method,
					count: results.length,
					truncated: all.length > results.length,
					total_matches: all.length,
					results,
				},
				null,
				2,
			),
		);
	},
};
