import { type Fn, fail, ok } from "../registry";
import { kagiTool } from "../kagi";
import { appendOnSearch } from "./_kb";

const SCOPE_ARGS = ["include_domains", "exclude_domains", "time_relative", "after", "before", "file_type"] as const;

export const search: Fn = {
	name: "search",
	cost: 3,
	description:
		"Web search via Kagi. Returns numbered results with titles, URLs, and snippets — cite by number. workflow: search (default) | news | videos | podcasts | images. Scope with include_domains / exclude_domains / time_relative (day|week|month) / after / before / file_type — OR lens_id (built-in: Academic=2, Forums=1, Programming=15, News360=29, Recipes=120, Small Web=107, PDFs=3, Usenet/Archive=5648; custom: Document Hosts=31362, Code Search=31363, Tech Docs=31364, Artifacts=31365, Wikis/Notes=31366; or any numeric ID from kagi.com/settings/lenses); Kagi's API rejects combining lens_id with any of the other scope args, so pick one or the other. extract_count (0-10) fetches full page content inline as markdown for that many top results. Set proxy: true to route the query through the Tailscale residential proxy (falls back to a direct fetch if the tailnet node is down); default egresses direct.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Concise, keyword-focused query." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
			workflow: { type: "string", enum: ["search", "news", "videos", "podcasts", "images"], default: "search" },
			extract_count: { type: "integer", minimum: 0, maximum: 10, description: "Fetch full page content (as markdown) for this many top results." },
			include_domains: { type: "array", items: { type: "string" } },
			exclude_domains: { type: "array", items: { type: "string" } },
			time_relative: { type: "string", enum: ["day", "week", "month"] },
			after: { type: "string", description: "ISO date, e.g. 2024-01-15." },
			before: { type: "string" },
			file_type: { type: "string", description: "e.g. pdf." },
			lens_id: { type: "string", description: "Numeric lens ID (or a custom lens's numeric ID/shareable URL from kagi.com/settings/lenses). Mutually exclusive with include_domains/exclude_domains/time_relative/file_type." },
			proxy: { type: "boolean", description: "Route the query through the Tailscale residential proxy (direct fallback if the node is down).", default: false },
			remember: { type: "boolean", description: "Save-on-search: fire-and-forget mirror this query + a result snippet into the vault KB (git-versioned). Best-effort and no-op if the vault is unconfigured. Default false.", default: false },
		},
	},
	cacheable: true,
	ttl: 300, // live web search — reflects external state, cache only briefly
	run: async (env, args) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return fail("query is required.");

		const hasScope = SCOPE_ARGS.some((k) => args?.[k] != null);
		if (args?.lens_id != null && hasScope) {
			return fail("lens_id is mutually exclusive with include_domains/exclude_domains/time_relative/file_type — Kagi's API rejects the combination. Use one or the other.");
		}

		const kagiArgs: Record<string, unknown> = {
			query,
			limit: Math.min(50, Math.max(1, Number(args?.limit) || 10)),
			workflow: args?.workflow ?? "search",
		};
		if (args?.extract_count != null) kagiArgs.extract_count = Math.min(10, Math.max(0, Number(args.extract_count)));
		if (args?.lens_id != null) kagiArgs.lens_id = args.lens_id;
		else for (const k of SCOPE_ARGS) if (args?.[k] != null) kagiArgs[k] = args[k];

		const result = await kagiTool(env, "kagi_search_fetch", kagiArgs, args?.proxy === true ? "proxy" : "auto");
		if (!result || result.isError) return fail(`Search failed for "${query}".`);
		const text = result.content?.[0]?.text ?? "";

		// Save-on-search: OFF by default (dormant). Only when the caller opts in AND the
		// search actually returned something do we best-effort mirror it into the vault KB
		// — fire-and-forget, never failing or delaying the search on a vault-write error.
		if (args?.remember === true && text && text !== "(no results)") {
			void appendOnSearch(env, query, text).catch(() => {});
		}
		return ok(text || "(no results)");
	},
};
