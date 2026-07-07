import { afterEach, describe, expect, it, vi } from "vitest";

import { tmdb } from "./tmdb";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESULTS = {
	results: [
		{
			id: 550,
			media_type: "movie",
			title: "Fight Club",
			overview: "A ticking-time-bomb insomniac.",
			release_date: "1999-10-15",
			vote_average: 8.4,
			poster_path: "/fc.jpg",
		},
		{
			id: 1396,
			media_type: "tv",
			name: "Breaking Bad",
			overview: "A chemistry teacher.",
			first_air_date: "2008-01-20",
			vote_average: 8.9,
			poster_path: null,
		},
	],
};

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("/search/multi")) return json(RESULTS);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls };
}

const keyedEnv = () => ({ TMDB_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("tmdb", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await tmdb.run({} as any, { term: "fight club" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/TMDB_API_KEY/);
	});

	it("normalizes multi-search results across movie and tv media types", async () => {
		const { calls } = installFetch();
		const r = await tmdb.run(keyedEnv(), { term: "fight club", limit: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(2);
		expect(j.results[0]).toMatchObject({
			id: 550,
			type: "movie",
			title: "Fight Club",
			overview: "A ticking-time-bomb insomniac.",
			date: "1999-10-15",
			rating: 8.4,
			poster: "https://image.tmdb.org/t/p/w500/fc.jpg",
			url: "https://www.themoviedb.org/movie/550",
		});
		// tv uses name/first_air_date; null poster → undefined.
		expect(j.results[1]).toMatchObject({ type: "tv", title: "Breaking Bad", date: "2008-01-20", url: "https://www.themoviedb.org/tv/1396" });
		expect(j.results[1].poster).toBeUndefined();
		expect(calls.urls[0]).toContain("query=fight+club");
		expect(calls.urls[0]).toContain("api_key=KEY");
	});

	it("clamps results to the limit", async () => {
		installFetch();
		const r = await tmdb.run(keyedEnv(), { term: "x", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async () => json({ error: "bad" }, 401)) as any;
		const r = await tmdb.run(keyedEnv(), { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 401/);
	});
});
