import { type Fn, fail, ok } from "../registry";
import { kagiTool } from "../kagi";

const SCOPE_ARGS = ["include_domains", "exclude_domains", "time_relative", "after", "before", "file_type", "lens_id"] as const;

export const search: Fn = {
	name: "search",
	description:
		"Web search via Kagi (routed through the residential proxy, direct fallback — same smartFetch path as scrape). Returns numbered results with titles, URLs, and snippets — cite by number. workflow: search (default) | news | videos | podcasts | images. Scope with include_domains / exclude_domains / time_relative (day|week|month) / after / before / file_type / lens_id (Academic=2, Forums=1, Programming=15, News360=29, Recipes=120, Small Web=107).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Concise, keyword-focused query." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
			workflow: { type: "string", enum: ["search", "news", "videos", "podcasts", "images"], default: "search" },
			include_domains: { type: "array", items: { type: "string" } },
			exclude_domains: { type: "array", items: { type: "string" } },
			time_relative: { type: "string", enum: ["day", "week", "month"] },
			after: { type: "string", description: "ISO date, e.g. 2024-01-15." },
			before: { type: "string" },
			file_type: { type: "string", description: "e.g. pdf." },
			lens_id: { type: "string" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return fail("query is required.");

		const kagiArgs: Record<string, unknown> = {
			query,
			limit: Number(args?.limit) || 10,
			workflow: args?.workflow ?? "search",
		};
		for (const k of SCOPE_ARGS) if (args?.[k] != null) kagiArgs[k] = args[k];

		const result = await kagiTool(env, "kagi_search_fetch", kagiArgs);
		if (!result || result.isError) return fail(`Search failed for "${query}".`);
		const text = result.content?.[0]?.text ?? "";
		return ok(text || "(no results)");
	},
};
