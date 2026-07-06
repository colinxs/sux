import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

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
		if (!resp.ok) return ok(JSON.stringify({ origin, status: resp.status, note: "no robots.txt (nothing disallowed)" }));
		const txt = await resp.text();

		const groups: Array<{ agents: string[]; allow: string[]; disallow: string[]; crawl_delay?: number }> = [];
		const sitemaps: string[] = [];
		let cur: (typeof groups)[number] | null = null;
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

		let allowed: boolean | undefined;
		if (args?.path) {
			const p = String(args.path);
			const star = groups.find((g) => g.agents.includes("*"));
			const rules = [
				...(star?.disallow ?? []).map((r) => ({ r, allow: false })),
				...(star?.allow ?? []).map((r) => ({ r, allow: true })),
			].filter((x) => x.r);
			let best: { len: number; allow: boolean } | null = null;
			for (const { r, allow } of rules) {
				if (p.startsWith(r) && (!best || r.length > best.len)) best = { len: r.length, allow };
			}
			allowed = best ? best.allow : true;
		}
		return ok(JSON.stringify({ origin, groups, sitemaps, ...(allowed !== undefined ? { path: args.path, allowed } : {}) }, null, 2));
	},
};
