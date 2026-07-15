import { type Fn, fail, ok } from "../registry";
import { hasAI, llm } from "../ai";
import { kagiTool } from "../kagi";
import { type Route, smartFetch } from "../proxy";
import { renderHtml, stripHtml } from "./_util";

export type Hit = { title: string; url: string; snippet?: string };

const fmt = (hits: Hit[]): string =>
	hits.length ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n\n") : "(no results)";

/** Real destination from a Google result anchor (direct link or /url?q= redirect). */
function unwrapGoogleUrl(href: string): string | null {
	if (href.startsWith("/url?") || href.startsWith("/url&")) {
		try {
			return new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("q");
		} catch {
			return null;
		}
	}
	return /^https?:\/\//.test(href) ? href : null;
}

/** Parse a Google SERP HTML page into result hits (anchor wrapping an <h3>),
 * dropping Google's own hosts. Tolerant to markup churn — title + url only. */
export function parseGoogleSerp(html: string, limit: number): Hit[] {
	const hits: Hit[] = [];
	const seen = new Set<string>();
	const re = /<a [^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S]){0,400}?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && hits.length < limit) {
		const url = unwrapGoogleUrl(m[1]);
		if (!url) continue;
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			continue;
		}
		const host = u.hostname;
		if (!host || /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com)$/i.test(host)) continue;
		// YouTube's off-site redirect wrapper (youtube.com/redirect?q=…) — the
		// /redirect lives in the path, never the hostname, so match host + pathname.
		if (/(^|\.)youtube\.com$/i.test(host) && u.pathname === "/redirect") continue;
		const title = stripHtml(m[2]).trim();
		if (!title) continue;
		const key = normUrl(url);
		if (seen.has(key)) continue;
		seen.add(key);
		hits.push({ title, url });
	}
	return hits;
}

/** Parse DuckDuckGo's html/lite endpoint: result anchors carry the real URL in a
 * //duckduckgo.com/l/?uddg=<encoded> redirect wrapper. Clean, key-free, no JS. */
export function parseDdg(html: string, limit: number): Hit[] {
	const hits: Hit[] = [];
	const seen = new Set<string>();
	const re = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && hits.length < limit) {
		const uddg = m[1].match(/[?&]uddg=([^&]+)/);
		let url: string;
		if (uddg) {
			try {
				url = decodeURIComponent(uddg[1]);
			} catch {
				continue; // truncated/invalid percent-escape in the redirect param — skip this anchor, keep the rest
			}
		} else {
			url = m[1].startsWith("//") ? `https:${m[1]}` : m[1];
		}
		if (!/^https?:\/\//.test(url)) continue;
		const title = stripHtml(m[2]).trim();
		if (!title || seen.has(url)) continue;
		seen.add(url);
		hits.push({ title, url });
	}
	return hits;
}

// DuckDuckGo, DIRECT — the html endpoint returns real results with no JS and no
// key, so it goes through the residential proxy (curl-impersonate on the node).
// The cheap keyless engine (vs google's heavy render).
async function ddg(env: any, q: string, limit: number, route: Route): Promise<Hit[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
	const resp = await smartFetch(env, url, { headers: { "Accept-Language": "en-US,en;q=0.9" } }, route === "direct" ? "auto" : route);
	if (resp.status >= 400) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
	return parseDdg(await resp.text(), limit);
}

