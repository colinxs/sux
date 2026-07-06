import { type Fn, fail, ok } from "../registry";
import { fetchText } from "./_util";

/** Pull the 11-char video id from a full URL or accept a bare id. */
function extractId(video: string): string | null {
	const v = video.trim();
	if (/^[\w-]{11}$/.test(v)) return v;
	const m =
		v.match(/[?&]v=([\w-]{11})/) ??
		v.match(/youtu\.be\/([\w-]{11})/) ??
		v.match(/\/(?:embed|shorts|v)\/([\w-]{11})/);
	return m ? m[1] : null;
}

/** Minimal HTML/XML entity decode for caption text. */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** Unescape a JSON string literal (e.g. the &-encoded caption baseUrl). */
function unescapeJson(s: string): string {
	try {
		return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
	} catch {
		return s.replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
	}
}

/** Assemble transcript text from a json3 or timedtext-XML caption body. */
function parseCaptions(body: string): string {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		try {
			const data = JSON.parse(trimmed) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
			const parts = (data.events ?? [])
				.flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ""))
				.join("")
				.replace(/\n+/g, " ");
			return parts.replace(/\s+/g, " ").trim();
		} catch {
			// fall through to XML parsing
		}
	}
	const parts = [...trimmed.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((m) => decodeEntities(m[1]));
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

export const youtube: Fn = {
	name: "youtube",
	description:
		"Fetch a YouTube video's title and transcript via the residential proxy. Provide `video` as a full URL (watch, youtu.be, embed, shorts) or a bare 11-char id. Scrapes the watch page for og:title and the first available caption track, then downloads and assembles the transcript. Returns JSON { id, title, transcript }; transcript is best-effort and a clear message is returned when captions are unavailable.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["video"],
		properties: {
			video: { type: "string", description: "YouTube URL or 11-character video id." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const id = extractId(String(args?.video ?? ""));
		if (!id) return fail("Could not parse a YouTube video id from `video`.");

		const pageResp = await fetchText(env, `https://www.youtube.com/watch?v=${id}`);
		// A rate-limited/blocked watch page must fail (uncached) — otherwise
		// "Captions unavailable" gets cached as a success for an hour.
		if (pageResp.status >= 400) return fail(`YouTube watch page returned HTTP ${pageResp.status} — likely rate-limited or blocked; retry later.`);
		const page = pageResp.text;
		const title = page.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1];
		const cleanTitle = title ? decodeEntities(title) : null;

		// The player response embeds a captionTracks array; grab the first baseUrl.
		const tracks = page.match(/"captionTracks":(\[[\s\S]*?\])/);
		let transcript = "Captions unavailable for this video.";
		let transient = false; // caption endpoint hiccup — return it, don't cache it
		if (tracks) {
			const baseUrlRaw = tracks[1].match(/"baseUrl":"([^"]+)"/)?.[1];
			if (baseUrlRaw) {
				const baseUrl = unescapeJson(baseUrlRaw);
				const url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
				try {
					const capResp = await fetchText(env, url);
					if (capResp.status >= 400) {
						transcript = `Caption fetch failed: HTTP ${capResp.status}`;
						transient = true;
					} else {
						const assembled = parseCaptions(capResp.text);
						if (assembled) transcript = assembled;
					}
				} catch (e) {
					transcript = `Caption fetch failed: ${String((e as Error).message ?? e)}`;
					transient = true;
				}
			}
		}

		const result = ok(JSON.stringify({ id, title: cleanTitle, transcript }, null, 2));
		if (transient) result.noCache = true;
		return result;
	},
};
