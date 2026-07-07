import { type Fn, fail, ok } from "../registry";

// The Movie DB (api.themoviedb.org) — official, free key rides the query
// string. `search/multi` matches movies, TV shows, and people by `term`.

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

async function api(url: string): Promise<any> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) throw new Error(`TMDb API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function normResult(d: any): Record<string, unknown> {
	const type = d?.media_type;
	const poster = d?.poster_path;
	return {
		id: d?.id,
		type,
		title: d?.title ?? d?.name,
		overview: d?.overview,
		date: d?.release_date ?? d?.first_air_date,
		rating: d?.vote_average,
		poster: poster ? `${IMG}${poster}` : undefined,
		url: type && d?.id !== undefined ? `https://www.themoviedb.org/${type}/${d.id}` : undefined,
	};
}

export const tmdb: Fn = {
	name: "tmdb",
	description:
		"The Movie DB (official, free) — multi-search across movies, TV shows, and people by `term`. " +
		"Needs TMDB_API_KEY (free at themoviedb.org/settings/api). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search text." },
			limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (env, args) => {
		if (!env.TMDB_API_KEY) return fail("TMDb API not configured (TMDB_API_KEY). Free key at themoviedb.org/settings/api.");

		const term = String(args?.term ?? "").trim();
		if (!term) return fail("tmdb requires a `term`.");
		const limit = Math.min(20, Math.max(1, Number(args?.limit) || 10));
		const key = env.TMDB_API_KEY;

		try {
			const sp = new URLSearchParams({ query: term, api_key: key, page: "1" });
			const j = await api(`${API}/search/multi?${sp}`);
			const results = (Array.isArray(j?.results) ? j.results : []).slice(0, limit).map(normResult);
			return ok(JSON.stringify({ source: "tmdb", term, count: results.length, results }, null, 2));
		} catch (e) {
			return fail(`tmdb failed: ${errMsg(e)}`);
		}
	},
};
