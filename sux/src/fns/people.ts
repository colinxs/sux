import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";
import { kagiTool } from "../kagi";
import { smartFetch } from "../proxy";

// Search public people & organization directories. Individual-directory backends
// (e.g. directory.uw.edu) sit behind institutional auth / JS SPAs, so the
// reliable, key-free path is: source=web → a Kagi people/directory search; and
// source=usagov → the USA.gov federal agency directory. `extract_contacts` pulls
// emails/phones from the top hit's page (residential fetch) for the web source.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

function parseKagiHits(md: string): Array<{ title: string; url: string; snippet?: string }> {
	const hits: Array<{ title: string; url: string; snippet?: string }> = [];
	for (const block of md.split(/\n(?=###\s*\[)/)) {
		const m = block.match(/###\s*\[([^\]]+)\]\(([^)]+)\)/);
		if (!m) continue;
		const snippet = block.replace(/###\s*\[[^\]]+\]\([^)]+\)/, "").trim().split("\n")[0];
		hits.push({ title: m[1].trim(), url: m[2].trim(), snippet: snippet || undefined });
	}
	return hits;
}

export const people: Fn = {
	name: "people",
	cost: 3,
	description:
		"Search public people & organization directories. source: web (default) — a Kagi people/directory search (great for finding a person's affiliation, title, profile, or an org's page); usagov — the USA.gov federal agency directory (name → agency contact info). `query` is the person/org name. With source=web, extract_contacts:true also fetches the top result and pulls emails/phones from it (via the residential proxy). For the University of Washington directory specifically, use the dedicated `uw` fn (scrapes directory.uw.edu directly, no credentials needed for faculty/staff).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Person or organization name to look up." },
			source: { type: "string", enum: ["web", "usagov"], default: "web" },
			limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
			extract_contacts: { type: "boolean", default: false, description: "web only: fetch the top result and extract emails/phones." },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (env, args) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return fail("`query` is required.");
		const source = String(args?.source ?? "web");
		const limit = Math.min(20, Math.max(1, Number(args?.limit) || 10));

		try {
			if (source === "usagov") {
				const url = `https://www.usa.gov/api/USAGovAPI/contacts.json/search.json?query=${encodeURIComponent(query)}`;
				const resp = await smartFetch(env, url, { headers: { Accept: "application/json" } });
				if (resp.status >= 400) return fail(`USA.gov directory returned HTTP ${resp.status} (this legacy API is being deprecated; try source=web).`);
				const j = (await resp.json().catch(() => null)) as any;
				const contacts = (j?.Contacts ?? j?.contacts ?? []).slice(0, limit).map((c: any) => ({
					name: c?.Name ?? c?.name,
					url: c?.Web?.[0]?.Url ?? c?.URI,
					phones: (c?.Phone ?? []).map((p: any) => p?.Number ?? p).filter(Boolean),
					email: c?.Email?.[0],
				}));
				if (!contacts.length) return ok(`(no USA.gov agencies found for "${query}")`);
				return ok(oj({ source: "usagov", query, count: contacts.length, contacts }));
			}

			// source=web — Kagi people/directory search.
			const r = await kagiTool(env, "kagi_search_fetch", { query: `${query} (profile OR directory OR contact OR staff)`, limit }, "auto");
			if (!r || r.isError) return fail(`People search failed for "${query}".`);
			const hits = parseKagiHits(r.content?.[0]?.text ?? "").slice(0, limit);
			if (!hits.length) return ok(`(no results for "${query}")`);

			let contacts: { emails: string[]; phones: string[]; from: string } | undefined;
			if (args?.extract_contacts === true && hits[0]?.url) {
				try {
					const page = await smartFetch(env, hits[0].url, {});
					if (page.status < 400) {
						const text = await page.text();
						contacts = {
							emails: [...new Set(text.match(EMAIL_RE) ?? [])].slice(0, 10),
							phones: [...new Set(text.match(PHONE_RE) ?? [])].slice(0, 10),
							from: hits[0].url,
						};
					}
				} catch {
					/* contact extraction is best-effort */
				}
			}
			return ok(oj({ source: "web", query, count: hits.length, hits, ...(contacts ? { contacts } : {}) }));
		} catch (e) {
			return fail(`people (${source}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
