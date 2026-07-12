import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";

// arXiv API (export.arxiv.org) — keyless, free, returns Atom XML. No residential
// proxy: this is a public academic endpoint with no bot wall, so a plain fetch is
// correct and cheaper. Entries are parsed with a small regex reader (the same
// shape feed.ts uses) rather than the full XML parser — arXiv's Atom is regular
// and the fields we want are shallow.

const API = "http://export.arxiv.org/api/query";

function decodeEntities(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&amp;/gi, "&");
}

/** First inner text of <name>…</name> within `xml`, entity-decoded and collapsed. */
function tag(xml: string, name: string): string | null {
	const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
	return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
}

function normEntry(b: string): Record<string, unknown> {
	const id = tag(b, "id");
	const authors = [...b.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((m) =>
		decodeEntities(m[1]).replace(/\s+/g, " ").trim(),
	);
	const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
	const attr = (s: string, a: string): string | null => s.match(new RegExp(`\\b${a}=["']([^"']*)["']`, "i"))?.[1] ?? null;
	const pdf = links.find((l) => attr(l, "title") === "pdf" || attr(l, "type") === "application/pdf");
	const alt = links.find((l) => attr(l, "rel") === "alternate");
	const categories = [...b.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)].map((m) => m[1]);
	return {
		id,
		title: tag(b, "title"),
		authors,
		summary: tag(b, "summary"),
		published: tag(b, "published"),
		url: (alt && attr(alt, "href")) ?? id,
		pdf_url: pdf ? attr(pdf, "href") : id ? id.replace("/abs/", "/pdf/") : null,
		categories,
	};
}

export const arxiv: Fn = {
	name: "arxiv",
	description:
		"Search arXiv (keyless, free) — physics, math, CS, quantitative biology, and more preprints. Provide `term` (matched across all fields). Returns normalized JSON { count, results:[{ id, title, authors[], summary, published, url, pdf_url, categories[] }] }. Tune with `max_results` (default 10, max 50) and `sort_by` (relevance|lastUpdatedDate|submittedDate).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search terms (matched across all arXiv fields)." },
			max_results: { type: "integer", minimum: 1, maximum: 50, default: 10 },
			sort_by: { type: "string", enum: ["relevance", "lastUpdatedDate", "submittedDate"], default: "relevance" },
		},
	},
	cacheable: true,
	ttl: 1800,
	run: async (_env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const maxResults = Math.min(50, Math.max(1, Number(args?.max_results) || 10));
		const sortBy = ["relevance", "lastUpdatedDate", "submittedDate"].includes(args?.sort_by) ? args.sort_by : "relevance";

		const p = new URLSearchParams({
			search_query: `all:${term}`,
			start: "0",
			max_results: String(maxResults),
			sortBy,
		});
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`);
		} catch (e) {
			return fail(`arXiv fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`arXiv API HTTP ${resp.status}.`);
		const xml = await resp.text();
		const results = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => normEntry(m[0]));
		return ok(oj({ count: results.length, results }));
	},
};
