import { type Fn, fail, ok } from "../registry";

// Lightweight regex NER. No model, no network — pure pattern extraction over
// plain text. Each matcher is intentionally conservative to keep false
// positives low; results are deduped (case-insensitive).

const RE = {
	// URLs first (so emails/handles inside them don't get double-counted).
	url: /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/gi,
	email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
	// ISO 8601 date / datetime.
	iso_date: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
	// e.g. "Jan 5, 2024", "5 January 2024", "January 5th 2024".
	text_date:
		/\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4})\b/gi,
	// Slash / dash numeric dates: 12/31/2024, 2024/12/31, 31-12-2024.
	numeric_date: /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g,
	// Currency: $1,234.56 · €10 · £5 · ¥100 · ₹50 · $12.5M · $500K · 1,234.56 USD.
	// A trailing K/M/B/T magnitude suffix is kept (but not when it starts a word).
	money: /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?[KMBT](?![A-Za-z]))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|JPY|CNY|INR|CAD|AUD|CHF|BTC|ETH)\b)/gi,
	percent: /\b\d+(?:\.\d+)?\s?%/g,
	// Phone: optional +country and grouped digits; requires a separator so plain integers are skipped.
	phone: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4})?/g,
	// @handles not preceded by a word char (so emails' "@" is excluded).
	handle: /(?<![\w@.])@[A-Za-z0-9_]{2,30}\b/g,
	hashtag: /(?<![\w&])#[A-Za-z][A-Za-z0-9_]{0,49}\b/g,
};

function collect(text: string, re: RegExp): string[] {
	const seen = new Map<string, string>();
	for (const m of text.matchAll(re)) {
		const val = m[0].trim();
		if (!val) continue;
		const key = val.toLowerCase();
		if (!seen.has(key)) seen.set(key, val);
	}
	return [...seen.values()];
}

export const entities: Fn = {
	name: "entities",
	description:
		"Lightweight entity extraction (regex NER, no model/network). Extracts dates (ISO + common text/numeric formats), money/amounts (currency symbols and ISO codes), percentages, emails, URLs, phone numbers, @handles and #hashtags from plain text. Returns JSON grouped by type, deduped.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Plain text to scan for entities." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const text = typeof args?.text === "string" ? args.text : "";
		if (!text.trim()) return fail("Provide non-empty `text`.");

		// Remove URLs/emails before scanning for dates & phones so their digits
		// don't masquerade as phone numbers or numeric dates.
		const masked = text.replace(RE.url, " ").replace(RE.email, " ");

		const dates = [...collect(text, RE.iso_date), ...collect(masked, RE.text_date), ...collect(masked, RE.numeric_date)];
		const dedupedDates = [...new Map(dates.map((d) => [d.toLowerCase(), d])).values()];

		// Also strip dates before the phone scan — an ISO date like 2026-01-15 otherwise
		// matches the grouped-digits phone pattern and leaks into `phones`.
		const phoneSource = masked.replace(RE.iso_date, " ").replace(RE.numeric_date, " ").replace(RE.text_date, " ");

		const result = {
			dates: dedupedDates,
			money: collect(text, RE.money),
			percentages: collect(text, RE.percent),
			emails: collect(text, RE.email),
			urls: collect(text, RE.url),
			phones: collect(phoneSource, RE.phone).filter((p) => (p.match(/\d/g)?.length ?? 0) >= 7),
			handles: collect(text, RE.handle),
			hashtags: collect(text, RE.hashtag),
		};

		return ok(JSON.stringify(result, null, 2));
	},
};
