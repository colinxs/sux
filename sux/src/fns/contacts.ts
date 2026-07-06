import { type Fn, fail, ok } from "../registry";
import { isHttpUrl, fetchText, stripHtml } from "./_util";

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// US-style (with optional country code) OR an E.164-ish international run.
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{7,15}\b/g;

// Social profiles: each matches `domain/handle` (any scheme/subdomain around it),
// with a set of reserved paths that are pages, not profiles.
const SOCIAL: Record<string, { re: RegExp; skip: Set<string> }> = {
	twitter: { re: /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/gi, skip: new Set(["home", "search", "i", "intent", "share", "hashtag", "explore", "settings", "login"]) },
	github: { re: /github\.com\/([A-Za-z0-9-]{1,39})/gi, skip: new Set(["features", "about", "pricing", "login", "join", "marketplace", "sponsors", "topics", "explore", "settings", "orgs", "apps", "contact", "search"]) },
	linkedin: { re: /linkedin\.com\/(?:in|company)\/([A-Za-z0-9-]+)/gi, skip: new Set() },
	instagram: { re: /instagram\.com\/([A-Za-z0-9_.]+)/gi, skip: new Set(["explore", "about", "developer", "p", "reel"]) },
	facebook: { re: /facebook\.com\/([A-Za-z0-9.]+)/gi, skip: new Set(["sharer", "login", "help", "pages", "profile"]) },
	youtube: { re: /youtube\.com\/(@[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+|c\/[A-Za-z0-9_-]+|user\/[A-Za-z0-9_-]+)/gi, skip: new Set() },
	tiktok: { re: /tiktok\.com\/(@[A-Za-z0-9_.]+)/gi, skip: new Set() },
	mastodon: { re: /mastodon\.(?:social|online)\/(@[A-Za-z0-9_]+)/gi, skip: new Set() },
	telegram: { re: /t\.me\/([A-Za-z0-9_]{3,})/gi, skip: new Set(["share", "joinchat"]) },
	bluesky: { re: /bsky\.app\/profile\/([A-Za-z0-9_.-]+)/gi, skip: new Set() },
};

/** Pull social-profile handles from a raw source (keeps hrefs — scan before stripping). */
function extractSocials(source: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [platform, { re, skip }] of Object.entries(SOCIAL)) {
		const found = new Set<string>();
		for (const m of source.matchAll(re)) {
			const handle = m[1];
			if (!handle || skip.has(handle.toLowerCase())) continue;
			found.add(handle);
		}
		if (found.size) out[platform] = [...found].slice(0, 50);
	}
	return out;
}

export const contacts: Fn = {
	name: "contacts",
	description:
		"Extract contact info — email addresses, phone numbers (US and E.164-style), and social profiles (twitter/x, github, linkedin, instagram, facebook, youtube, tiktok, mastodon, telegram, bluesky) — from a page or text. Pass `url`, `html`, or plain `text`. Social links are read from the raw source (hrefs); emails/phones from the stripped text. Returns JSON { emails, phones, socials } (deduped).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) and scan." },
			html: { type: "string", description: "Raw HTML to scan (hrefs kept for socials; stripped for emails/phones)." },
			text: { type: "string", description: "Plain text to scan directly." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let raw = "";
		if (typeof args?.text === "string" && args.text) {
			raw = args.text;
		} else if (typeof args?.html === "string" && args.html) {
			raw = args.html;
		} else if (args?.url) {
			if (!isHttpUrl(args.url)) return fail("url must be an absolute http(s) URL.");
			raw = (await fetchText(env, String(args.url))).text;
		} else {
			return fail("Provide `url`, `html`, or `text`.");
		}
		// Emails/phones read cleanest from stripped text; socials from the raw source.
		const text = stripHtml(raw);

		const emails = new Set<string>();
		for (const m of text.matchAll(EMAIL)) emails.add(m[0].toLowerCase());

		const phones = new Set<string>();
		for (const m of text.matchAll(PHONE)) {
			const raw2 = m[0].trim();
			const digits = raw2.replace(/\D/g, "");
			if (digits.length >= 7 && digits.length <= 15) phones.add(raw2);
		}

		return ok(
			JSON.stringify(
				{ emails: [...emails].slice(0, 200), phones: [...phones].slice(0, 200), socials: extractSocials(raw) },
				null,
				2,
			),
		);
	},
};
