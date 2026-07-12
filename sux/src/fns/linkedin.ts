import { type Fn, fail, ok } from "../registry";
import { renderHtml, oj } from "./_util";

// LinkedIn public data by SCRAPING (Proxycurl — the old provider path — shut down
// in July 2025 after LinkedIn sued Nubela). We render the public profile/company
// page through the residential `render` fn's `mac` backend (headed patched
// browser + CapSolver, which clears LinkedIn's active bot wall) and extract the
// structured data LinkedIn publishes on the page itself: schema.org JSON-LD
// (Person / Organization) plus og: meta as a fallback. Distilled to token-cheap
// fields. Public-page data only — deeper fields need an authenticated session.

/** Parse every <script type="application/ld+json"> block, flattening @graph. */
export function parseJsonLd(html: string): any[] {
	const out: any[] = [];
	const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		try {
			const j = JSON.parse(m[1].trim());
			for (const node of Array.isArray(j) ? j : j["@graph"] ? j["@graph"] : [j]) out.push(node);
		} catch {
			/* skip malformed block */
		}
	}
	return out;
}

const ogMeta = (html: string, prop: string): string | undefined =>
	html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`, "i"))?.[1];

const asArray = (v: any): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function extractPerson(html: string): Record<string, unknown> {
	const person = parseJsonLd(html).find((n) => String(n?.["@type"]).toLowerCase() === "person") ?? {};
	const worksFor = asArray(person.worksFor);
	const alumni = asArray(person.alumniOf);
	const ogTitle = ogMeta(html, "title"); // usually "Name - Headline | LinkedIn"
	return {
		name: person.name ?? ogTitle?.split(" - ")[0]?.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim(),
		headline: person.jobTitle ?? person.description ?? ogTitle?.split(" - ").slice(1).join(" - ").replace(/\s*\|\s*LinkedIn\s*$/i, "").trim() ?? ogMeta(html, "description"),
		location: [person.address?.addressLocality, person.address?.addressRegion, person.address?.addressCountry].filter(Boolean).join(", ") || undefined,
		current: worksFor.slice(0, 3).map((w) => (typeof w === "string" ? w : w?.name)).filter(Boolean),
		education: alumni.slice(0, 3).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean),
		image: person.image?.contentUrl ?? person.image,
		url: person.url ?? person["@id"],
	};
}

export function extractCompany(html: string): Record<string, unknown> {
	const org = parseJsonLd(html).find((n) => /organization|corporation/i.test(String(n?.["@type"]))) ?? {};
	return {
		name: org.name ?? ogMeta(html, "title")?.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim(),
		description: org.description ?? ogMeta(html, "description"),
		website: org.url ?? asArray(org.sameAs)[0],
		employees: org.numberOfEmployees?.value ?? org.numberOfEmployees,
		industry: org.industry,
		location: [org.address?.addressLocality, org.address?.addressCountry].filter(Boolean).join(", ") || undefined,
	};
}

export const linkedin: Fn = {
	name: "linkedin",
	cost: 5, // scrapes via a full headed-browser render (mac backend) — heavy
	description:
		"LinkedIn public profile/company data by scraping (the old Proxycurl API shut down July 2025). action: person (default) resolves a profile URL; company resolves a company URL. Renders the public page through the residential `render` mac backend (headed browser + CapSolver to clear the bot wall) and extracts schema.org JSON-LD (Person/Organization) + og: meta, distilled to token-cheap fields. Needs the mac render backend configured (MAC_RENDER_URL/MAC_RENDER_SECRET). Public-page fields only — deeper data needs an authenticated session.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "A linkedin.com profile or company URL." },
			action: { type: "string", enum: ["person", "company"], default: "person" },
		},
	},
	cacheable: true,
	ttl: 86400, // profiles change slowly; each lookup is an expensive render — cache hard
	run: async (env, args) => {
		const url = String(args?.url ?? "").trim();
		if (!/^https?:\/\/([\w-]+\.)*linkedin\.com\//i.test(url)) return fail("`url` must be a linkedin.com profile or company URL.");
		const action = String(args?.action ?? "person") === "company" ? "company" : "person";

		try {
			// Anti-bot render via the mac backend (headed browser + CapSolver).
			const html = await renderHtml(env, url);
			if (!parseJsonLd(html).length && /authwall|sign in to LinkedIn|Join LinkedIn to view/i.test(html)) {
				return fail("LinkedIn returned an auth wall (no public data). This profile needs an authenticated session.");
			}
			const data = action === "company" ? extractCompany(html) : extractPerson(html);
			if (!data.name) return fail("Could not extract public profile data from the LinkedIn page (structure may have changed or the page is gated).");
			return ok(oj(data));
		} catch (e) {
			return fail(`linkedin render/scrape failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
