import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";
import { hasAI, llm } from "../ai";
import { kagiTool } from "../kagi";
import { stripHtml } from "./_util";

export type Hit = { title: string; url: string; snippet?: string };

const fmt = (hits: Hit[]): string =>
	hits.length ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n\n") : "(no results)";

/** DuckDuckGo HTML endpoint — keyless, scraped through the residential proxy. */
async function ddg(env: any, q: string, limit: number): Promise<Hit[]> {
	const resp = await smartFetch(env, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {});
	const html = await resp.text();
	const hits: Hit[] = [];
	const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripHtml(m[1]));
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(html)) && hits.length < limit) {
		let url = m[1];
		const uddg = /[?&]uddg=([^&]+)/.exec(url);
		if (uddg) url = decodeURIComponent(uddg[1]);
		else if (url.startsWith("//")) url = `https:${url}`;
		hits.push({ title: stripHtml(m[2]), url, snippet: snips[i] });
		i++;
	}
	return hits;
}

async function brave(env: any, q: string, limit: number): Promise<Hit[]> {
	const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, {
		headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
	});
	if (!resp.ok) throw new Error(`Brave API HTTP ${resp.status}`);
	const j = (await resp.json()) as any;
	return (j?.web?.results ?? []).slice(0, limit).map((r: any) => ({ title: r.title, url: r.url, snippet: stripHtml(r.description ?? "") }));
}

async function bing(env: any, q: string, limit: number): Promise<Hit[]> {
	const resp = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=${limit}`, {
		headers: { "Ocp-Apim-Subscription-Key": env.BING_API_KEY },
	});
	if (!resp.ok) throw new Error(`Bing API HTTP ${resp.status}`);
	const j = (await resp.json()) as any;
	return (j?.webPages?.value ?? []).slice(0, limit).map((r: any) => ({ title: r.name, url: r.url, snippet: r.snippet }));
}

async function serpapiGoogle(env: any, q: string, limit: number): Promise<Hit[]> {
	const resp = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=${limit}&api_key=${env.SERPAPI_KEY}`);
	if (!resp.ok) throw new Error(`SerpAPI HTTP ${resp.status}`);
	const j = (await resp.json()) as any;
	return (j?.organic_results ?? []).slice(0, limit).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet }));
}

// Kagi (the flagship) — its hosted MCP returns markdown `### [title](url)` blocks.
async function kagi(env: any, q: string, limit: number): Promise<Hit[]> {
	const r = await kagiTool(env, "kagi_search_fetch", { query: q, limit });
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

const ENGINES: Record<string, { envKey?: string; envName?: string; run: (env: any, q: string, n: number) => Promise<Hit[]> }> = {
	kagi: { envKey: "KAGI_API_KEY", envName: "KAGI_API_KEY", run: kagi },
	ddg: { run: ddg },
	brave: { envKey: "BRAVE_API_KEY", envName: "BRAVE_API_KEY", run: brave },
	bing: { envKey: "BING_API_KEY", envName: "BING_API_KEY", run: bing },
	google: { envKey: "SERPAPI_KEY", envName: "SERPAPI_KEY (SerpAPI, engine=google)", run: serpapiGoogle },
};

/** Engines usable right now: ddg always, keyed ones only when their secret is set. */
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
	description:
		"Federated web search. `engine`: kagi, ddg (default, keyless), google (SerpAPI), bing, brave, or `all` — which fans out across every currently-available engine concurrently (MAP), merges/dedupes by URL with consensus ranking, and with `summarize: true` reduces the pooled results into one Workers-AI synthesis with citations (map-reduce). " +
		"Key-gated engines (kagi, google, bing, brave) are used only when their secret is set; `all` silently skips unconfigured ones. Falls back to the plain merged list if AI isn't configured. Returns numbered results (title, url, snippet) — cite by number.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Search query." },
			engine: { type: "string", enum: ["kagi", "ddg", "google", "bing", "brave", "all"], default: "ddg" },
			limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
			summarize: { type: "boolean", description: "Summarize the merged results with Workers AI.", default: false },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const q = String(args?.query ?? "").trim();
		if (!q) return fail("query is required.");
		const engine = String(args?.engine ?? "ddg");
		const limit = Math.min(25, Math.max(1, Number(args?.limit) || 10));
		const wantSummary = args?.summarize === true;

		// Resolve the engine list.
		let engines: string[];
		if (engine === "all") {
			engines = available(env);
		} else {
			const spec = ENGINES[engine];
			if (!spec) return fail(`Unknown engine '${engine}'. Options: ${Object.keys(ENGINES).join(", ")}, all.`);
			if (spec.envKey && !(env as any)[spec.envKey]) return fail(`Engine '${engine}' needs the ${spec.envName} secret, which isn't configured. Use 'ddg' or 'all' (keyless), or set the key.`);
			engines = [engine];
		}

		// Run the selected engines in parallel; keep whatever succeeds.
		const settled = await Promise.allSettled(engines.map((name) => ENGINES[name].run(env, q, limit)));
		const lists = settled.map((s) => (s.status === "fulfilled" ? s.value : []));
		const ranAll = engine === "all";
		const hits = ranAll ? merge(lists, limit) : lists[0] ?? [];
		if (!hits.length) return fail(`No results for "${q}"${ranAll ? ` across: ${engines.join(", ")}` : ""}.`);

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
