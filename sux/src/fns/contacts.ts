import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const contacts: Fn = {
	name: "contacts",
	description: "Extract contact details from a page: email addresses, phone numbers, and social links (twitter/linkedin/github/etc). Pass a url or raw html.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: { url: { type: "string" }, html: { type: "string" } },
	},
	cacheable: true,
	run: async (env, args) => {
		let html = String(args?.html ?? "");
		if (!html && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");

		const emails = new Set<string>();
		for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) emails.add(m[0].toLowerCase());
		for (const m of html.matchAll(/mailto:([^"'?]+)/gi)) emails.add(m[1].toLowerCase());

		const phones = new Set<string>();
		for (const m of html.matchAll(/tel:([+\d][\d\s().-]{6,})/gi)) phones.add(m[1].trim());
		for (const m of html.matchAll(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g)) phones.add(m[0].trim());

		const social = new Set<string>();
		for (const m of html.matchAll(/https?:\/\/(?:www\.)?(twitter|x|linkedin|github|facebook|instagram|youtube|t)\.(?:com|me)\/[A-Za-z0-9_./-]+/gi)) social.add(m[0]);

		return ok(
			JSON.stringify(
				{ emails: [...emails].slice(0, 100), phones: [...phones].slice(0, 100), social: [...social].slice(0, 100) },
				null,
				2,
			),
		);
	},
};
