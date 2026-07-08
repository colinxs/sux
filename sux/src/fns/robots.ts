import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

// Translate a robots.txt path rule to a regex: `*` → `.*`, a trailing `$`
// anchors the end of the path, and every other character is matched literally.
export const pathMatches = (rule: string, path: string): boolean => {
	let pat = rule;
	let anchored = false;
	if (pat.endsWith("$")) {
		anchored = true;
		pat = pat.slice(0, -1);
	}
	const re = pat
		.split("*")
		.map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
};

export type RobotsGroup = { agents: string[]; allow: string[]; disallow: string[]; crawl_delay?: number };

// Parse a robots.txt body into its agent groups and sitemap list. Shared by the
// `robots` fn and any caller (e.g. `crawl`) that needs to honour Disallow rules.
export function parseRobots(txt: string): { groups: RobotsGroup[]; sitemaps: string[] } {
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];
	let cur: RobotsGroup | null = null;
	let lastWasAgent = false;
	for (const line of txt.split(/\r?\n/)) {
		const l = line.replace(/#.*/, "").trim();
		if (!l) continue;
		const [k, ...rest] = l.split(":");
		const key = k.trim().toLowerCase();
		const val = rest.join(":").trim();
		if (key === "user-agent") {
			if (!cur || !lastWasAgent) {
				cur = { agents: [], allow: [], disallow: [] };
				groups.push(cur);
			}
			cur.agents.push(val);
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (key === "sitemap") sitemaps.push(val);
		else if (cur && key === "disallow") cur.disallow.push(val);
		else if (cur && key === "allow") cur.allow.push(val);
		else if (cur && key === "crawl-delay") cur.crawl_delay = Number(val) || undefined;
	}
	return { groups, sitemaps };
}

// Decide whether the `*` user-agent may fetch `path`, per RFC 9309 longest-match
// (Allow wins an equal-length tie). Unknown/unmatched paths default to allowed.
export function isPathAllowed(groups: RobotsGroup[], path: string): boolean {
	const star = groups.find((g) => g.agents.includes("*"));
	const rules = [
		...(star?.disallow ?? []).map((r) => ({ r, allow: false })),
		...(star?.allow ?? []).map((r) => ({ r, allow: true })),
	].filter((x) => x.r);
	let best: { len: number; allow: boolean } | null = null;
	for (const { r, allow } of rules) {
		if (!pathMatches(r, path)) continue;
		if (!best || r.length > best.len || (r.length === best.len && allow)) best = { len: r.length, allow };
	}
	return best ? best.allow : true;
}

export const robots: Fn = {
	name: "robots",
	description: "Fetch and parse a site's robots.txt. Returns agent groups (allow/disallow), crawl-delay, and sitemaps. Pass `path` to test whether the default agent may fetch it.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Any URL on the site (origin is used)." },
			path: { type: "string", description: "Optional path to test against the '*' agent rules." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const raw = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(raw)) return fail("url must be absolute http(s).");
		const origin = new URL(raw).origin;
		const resp = await smartFetch(env, `${origin}/robots.txt`, {});
		if (!resp.ok) {
			const r = ok(JSON.stringify({ origin, status: resp.status, note: "no robots.txt (nothing disallowed)" }));
			// A 4xx (404/403) is a real "no robots" answer worth caching; a 5xx/429 is
			// a transient upstream failure — don't cache it as "no robots" for an hour.
			if (resp.status >= 500 || resp.status === 429) r.noCache = true;
			return r;
		}
		const txt = await resp.text();

		// Per RFC 9309: `*` matches any run of characters, a trailing `$` anchors the
		// end of the path, everything else is literal. Longest matching rule wins; on
		// an equal-length tie the Allow beats the Disallow.
		const { groups, sitemaps } = parseRobots(txt);

		let allowed: boolean | undefined;
		if (args?.path) allowed = isPathAllowed(groups, String(args.path));
		return ok(JSON.stringify({ origin, groups, sitemaps, ...(allowed !== undefined ? { path: args.path, allowed } : {}) }, null, 2));
	},
};