// Google, DIRECT — no SerpAPI. Google now gates results behind JS (a plain HTTP
// fetch, even residential/curl-impersonate, returns an empty JS shell), so we
// render the SERP in the `render` mac backend (headed browser + CapSolver clears
// the bot wall) and parse the post-JS HTML. Real Google results, no third-party
// SERP API — but heavier than an API call, so google is an opt-in engine.
async function googleDirect(env: any, q: string, limit: number, _route: Route): Promise<Hit[]> {
	// Over-request: Google's SERP host drops (google/gstatic) and dedupe shrink the
	// parsed hit count, so ask for more than `limit` (up to Google's ~40 ceiling) or
	// a high limit can never be honored.
	const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${Math.min(40, limit + 10)}&hl=en`;
	return parseGoogleSerp(await renderHtml(env, url), limit);
}

// Brave dropped its free tier in Feb 2026 — it's now metered-only (~$5/1k queries)
// with just a $5/mo credit and NO default spend cap, so any use here can quietly
// rack up charges once the credit runs out. Left key-gated (BRAVE_API_KEY unset by
// default) rather than picked automatically; `all` still includes it (opt-in via
// the key), but the auto-fallback prefers the free-tier `exa` engine over this one.
// Spend-cap enforcement is out of scope for this file (needs quota-tracking infra
// this fn doesn't have) — set a budget alert/cap on the Brave account itself.
async function brave(env: any, q: string, limit: number, _route: Route): Promise<Hit[]> {
	const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, {
		headers: { "X-Subscription-Token": env.BRAVE_API_KEY, Accept: "application/json" },
	});
	if (!resp.ok) throw new Error(`Brave HTTP ${resp.status}`);
	const j = (await resp.json()) as any;
	return (j?.web?.results ?? []).slice(0, limit).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description }));
}

// Exa — genuine 20,000 req/mo free tier (as of 2026), so it's the preferred
// key-gated fallback ahead of the now-metered-only Brave. Response shape:
// { results: [{ title, url, ... }] }.
async function exa(env: any, q: string, limit: number, _route: Route): Promise<Hit[]> {
	const resp = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": env.EXA_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ query: q, numResults: limit }),
	});
	if (!resp.ok) throw new Error(`Exa HTTP ${resp.status}`);
	const j = (await resp.json()) as any;
	return (j?.results ?? []).slice(0, limit).map((r: any) => ({ title: r.title, url: r.url, snippet: r.text ?? r.summary }));
}

// Kagi (the flagship) — its hosted MCP returns markdown `### [title](url)` blocks.
async function kagi(env: any, q: string, limit: number, route: Route): Promise<Hit[]> {
	const r = await kagiTool(env, "kagi_search_fetch", { query: q, limit }, route);
	const md = r?.content?.[0]?.text ?? "";
	const hits: Hit[] = [];
	for (const block of md.split(/\n(?=###\s*\[)/)) {
		const m = block.match(/###\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
		if (!m) continue;
		const snippet = stripHtml(block.replace(/###\s*\[[^\]]+\]\([^)]+\)/, "").replace(/\*\*[^*]+:\*\*[^\n]*/g, "")).slice(0, 300);
		hits.push({ title: m[1], url: m[2], snippet });
		if (hits.length >= limit) break;
	}
	return hits;
}

export type SearchScope = { file_type?: string; include_domains?: string[]; exclude_domains?: string[] };

/** Fold file_type/domain scoping into documented Kagi query operators (filetype:, site:,
 * -site:) rather than structured API params — these work identically as plain query text
 * on both the metered API and the session-scrape /html/search page (verified against
 * https://help.kagi.com/kagi/features/search-operators.html and the unofficial kagi-ken
 * client, which has no structured params at all — just `q=`). One code path covers both
 * Kagi engines; lenses have no operator equivalent so aren't handled here. */
export function withOperators(query: string, scope?: SearchScope): string {
	if (!scope) return query;
	const parts = [query];
	if (scope.file_type) parts.push(`filetype:${scope.file_type}`);
	for (const d of scope.include_domains ?? []) parts.push(`site:${d}`);
	for (const d of scope.exclude_domains ?? []) parts.push(`-site:${d}`);
	return parts.join(" ");
}

const unesc = (s: string): string =>
	s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

/** Parse Kagi's server-rendered /html/search page (the no-JS variant). Each result is a
 * `.search-result` block: the title anchor carries `class="…__sri_title_link…" href="URL"`
 * and the summary lives in the sibling `.__sri-desc`. Verified against live markup. */
export function parseKagiSession(html: string, limit: number): Hit[] {
	const hits: Hit[] = [];
	const seen = new Set<string>();
	for (const block of html.split(/(?=<div class="_0_SRI)/)) {
		if (hits.length >= limit) break;
		const t = block.match(/<a\b[^>]*class="[^"]*__sri_title_link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
		if (!t) continue;
		const url = unesc(t[1]);
		if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
		const title = unesc(stripHtml(t[2])).trim();
		if (!title) continue;
		const d = block.match(/class="[^"]*__sri-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
		const snippet = d ? unesc(stripHtml(d[1])).trim().slice(0, 300) : undefined;
		seen.add(url);
		hits.push({ title, url, snippet });
	}
	return hits;
}

// Kagi via the user's SUBSCRIPTION (not the metered API): the Session Link token
// authenticates the /html/search page as the account, so results are unmetered on
// paid tiers. Routed through the residential proxy so the request looks like a normal
// home browser (Kagi bot-gates datacenter IPs). No JS needed — /html/search is SSR.
async function kagiSession(env: any, q: string, limit: number, route: Route): Promise<Hit[]> {
	const url = `https://kagi.com/html/search?q=${encodeURIComponent(q)}`;
	const resp = await smartFetch(
		env,
		url,
		{ headers: { Cookie: `kagi_session=${env.KAGI_SESSION}`, "Accept-Language": "en-US,en;q=0.9" } },
		route === "direct" ? "auto" : route,
	);
	if (resp.status >= 400) throw new Error(`Kagi session HTTP ${resp.status} (token expired/rotated?)`);
	return parseKagiSession(await resp.text(), limit);
}

const ENGINES: Record<string, { envKey?: string; envName?: string; run: (env: any, q: string, n: number, route: Route) => Promise<Hit[]> }> = {
	kagi_session: { envKey: "KAGI_SESSION", envName: "KAGI_SESSION", run: kagiSession }, // subscription (free), residential-proxy HTML scrape
	kagi: { envKey: "KAGI_API_KEY", envName: "KAGI_API_KEY", run: kagi }, // metered Search API
	ddg: { run: ddg }, // no key — cheap residential HTML scrape (no JS)
	google: { run: googleDirect }, // no key — heavy: rendered in the mac backend (Google needs JS)
	exa: { envKey: "EXA_API_KEY", envName: "EXA_API_KEY", run: exa }, // 20k req/mo free tier — preferred over brave
	brave: { envKey: "BRAVE_API_KEY", envName: "BRAVE_API_KEY", run: brave }, // metered-only since Feb 2026, no free tier — see comment above
};

/** The default engine: prefer free Kagi-on-the-subscription, then the free keyless DDG,
 * then the metered Kagi API only if that's the only thing configured. Keeps web search
 * FREE by default whenever a free path exists. */
export function defaultEngine(env: any): string {
	if (env?.KAGI_SESSION) return "kagi_session";
	return "ddg";
}

/** Engines usable right now: keyed ones only when their secret is set. */
function available(env: any): string[] {
	return Object.entries(ENGINES)
		.filter(([, spec]) => !spec.envKey || (env as any)[spec.envKey])
		.map(([name]) => name);
}

const normUrl = (u: string): string =>
	u
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/[/?#]+$/, "");

/** Merge hits from several engines: dedupe by URL, rank by how many engines
 * returned each (consensus) then earliest position. */
function merge(lists: Hit[][], limit: number): Hit[] {
	const seen = new Map<string, { hit: Hit; count: number; order: number }>();
	let order = 0;
	for (const list of lists) {
		for (const h of list) {
			if (!h?.url) continue;
			const key = normUrl(h.url);
			const existing = seen.get(key);
			if (existing) {
				existing.count++;
				if (!existing.hit.snippet && h.snippet) existing.hit.snippet = h.snippet;
			} else {
				seen.set(key, { hit: { ...h }, count: 1, order: order++ });
			}
		}
	}
	return [...seen.values()].sort((a, b) => b.count - a.count || a.order - b.order).slice(0, limit).map((v) => v.hit);
}

export const webSearch: Fn = {
	name: "web_search",
	cost: 3,
	description:
		"Web search over Kagi, native Google, Exa, and Brave. `engine`: kagi_session, kagi, ddg, google, exa, brave, or `all` — which fans out across every currently-available engine concurrently (MAP), merges/dedupes by URL with consensus ranking, and with `summarize: true` reduces the pooled results into one Workers-AI synthesis with citations (map-reduce). " +
		"DEFAULT is kagi_session — Kagi run on YOUR subscription (free/unmetered) by scraping the /html/search page with the KAGI_SESSION token through the residential proxy — when that secret is set, else ddg. ddg (DuckDuckGo) is scraped keyless+cheap via the residential proxy (no JS needed) — the free no-key fallback. google renders the real SERP in the headed `render` mac backend (Google needs JS; heavier/slower, opt-in). kagi, exa, and brave are key-gated (KAGI_API_KEY, EXA_API_KEY, BRAVE_API_KEY) and used only when their secret is set; `all` skips unconfigured ones. exa has a genuine 20,000 req/mo free tier and is the preferred key-gated fallback — brave lost its free tier in Feb 2026 and is now metered with no default spend cap, so prefer configuring EXA_API_KEY over BRAVE_API_KEY. Falls back to the plain merged list if AI isn't configured. Returns numbered results (title, url, snippet) — cite by number. " +
			"file_type / include_domains / exclude_domains scope the Kagi engines (kagi, kagi_session) via documented query operators (filetype:, site:, -site:) — neither Kagi surface has a structured param for these on the session path, so both fold into the query text the same way. Other engines ignore them.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Search query." },
			engine: { type: "string", enum: ["kagi_session", "kagi", "ddg", "google", "exa", "brave", "all"], description: "Default: kagi_session (free, on your Kagi subscription) when KAGI_SESSION is set, else ddg (free, keyless)." },
			limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
			summarize: { type: "boolean", description: "Summarize the merged results with Workers AI.", default: false },
			proxy: { type: "boolean", description: "Route the Kagi query through the Tailscale residential proxy (direct fallback if the node is down).", default: false },
			file_type: { type: "string", description: "Kagi engines only (kagi, kagi_session): scope to a file extension, e.g. pdf. Folded into the query as a filetype: operator." },
			include_domains: { type: "array", items: { type: "string" }, description: "Kagi engines only: folded into the query as site: operators." },
			exclude_domains: { type: "array", items: { type: "string" }, description: "Kagi engines only: folded into the query as -site: operators." },
		},
	},
	cacheable: true,
	ttl: 300, // live web search — reflects external state, cache only briefly
	run: async (env, args) => {
		const q = String(args?.query ?? "").trim();
		if (!q) return fail("query is required.");
		const engine = String(args?.engine ?? defaultEngine(env));
		const limit = Math.min(25, Math.max(1, Number(args?.limit) || 10));
		const wantSummary = args?.summarize === true;
		const route: Route = args?.proxy === true ? "proxy" : "auto";
		const scope: SearchScope = { file_type: args?.file_type, include_domains: args?.include_domains, exclude_domains: args?.exclude_domains };
		const hasScope = Boolean(scope.file_type || scope.include_domains?.length || scope.exclude_domains?.length);

		let engines: string[];
		if (engine === "all") {
			engines = available(env);
			if (!engines.length) return fail("No search engine is configured. Set KAGI_API_KEY and/or EXA_API_KEY/BRAVE_API_KEY (google needs no key).");
		} else {
			const spec = ENGINES[engine];
			if (!spec) return fail(`Unknown engine '${engine}'. Options: ${Object.keys(ENGINES).join(", ")}, all.`);
			if (spec.envKey && !(env as any)[spec.envKey]) return fail(`Engine '${engine}' needs the ${spec.envName} secret, which isn't configured. Set the key or use 'all'.`);
			engines = [engine];
		}

		// file_type/include_domains/exclude_domains have no structured param on either Kagi
		// surface (session path is q= only; see withOperators) — fold into the query text for
		// the two Kagi engines only, leave other engines' query untouched.
		const queryFor = (name: string): string => (hasScope && (name === "kagi" || name === "kagi_session") ? withOperators(q, scope) : q);

		// Run the selected engines in parallel; keep whatever succeeds.
		const settled = await Promise.allSettled(engines.map((name) => ENGINES[name].run(env, queryFor(name), limit, route)));
		const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
		const ranAll = engine === "all";
		// Don't swallow engine errors: log every rejection so a silently-dead engine
		// is traceable, and surface the reason for a single named engine (an expired
		// key or a downed backend errors, it doesn't just "return no results").
		const reason = (s: PromiseSettledResult<Hit[]>): string => String(((s as PromiseRejectedResult).reason as Error)?.message ?? (s as PromiseRejectedResult).reason);
		settled.forEach((s, i) => {
			if (s.status === "rejected") console.warn(`web_search engine '${engines[i]}' failed: ${reason(s)}`);
		});
		const hits = ranAll ? merge(lists, limit) : lists[0] ?? [];
		if (!hits.length) {
			if (!ranAll && settled[0]?.status === "rejected") return fail(`Engine '${engine}' failed: ${reason(settled[0])}`);
			return fail(`No results for "${q}"${ranAll ? ` across: ${engines.join(", ")}` : ""}.`);
		}

		const body = fmt(hits);
		const header = ranAll ? `Merged ${hits.length} results from: ${engines.join(", ")}\n\n` : "";

		if (!wantSummary) return ok(header + body);
		if (!hasAI(env)) return ok(`${header}${body}\n\n(summary skipped: Workers AI binding not configured)`);
		try {
			const context = hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet ?? ""}`).join("\n\n");
			const summary = await llm(
				env,
				"Synthesize these web search results into a concise briefing that answers the query. Cite sources inline by their bracket number, e.g. [1]. No preamble.",
				`Query: ${q}\n\nResults:\n${context.slice(0, 12_000)}`,
				512,
			);
			return ok(`${header}${summary}\n\n— Sources —\n${body}`);
		} catch (e) {
			return ok(`${header}${body}\n\n(summary failed: ${String((e as Error).message ?? e)})`);
		}
	},
};
