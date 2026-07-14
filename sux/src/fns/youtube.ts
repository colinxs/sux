import { type Fn, fail, failWith, ok } from "../registry";
import { errMsg, oj } from "./_util";

// YouTube Data API v3 (googleapis.com) — official, free-quota key rides the
// query string. `search` returns matching videos; an optional `videos` call
// enriches each with view/like counts and duration when possible.

const SEARCH = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS = "https://www.googleapis.com/youtube/v3/videos";


async function api(url: string): Promise<any> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) throw new Error(`YouTube API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function normItem(it: any, stats?: any): Record<string, unknown> {
	const id = it?.id?.videoId ?? "";
	const s = it?.snippet ?? {};
	const out: Record<string, unknown> = {
		id,
		title: s?.title,
		channel: s?.channelTitle,
		published: s?.publishedAt,
		description: s?.description,
		thumbnail: s?.thumbnails?.medium?.url,
		url: `https://youtube.com/watch?v=${id}`,
	};
	if (stats) {
		out.views = stats?.statistics?.viewCount !== undefined ? Number(stats.statistics.viewCount) : undefined;
		out.likes = stats?.statistics?.likeCount !== undefined ? Number(stats.statistics.likeCount) : undefined;
		out.duration = stats?.contentDetails?.duration;
	}
	return out;
}

export const youtube: Fn = {
	name: "youtube",
	description:
		"YouTube Data API v3 (official, free-quota) — video search by `term`, optionally enriched with view/like counts and duration. " +
		"Needs YOUTUBE_API_KEY (free at console.cloud.google.com — enable the YouTube Data API v3). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search text." },
			max_results: { type: "integer", minimum: 1, maximum: 25, default: 10 },
		},
	},
	cacheable: true,
	ttl: 600,
	run: async (env, args) => {
		if (!env.YOUTUBE_API_KEY) return failWith("not_configured", "YouTube API not configured (YOUTUBE_API_KEY). Free key at console.cloud.google.com (enable YouTube Data API v3).");

		const term = String(args?.term ?? "").trim();
		if (!term) return fail("youtube requires a `term`.");
		const max = Math.min(25, Math.max(1, Number(args?.max_results) || 10));
		const key = env.YOUTUBE_API_KEY;

		try {
			const sp = new URLSearchParams({ part: "snippet", q: term, maxResults: String(max), type: "video", key });
			const search = await api(`${SEARCH}?${sp}`);
			const items: any[] = Array.isArray(search?.items) ? search.items : [];

			const ids = items.map((it) => it?.id?.videoId).filter(Boolean);
			let statsById: Record<string, any> = {};
			if (ids.length) {
				try {
					const vp = new URLSearchParams({ part: "statistics,contentDetails", id: ids.join(","), key });
					const vids = await api(`${VIDEOS}?${vp}`);
					for (const v of vids?.items ?? []) if (v?.id) statsById[v.id] = v;
				} catch {
					statsById = {};
				}
			}

			const videos = items.map((it) => normItem(it, statsById[it?.id?.videoId]));
			return ok(oj({ source: "youtube", term, count: videos.length, videos }));
		} catch (e) {
			return fail(`youtube failed: ${errMsg(e)}`);
		}
	},
};
