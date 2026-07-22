// NSLDS `MyStudentData.txt` detection + parsing (#1323) — the federal student-loan
// aggregate download from studentaid.gov/NSLDS. There is no individual-borrower API
// (login+MFA+Akamai-gated) and the file's exact field layout has drifted across years
// (NSLDS revises it periodically; no fixture was available to lock the layout against
// at build time — see the issue's own caveat). So this parses GENERICALLY: flat
// `Key: Value` lines, grouped into per-loan records by noticing which key repeats most
// often (the field every loan record has in common, e.g. "Loan Type"), rather than
// hardcoding an exact schema. Every raw field is preserved verbatim in the rendered
// note even when a "known field" (status/servicer/rate/...) isn't recognized by the
// fuzzy matchers below — so a layout change degrades to "less pretty" never "data lost".

const LINE_RE = /^([A-Za-z][A-Za-z0-9 /()',._-]{1,80}?):[ \t]?(.*)$/;

/** Parses every `Key: Value` line in the text, in order (blank/non-matching lines dropped). */
export function parseKvLines(text: string): [string, string][] {
	const out: [string, string][] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const m = LINE_RE.exec(line);
		if (m) out.push([m[1].trim(), m[2].trim()]);
	}
	return out;
}

// Vocabulary that's survived every NSLDS layout revision seen in public documentation/
// third-party parsers — used only to raise confidence alongside the shape check, never
// alone (a random colon-delimited doc could otherwise false-positive).
const NSLDS_VOCAB: RegExp[] = [
	/nslds/i,
	/loan\s*type/i,
	/loan\s*status/i,
	/servicer/i,
	/outstanding\s*principal/i,
	/interest\s*rate/i,
	/pslf/i,
	/disbursement/i,
	/guaranty\s*agency/i,
	/aggregate/i,
];

/** Shape (mostly `Key: Value` lines) + vocabulary (several NSLDS-specific field names) —
 *  both required so a generic colon-delimited document doesn't false-positive. */
export function looksLikeNsldsFile(text: string): boolean {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length < 8) return false;
	const pairs = parseKvLines(text);
	if (pairs.length / lines.length < 0.5) return false;
	const hits = NSLDS_VOCAB.filter((re) => pairs.some(([k, v]) => re.test(k) || re.test(v))).length;
	return hits >= 3;
}

export interface NsldsParsed {
	header: Record<string, string>;
	loans: Record<string, string>[];
	anchorKey?: string;
}

/** Groups the flat field list into per-loan records: the most-repeated key is treated
 *  as "this line starts a new loan" (every loan record includes it exactly once), and
 *  everything seen before its first occurrence is student-level header/totals. Falls
 *  back to a single loan-record (no header) when nothing repeats — e.g. a one-loan file. */
export function parseNsldsFile(text: string): NsldsParsed {
	const pairs = parseKvLines(text);
	const counts = new Map<string, number>();
	for (const [k] of pairs) counts.set(k, (counts.get(k) ?? 0) + 1);
	let anchorKey: string | undefined;
	let anchorCount = 1;
	for (const [k, c] of counts) {
		if (c > anchorCount) {
			anchorCount = c;
			anchorKey = k;
		}
	}
	const header: Record<string, string> = {};
	const loans: Record<string, string>[] = [];
	let current: Record<string, string> | null = null;
	for (const [k, v] of pairs) {
		if (anchorKey && k === anchorKey) {
			if (current) loans.push(current);
			current = {};
		}
		if (current) current[k] = v;
		else header[k] = v;
	}
	if (current) loans.push(current);
	if (!loans.length && Object.keys(header).length) {
		loans.push(header);
		return { header: {}, loans, anchorKey };
	}
	return { header, loans, anchorKey };
}

const pick = (rec: Record<string, string>, patterns: RegExp[]): string | undefined => {
	for (const [k, v] of Object.entries(rec)) if (patterns.some((re) => re.test(k))) return v;
	return undefined;
};

function parseMoney(v?: string): number | undefined {
	if (!v) return undefined;
	const m = /-?\$?\s*[\d,]+(\.\d+)?/.exec(v);
	if (!m) return undefined;
	const n = Number(m[0].replace(/[$,\s]/g, ""));
	return Number.isFinite(n) ? n : undefined;
}

function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export interface NsldsNote {
	title: string;
	body: string;
	tags: string[];
	frontmatter: Record<string, string | number>;
}

/** Detects + parses in one call for `ingest`'s call site. Returns null when the text
 *  doesn't look like an NSLDS export (the normal case for everything else tossed in). */
export function tryRenderNsldsNote(text: string, date: string): NsldsNote | null {
	if (!looksLikeNsldsFile(text)) return null;
	const parsed = parseNsldsFile(text);
	const lines: string[] = [`# Federal Student Loans — NSLDS (as of ${date})`, ""];
	if (Object.keys(parsed.header).length) {
		lines.push("## Summary", "");
		for (const [k, v] of Object.entries(parsed.header)) lines.push(`- **${k}:** ${v}`);
		lines.push("");
	}
	lines.push(`## Loans (${parsed.loans.length})`, "");
	let totalPrincipal = 0;
	let principalFound = false;
	parsed.loans.forEach((loan, i) => {
		const type = pick(loan, [/^loan\s*type$/i, /loan\s*type\b/i]);
		const status = pick(loan, [/loan\s*status/i]);
		const servicer = pick(loan, [/servicer/i]);
		const principal = pick(loan, [/outstanding\s*principal/i, /principal\s*balance/i]);
		const interest = pick(loan, [/outstanding\s*interest/i, /interest\s*balance/i]);
		const rate = pick(loan, [/interest\s*rate/i]);
		const plan = pick(loan, [/repayment\s*plan/i]);
		const pslf = pick(loan, [/pslf/i, /cumulative.*match/i]);
		lines.push(`### Loan ${i + 1}${type ? `: ${type}` : ""}`, "");
		if (status) lines.push(`- **Status:** ${status}`);
		if (servicer) lines.push(`- **Servicer:** ${servicer}`);
		if (principal) lines.push(`- **Outstanding principal:** ${principal}`);
		if (interest) lines.push(`- **Outstanding interest:** ${interest}`);
		if (rate) lines.push(`- **Interest rate:** ${rate}`);
		if (plan) lines.push(`- **Repayment plan:** ${plan}`);
		if (pslf) lines.push(`- **PSLF cumulative matched months:** ${pslf} (proxy — not MOHELA's authoritative count)`);
		lines.push("", "<details><summary>All fields</summary>", "");
		for (const [k, v] of Object.entries(loan)) lines.push(`- ${k}: ${v}`);
		lines.push("", "</details>", "");
		const p = parseMoney(principal);
		if (p != null) {
			totalPrincipal += p;
			principalFound = true;
		}
	});

	const frontmatter: Record<string, string | number> = {
		kind: "student-loan-aggregate",
		loan_count: parsed.loans.length,
		next_review: addDays(date, 91),
	};
	if (principalFound) frontmatter.total_outstanding_principal = Math.round(totalPrincipal * 100) / 100;

	return {
		title: `Federal Student Loans — NSLDS ${date}`,
		body: lines.join("\n"),
		tags: ["student-loan", "nslds"],
		frontmatter,
	};
}
