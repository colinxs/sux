import { type Fn, fail, ok } from "../registry";

export const wayback: Fn = {
	name: "wayback",
	description: "Internet Archive lookups. mode='snapshot' (default): closest capture to `at` (YYYYMMDD or YYYYMMDDhhmmss; default latest) → { available, url, raw_url, timestamp }. mode='history': list captures over time (great for change/price history).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "The original URL to look up." },
			mode: { type: "string", enum: ["snapshot", "history"], default: "snapshot" },
			at: { type: "string", description: "Target timestamp for snapshot mode (YYYYMMDD…)." },
			limit: { type: "integer", default: 50, minimum: 1, maximum: 500, description: "history mode cap." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const url = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(url)) return fail("url must be absolute http(s).");

		if (String(args?.mode ?? "snapshot") === "history") {
			const limit = Number(args?.limit) || 50;
			const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&collapse=digest&limit=${limit}&fl=timestamp,original,statuscode,digest`;
			const resp = await fetch(cdx);
			if (!resp.ok) return fail(`CDX query failed: HTTP ${resp.status}`);
			const rows = (await resp.json()) as string[][];
			if (rows.length <= 1) return ok(`(no captures for ${url})`);
			const [, ...data] = rows;
			const captures = data.map(([timestamp, original, statuscode]) => ({
				timestamp,
				statuscode,
				url: `https://web.archive.org/web/${timestamp}/${original}`,
			}));
			return ok(JSON.stringify({ count: captures.length, captures }, null, 2));
		}

		const at = String(args?.at ?? "");
		const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}${at ? `&timestamp=${encodeURIComponent(at)}` : ""}`;
		const resp = await fetch(api);
		if (!resp.ok) return fail(`Availability query failed: HTTP ${resp.status}`);
		const j = (await resp.json()) as any;
		const snap = j?.archived_snapshots?.closest;
		if (!snap?.available) return ok(JSON.stringify({ available: false, url }));
		return ok(
			JSON.stringify(
				{ available: true, url: snap.url, raw_url: snap.url.replace(/\/web\/(\d+)\//, "/web/$1id_/"), timestamp: snap.timestamp, status: snap.status },
				null,
				2,
			),
		);
	},
};
